/**
 * answer(query, retrieval): AsyncIterable<AnswerEvent>
 *
 * Streams text deltas and citation events. Default mode uses the Anthropic
 * citations feature (document blocks with citations enabled; citations arrive
 * as citations_delta and are mapped back through each document's JSON
 * context). CITATIONS_MODE=inline instead instructs the model to write
 * `[Vol 1, p. 214]` markers, which are parsed into identical events. If the
 * citations request fails before any text was produced, the call falls back
 * to inline mode once.
 *
 * Every call logs one JSON line (model, tokens, latency, citations).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { RetrievalResult } from "../retrieval/types.js";
import { buildDocuments, type AnswerDocument } from "./documents.js";
import { InlineCitationParser, labelResolver } from "./inline.js";
import type { AnswerEvent, AnswerStats, Citation, CitationsMode, HistoryMessage } from "./types.js";

export * from "./types.js";
export { buildDocuments, documentTitle } from "./documents.js";
export { InlineCitationParser, INLINE_MARKER_RE, labelResolver } from "./inline.js";

export const DEFAULT_ANSWER_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 4096;

export interface AnswerDeps {
  client: Anthropic;
  /** book id -> short label used in document titles and inline markers ("vol1" -> "Vol 1"). */
  labels: Record<string, string>;
  /** One JSON-serialisable record per call; default writes a line to stdout. */
  log?: ((record: Record<string, unknown>) => void) | undefined;
  /** Directory holding answer*.md; default: packages/api/prompts. */
  promptsDir?: string | undefined;
}

export interface AnswerInput {
  query: string;
  retrieval: RetrievalResult;
  /** Earlier turns, oldest first; the caller decides how many to send. */
  history?: HistoryMessage[] | undefined;
  mode?: CitationsMode | undefined;
  model?: string | undefined;
  maxTokens?: number | undefined;
  /** Optional output_config.effort; unset means the model default. */
  effort?: string | undefined;
  /** Cap on documents sent (default: all retrieved). */
  maxDocuments?: number | undefined;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_DIR = path.resolve(here, "..", "..", "prompts");

const promptCache = new Map<string, string>();
function readPrompt(dir: string, name: string): string {
  const file = path.join(dir, name);
  let text = promptCache.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8").trim();
    promptCache.set(file, text);
  }
  return text;
}

export function systemPrompt(mode: CitationsMode, promptsDir = DEFAULT_PROMPTS_DIR): string {
  return readPrompt(promptsDir, "answer.md") + "\n\n" + readPrompt(promptsDir, mode === "inline" ? "answer-inline.md" : "answer-citations.md");
}

export function resolveMode(explicit?: CitationsMode): CitationsMode {
  if (explicit) return explicit;
  return (process.env["CITATIONS_MODE"] ?? "").toLowerCase() === "inline" ? "inline" : "citations";
}

export async function* answer(deps: AnswerDeps, input: AnswerInput): AsyncIterable<AnswerEvent> {
  const mode = resolveMode(input.mode);
  const documents = buildDocuments(input.retrieval, deps.labels, { maxDocuments: input.maxDocuments });

  let producedText = false;
  const first = run(deps, input, documents, mode, false);
  try {
    for await (const ev of first) {
      if (ev.type === "text" && ev.text) producedText = true;
      yield ev;
    }
    return;
  } catch (err) {
    if (mode === "citations" && !producedText && err instanceof Anthropic.APIError) {
      // Citations unavailable or rejected: same question, inline markers instead.
      yield* run(deps, input, documents, "inline", true);
      return;
    }
    throw err;
  }
}

