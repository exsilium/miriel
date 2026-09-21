export type CitationsMode = "citations" | "inline";

export interface Citation {
  book: string;
  page: number;
  /** Exact source text the model cited (citations mode) or quoted (inline mode), else null. */
  quote: string | null;
  /** Chunk the citation came from, null for full-page documents or inline markers without a document. */
  chunk_idx: number | null;
  heading_path: string | null;
  /** Document title as shown to the model, e.g. "Vol 1 — p. 159 — Altus Plateau > 27 Dominula". */
  title: string | null;
  /** Index into the documents sent with the request, null for inline markers. */
  documentIndex: number | null;
}

export interface AnswerStats {
  model: string;
  mode: CitationsMode;
  /** True when the request fell back from citations to inline mode. */
  fellBack: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  latencyMs: number;
  firstTokenMs: number | null;
  citations: number;
  documents: number;
  stopReason: string | null;
}

export type AnswerEvent =
  | { type: "text"; text: string }
  | { type: "citation"; citation: Citation }
  | { type: "done"; stats: AnswerStats }
  | { type: "error"; message: string };

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}
