import { useMemo, useState, type ReactNode } from "react";
import { artCropUrl, pageLabel, pageThumbUrl, type ArtItem, type Book, type Citation } from "../api.js";
import { pillToken, renderMarkdown } from "../markdown.js";
import { useAppState } from "../state.js";
import { useImageVersions } from "../versions.js";
import type { AssistantMsg, UserMsg } from "./ChatPane.js";

type Jump = (book: string, page: number, quote?: string | null, box?: [number, number, number, number]) => void;

export function UserMessage({ message }: { message: UserMsg }) {
  return <div className="msg user">{message.content}</div>;
}

export function AssistantMessage({ message, onJump, onRetry }: { message: AssistantMsg; onJump: Jump; onRetry: (m: AssistantMsg) => void }) {
  const { books } = useAppState();
  useImageVersions(); // thumbnail URLs carry the page's photo version
  const labelOf = (book: string): string => books.find((b) => b.id === book)?.label ?? book;

  // Text with a sentinel per citation, so pills render exactly where the event arrived.
  const { source, citations } = useMemo(() => {
    const citations: Citation[] = [];
    let source = "";
    for (const s of message.segments) {
      if (s.kind === "text") source += s.text;
      else {
        source += pillToken(citations.length);
        citations.push(s.citation);
      }
    }
    return { source, citations };
  }, [message.segments]);

  const body = useMemo(
    () =>
      renderMarkdown(source, (i) => {
        const c = citations[i];
        return c ? <CitationPill key={i} citation={c} label={labelOf(c.book)} onJump={onJump} /> : null;
      }),
    // labelOf depends only on books, which is stable for the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, citations, onJump, books],
  );

  const streaming = message.status === "streaming";
  const anchors = message.anchors;
  const [anchorsOpen, setAnchorsOpen] = useState(true);

  return (
    <div className={"msg assistant" + (message.status === "error" ? " error" : "")}>
      {anchors && anchors.entities.length > 0 && (
        <details className="strip" open={anchorsOpen} onToggle={(e) => setAnchorsOpen(e.currentTarget.open)}>
          <summary>
            Understood as{anchors.routeQuestion ? " (route question)" : ""}: {anchors.entities.length} {anchors.entities.length === 1 ? "entity" : "entities"}
          </summary>
          <div className="chips">
            {anchors.entities.map((e) => {
              const first = e.pages[0];
              return (
                <button
                  key={e.nameNorm}
                  className={"chip" + (e.match === "prior" ? " prior" : "")}
                  title={(e.match === "prior" ? "From the previous question. " : e.match === "trigram" ? "Fuzzy match. " : "") + "Pages " + e.pages.map((p) => p.page).join(", ")}
                  onClick={() => first && onJump(first.book, first.page)}
                >
                  {e.name}
                  <span className="chip-type">{e.types.join("/")}</span>
                </button>
              );
            })}
          </div>
        </details>
      )}

      <div className={"answer" + (streaming ? " cursor" : "")}>
        {body.length === 0 && streaming && <p style={{ color: "var(--fg-muted)" }}>Thinking…</p>}
        {body}
      </div>

      {message.error && (
        <div className="error-box" role="alert">
          <span>{message.error}</span>
          {message.status === "error" && <button onClick={() => onRetry(message)}>Retry</button>}
        </div>
      )}

      {message.art.length > 0 && <ArtStrip items={message.art} books={books} onJump={onJump} />}

      {anchors && anchors.consulted.length > 0 && message.status !== "streaming" && (
        <div className="strip">
          <span style={{ color: "var(--fg-muted)" }}>Pages consulted</span>
          <div className="thumbs">
            {anchors.consulted.map((p) => (
              <button key={p.book + ":" + p.page} className="thumb" title={labelOf(p.book) + " · p. " + p.page} onClick={() => onJump(p.book, p.page)}>
                <img src={pageThumbUrl(p.book, p.page)} alt={"Page " + p.page} loading="lazy" decoding="async" />
                <span>p. {p.page}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {message.stats && (
        <div className="msg-footer">
          {message.stats.model} · {message.stats.citations} citation{message.stats.citations === 1 ? "" : "s"} from {message.stats.documents} passage
          {message.stats.documents === 1 ? "" : "s"} · {(message.stats.latencyMs / 1000).toFixed(1)}s
          {message.stats.fellBack ? " · fell back to inline citations" : ""}
        </div>
      )}
    </div>
  );
}

/**
 * Artworks from the art books for the question's subjects: crop, name, book and pages. A click opens the spread in
 * the viewer with the artwork outlined. Names identified from the picture (not from a printed caption) are marked.
 */
export function ArtStrip({ items, books, onJump }: { items: ArtItem[]; books: Book[]; onJump: Jump }): ReactNode {
  return (
    <div className="strip art-strip">
      <span style={{ color: "var(--fg-muted)" }}>Art</span>
      <div className="thumbs">
        {items.map((it) => {
          const book = books.find((b) => b.id === it.book);
          const where = (book?.label ?? it.book) + " · " + (book ? pageLabel(book, it.pdfPage) : "PDF page " + it.pdfPage);
          const name = it.name ?? it.description.split(/[.;]/)[0]!;
          const guessed = it.source === "visual";
          const title =
            name + " — " + where + "\n" + it.description +
            (it.captionJa ? "\nCaption: " + it.captionJa : "") +
            (guessed ? "\nIdentified from the picture (no caption names it)." : it.source === "search" ? "\nFound by its description." : "");
          return (
            <button key={it.id} className="thumb art" title={title} onClick={() => onJump(it.book, it.pdfPage, null, it.bbox)}>
              <img src={artCropUrl(it.id, it.imageVersion, 240)} alt={name} loading="lazy" decoding="async" />
              <span className="art-name">
                {name}
                {guessed && <em className="art-guess" aria-label="identified from the picture"> ?</em>}
              </span>
              <span>{where}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CitationPill({ citation, label, onJump }: { citation: Citation; label: string; onJump: Jump }): ReactNode {
  const text = label + " · p. " + citation.page;
  return (
    <span className="pill-wrap">
      <button className="pill" onClick={() => onJump(citation.book, citation.page, citation.quote)} aria-label={"Open " + text}>
        {text}
      </button>
      {citation.quote && <span className="pill-quote">“{citation.quote}”</span>}
    </span>
  );
}
