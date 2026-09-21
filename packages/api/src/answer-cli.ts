#!/usr/bin/env node
/**
 * Answer harness:  npm run answer -- "Where is the Giant Rat Ashes?"
 * Options: --inline  --rerank  --book vol1  --model <id>  --k 12  --events  --history "u: ...|a: ..."
 * Streams the answer to stdout with citation pills, then lists the citations
 * with their quotes. The per-call JSON log line goes to stderr.
 */
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { createEmbeddingProvider, createRerankProvider, envFlag, loadDotEnv } from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { answer, type AnswerEvent, type Citation, type HistoryMessage } from "./answer/index.js";
import { loadBookLabels } from "./books.js";
import { retrieve } from "./retrieval/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    book: { type: "string", multiple: true },
    inline: { type: "boolean", default: false },
    rerank: { type: "boolean", default: false },
    events: { type: "boolean", default: false },
    model: { type: "string" },
    k: { type: "string" },
    history: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const query = positionals.join(" ").trim();
if (values.help || !query) {
  process.stderr.write('usage: answer [--inline] [--rerank] [--book vol1] [--model id] [--k 12] [--events] [--history "u: ...|a: ..."] "<question>"\n');
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const pool = createPool();
const rerank = values.rerank || envFlag("RERANK_ENABLED", false);
const err = (s: string): void => void process.stderr.write(s);
try {
  const labels = await loadBookLabels(pool);
  const retrieval = await retrieve(
    { pool, embedder: createEmbeddingProvider(), reranker: rerank ? createRerankProvider() : undefined },
    query,
    { bookIds: values.book, rerank, topK: values.k ? Number(values.k) : undefined },
  );
  err(
    "retrieval: " + retrieval.chunks.length + " chunks, " + retrieval.pages.length + " pages, anchors " +
      retrieval.anchors.entities.map((e) => e.name).join(", ") + (retrieval.routeQuestion ? " [route]" : "") + "\n\n",
  );

  const history: HistoryMessage[] | undefined = values.history
    ? values.history.split("|").map((part) => {
        const m = /^\s*([ua]):\s*(.*)$/s.exec(part);
        if (!m) throw new Error("bad --history segment: " + part);
        return { role: m[1] === "u" ? "user" : "assistant", content: m[2]! };
      })
    : undefined;

  const client = new Anthropic();
  const cited: Citation[] = [];
  const events = answer(
    { client, labels, log: (r) => err("\n" + JSON.stringify(r) + "\n") },
    { query, retrieval, history, mode: values.inline ? "inline" : undefined, model: values.model },
  );
  for await (const ev of events) {
    if (values.events) {
      process.stdout.write(JSON.stringify(ev) + "\n");
      continue;
    }
    render(ev, labels, cited);
  }
} finally {
  await pool.end();
}

function render(ev: AnswerEvent, labels: Record<string, string>, cited: Citation[]): void {
  switch (ev.type) {
    case "text":
      process.stdout.write(ev.text);
      break;
    case "citation": {
      cited.push(ev.citation);
      process.stdout.write(" [" + (labels[ev.citation.book] ?? ev.citation.book) + " · p. " + ev.citation.page + "]");
      break;
    }
    case "error":
      process.stdout.write("\n\n[error] " + ev.message + "\n");
      break;
    case "done": {
      const s = ev.stats;
      process.stdout.write("\n\n" + "─".repeat(72) + "\ncitations (" + cited.length + "):\n");
      cited.forEach((c, i) => {
        const where = (labels[c.book] ?? c.book) + " p. " + c.page + (c.chunk_idx !== null ? " #" + c.chunk_idx : "") + (c.heading_path ? "  " + c.heading_path : "");
        process.stdout.write("  " + (i + 1) + ". " + where + "\n");
        if (c.quote) process.stdout.write('     "' + c.quote.replace(/\s+/g, " ").slice(0, 200) + (c.quote.length > 200 ? "…" : "") + '"\n');
      });
      process.stdout.write(
        "\n" + s.model + "  mode=" + s.mode + (s.fellBack ? " (fell back)" : "") + "  in=" + s.inputTokens + " out=" + s.outputTokens +
          " cache_read=" + s.cacheReadTokens + "  first_token=" + s.firstTokenMs + "ms  total=" + s.latencyMs + "ms  docs=" + s.documents + "\n",
      );
      break;
    }
  }
}