async function* run(
  deps: AnswerDeps,
  input: AnswerInput,
  documents: AnswerDocument[],
  mode: CitationsMode,
  fellBack: boolean,
): AsyncGenerator<AnswerEvent> {
  const model = input.model ?? process.env["ANSWER_MODEL"] ?? DEFAULT_ANSWER_MODEL;
  const maxTokens = input.maxTokens ?? Number(process.env["ANSWER_MAX_TOKENS"] ?? DEFAULT_MAX_TOKENS);
  const effort = input.effort ?? process.env["ANSWER_EFFORT"] ?? undefined;
  const log = deps.log ?? ((r): void => void process.stdout.write(JSON.stringify(r) + "\n"));
  const t0 = performance.now();

  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: systemPrompt(mode, deps.promptsDir), cache_control: { type: "ephemeral" } },
  ];
  const messages: Anthropic.Messages.MessageParam[] = [
    ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent(input.query, documents, mode) },
  ];

  const params: Anthropic.Messages.MessageStreamParams = { model, max_tokens: maxTokens, system, messages };
  if (effort) params.output_config = { effort: effort as NonNullable<Anthropic.Messages.OutputConfig["effort"]> };

  const inline = mode === "inline" ? new InlineCitationParser(labelResolver(deps.labels)) : null;
  let citations = 0;
  let firstTokenMs: number | null = null;
  let stopReason: string | null = null;
  let errorMessage: string | null = null;
  let usage: Anthropic.Messages.Usage | undefined;

  // The API sends a text block's citations_delta before that block's text.
  // Hold them until the block closes so, like inline markers, a citation
  // always follows the text it supports.
  let pendingCitations: Citation[] = [];

  const stream = deps.client.messages.stream(params);
  let completed = false;
  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          firstTokenMs ??= Math.round(performance.now() - t0);
          if (inline) {
            for (const ev of inline.push(event.delta.text)) {
              if (ev.type === "citation") citations++;
              yield ev;
            }
          } else {
            yield { type: "text", text: event.delta.text };
          }
        } else if (event.delta.type === "citations_delta") {
          const citation = mapCitation(event.delta.citation, documents);
          if (citation) pendingCitations.push(citation);
        }
      } else if (event.type === "content_block_stop") {
        for (const citation of pendingCitations) {
          citations++;
          yield { type: "citation", citation };
        }
        pendingCitations = [];
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason ?? stopReason;
      }
    }
    for (const citation of pendingCitations) {
      citations++;
      yield { type: "citation", citation };
    }
    if (inline) for (const ev of inline.flush()) yield ev;
    const final = await stream.finalMessage();
    completed = true;
    usage = final.usage;
    stopReason = final.stop_reason ?? stopReason;
    if (final.stop_reason === "refusal") {
      errorMessage = "The model declined to answer this request.";
      yield { type: "error", message: errorMessage };
    } else if (final.stop_reason === "max_tokens") {
      yield { type: "error", message: "The answer was cut off at " + maxTokens + " tokens." };
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (firstTokenMs !== null) yield { type: "error", message: errorMessage };
    logCall();
    throw err;
  } finally {
    // The consumer stopped early (client disconnected): stop paying for tokens.
    if (!completed) {
      stream.abort();
      if (!errorMessage) {
        errorMessage = "aborted by consumer";
        logCall();
      }
    }
  }

  const stats: AnswerStats = {
    model,
    mode,
    fellBack,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
    latencyMs: Math.round(performance.now() - t0),
    firstTokenMs,
    citations,
    documents: documents.length,
    stopReason,
  };
  logCall(stats);
  yield { type: "done", stats };

  function logCall(s?: AnswerStats): void {
    log({
      ts: new Date().toISOString(),
      event: "answer",
      model,
      mode,
      fell_back: fellBack,
      input_tokens: s?.inputTokens ?? usage?.input_tokens ?? null,
      output_tokens: s?.outputTokens ?? usage?.output_tokens ?? null,
      cache_read_input_tokens: s?.cacheReadTokens ?? null,
      cache_creation_input_tokens: s?.cacheCreationTokens ?? null,
      latency_ms: Math.round(performance.now() - t0),
      first_token_ms: firstTokenMs,
      citations,
      documents: documents.length,
      stop_reason: stopReason,
      error: errorMessage,
    });
  }
}

function userContent(query: string, documents: AnswerDocument[], mode: CitationsMode): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = documents.map((d) => {
    const block: Anthropic.Messages.DocumentBlockParam = {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: d.text },
      title: d.title,
      context: JSON.stringify(d.context),
      citations: { enabled: mode === "citations" },
    };
    return block;
  });
  const intro = documents.length
    ? "Answer from the " + documents.length + " document(s) above."
    : "No documents matched this question in the indexed pages.";
  blocks.push({ type: "text", text: intro + "\n\nQuestion: " + query });
  return blocks;
}

function mapCitation(raw: Anthropic.Messages.TextCitation, documents: AnswerDocument[]): Citation | null {
  if (raw.type !== "char_location") return null;
  const doc = documents[raw.document_index];
  if (!doc) return null;
  return {
    book: doc.context.book,
    page: doc.context.page,
    quote: raw.cited_text.trim() || null,
    chunk_idx: doc.context.chunk_idx,
    heading_path: doc.context.heading_path,
    title: doc.title,
    documentIndex: raw.document_index,
  };
}
