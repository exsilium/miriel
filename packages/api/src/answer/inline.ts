/**
 * Inline citation parser for CITATIONS_MODE=inline. The model writes markers
 * such as `[Vol 1, p. 214]` or `[Vol 1, p. 214: "exact words"]`; this turns a
 * stream of text deltas into the same text/citation events the citations API
 * path produces. Pure; feed deltas with push(), finish with flush().
 */
import type { AnswerEvent, Citation } from "./types.js";

export const INLINE_MARKER_RE = /\[([^\[\]:"|]+?),\s*p(?:\.|age)?\s*(\d{1,4})(?:\s*[:|]\s*[“"]([^"”\]]*)[”"])?\s*\]/g;

/** How far back an unclosed "[" may sit before we stop waiting for its "]". */
const MAX_PENDING = 400;

export class InlineCitationParser {
  private buffer = "";
  readonly citations: Citation[] = [];

  /** @param resolveBook maps a book label as written in a marker ("Vol 1") to a book id, or undefined. */
  constructor(private readonly resolveBook: (label: string) => string | undefined) {}

  push(delta: string): AnswerEvent[] {
    this.buffer += delta;
    const events: AnswerEvent[] = [];

    let consumed = 0;
    INLINE_MARKER_RE.lastIndex = 0;
    for (let m = INLINE_MARKER_RE.exec(this.buffer); m; m = INLINE_MARKER_RE.exec(this.buffer)) {
      const before = this.buffer.slice(consumed, m.index);
      const citation = this.toCitation(m[1]!, m[2]!, m[3]);
      if (citation) {
        if (before) events.push({ type: "text", text: before });
        events.push({ type: "citation", citation });
        this.citations.push(citation);
      } else {
        // unknown book label: leave the marker in the text as the model wrote it
        events.push({ type: "text", text: before + m[0] });
      }
      consumed = m.index + m[0].length;
    }

    const rest = this.buffer.slice(consumed);
    // Hold back from the last unclosed "[" so a marker split across deltas is not emitted as text.
    const open = rest.lastIndexOf("[");
    const holdFrom = open >= 0 && !rest.slice(open).includes("]") && rest.length - open <= MAX_PENDING ? open : rest.length;
    const emit = rest.slice(0, holdFrom);
    if (emit) events.push({ type: "text", text: emit });
    this.buffer = rest.slice(holdFrom);
    return events;
  }

  flush(): AnswerEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? [{ type: "text", text: rest }] : [];
  }

  private toCitation(label: string, page: string, quote: string | undefined): Citation | null {
    const book = this.resolveBook(label.trim());
    if (!book) return null;
    return {
      book,
      page: Number(page),
      quote: quote?.trim() || null,
      chunk_idx: null,
      heading_path: null,
      title: null,
      documentIndex: null,
    };
  }
}

/** Build the label -> book id resolver from the books' labels; matching ignores case and spacing. */
export function labelResolver(labels: Record<string, string>): (label: string) => string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[\s.]+/g, "");
  const map = new Map<string, string>();
  for (const [book, label] of Object.entries(labels)) {
    map.set(norm(label), book);
    map.set(norm(book), book);
  }
  return (label) => map.get(norm(label));
}
