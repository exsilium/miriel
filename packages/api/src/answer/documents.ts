/**
 * Turn a RetrievalResult into the documents handed to the model. Pure.
 *
 * Full pages (route context) come first; chunks follow, except chunks whose
 * page is already present in full. Each document carries a human title the
 * model can quote and a JSON `context` we map citations back through.
 */
import type { RetrievalResult } from "../retrieval/types.js";

export interface DocumentContext {
  book: string;
  page: number;
  chunk_idx: number | null;
  heading_path: string | null;
}

export interface AnswerDocument {
  title: string;
  context: DocumentContext;
  text: string;
  kind: "page" | "chunk";
}

/** Anthropic limits document titles; keep them short but informative. */
const MAX_TITLE = 120;

export function documentTitle(label: string, page: number, section: string | null): string {
  const base = label + " — p. " + page;
  if (!section) return base;
  const room = MAX_TITLE - base.length - 3;
  const s = section.length > room ? section.slice(0, Math.max(room - 1, 0)).trimEnd() + "…" : section;
  return base + " — " + s;
}

export function buildDocuments(
  retrieval: RetrievalResult,
  labels: Record<string, string>,
  opts: { maxDocuments?: number | undefined } = {},
): AnswerDocument[] {
  const labelOf = (book: string): string => labels[book] ?? book;
  const docs: AnswerDocument[] = [];
  const fullPages = new Set<string>();

  for (const p of retrieval.pages) {
    fullPages.add(p.book + ":" + p.page);
    docs.push({
      kind: "page",
      title: documentTitle(labelOf(p.book), p.page, p.region ?? p.chapter ?? "full page"),
      context: { book: p.book, page: p.page, chunk_idx: null, heading_path: null },
      text: p.markdown,
    });
  }
  for (const c of retrieval.chunks) {
    if (fullPages.has(c.book + ":" + c.page)) continue;
    docs.push({
      kind: "chunk",
      title: documentTitle(labelOf(c.book), c.page, c.heading_path),
      context: { book: c.book, page: c.page, chunk_idx: c.chunk_idx, heading_path: c.heading_path },
      text: c.text,
    });
  }
  return opts.maxDocuments ? docs.slice(0, opts.maxDocuments) : docs;
}
