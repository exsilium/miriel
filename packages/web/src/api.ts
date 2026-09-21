/**
 * API client: typed shapes mirroring packages/api responses, fetch helpers,
 * and an SSE reader for POST /api/chat.
 */
export interface Book {
  id: string;
  title: string;
  label: string;
  pageCount: number;
  printedToPdfOffset: number;
}

export interface PageRef {
  book: string;
  page: number;
}

export interface ResolvedEntity {
  name: string;
  nameNorm: string;
  types: string[];
  pages: PageRef[];
  match: "exact" | "trigram" | "prior";
  similarity: number;
  matchedText: string;
  isLocation: boolean;
}

export interface Citation {
  book: string;
  page: number;
  quote: string | null;
  chunk_idx: number | null;
  heading_path: string | null;
  title: string | null;
  documentIndex: number | null;
}

export interface AnchorsEvent {
  type: "anchors";
  entities: ResolvedEntity[];
  pages: PageRef[];
  ownPages: PageRef[];
  routeQuestion: boolean;
  consulted: PageRef[];
}

export interface AnswerStats {
  model: string;
  mode: string;
  fellBack: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  citations: number;
  documents: number;
}

export type ChatEvent =
  | AnchorsEvent
  | { type: "text"; text: string }
  | { type: "citation"; citation: Citation }
  | { type: "done"; stats: AnswerStats }
  | { type: "error"; message: string };

export interface TypeaheadHit {
  name: string;
  nameNorm: string;
  types: string[];
  book: string;
  pages: number[];
  score: number;
}

export interface ChatRequest {
  messages: { role: "user" | "assistant"; content: string }[];
  bookIds?: string[];
  priorEntities?: string[];
}

export const pdfUrl = (book: string): string => "/api/books/" + encodeURIComponent(book) + "/pdf";
export const pageImageUrl = (book: string, page: number): string =>
  "/api/books/" + encodeURIComponent(book) + "/pages/" + page + "/image";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal: signal ?? null });
  if (!res.ok) throw new Error(await problemMessage(res));
  return (await res.json()) as T;
}

async function problemMessage(res: Response): Promise<string> {
  try {
    const p = (await res.json()) as { title?: string; detail?: string };
    return (p.title ?? "Request failed") + (p.detail ? ": " + p.detail : "") + " (" + res.status + ")";
  } catch {
    return "Request failed (" + res.status + ")";
  }
}

export const fetchBooks = (): Promise<Book[]> => getJson<Book[]>("/api/books");

export function fetchEntities(q: string, book: string | undefined, signal: AbortSignal): Promise<TypeaheadHit[]> {
  const params = new URLSearchParams({ q });
  if (book) params.set("book", book);
  return getJson<TypeaheadHit[]>("/api/entities?" + params.toString(), signal);
}

/** POST /api/chat and yield parsed SSE events until the stream ends. */
export async function* streamChat(body: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await problemMessage(res));
  if (!res.body) throw new Error("The server returned no stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseSseBlock(block);
      if (ev) yield ev;
      sep = buffer.indexOf("\n\n");
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) yield tail;
}

export function parseSseBlock(block: string): ChatEvent | null {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as ChatEvent;
  } catch {
    return null;
  }
}
