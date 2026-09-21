import { useMemo, useState, type ReactNode } from "react";
import { pageImageUrl, type Citation } from "../api.js";
import { pillToken, renderMarkdown } from "../markdown.js";
import { useAppState } from "../state.js";
import type { AssistantMsg, UserMsg } from "./ChatPane.js";

type Jump = (book: string, page: number, quote?: string | null) => void;

export function UserMessage({ message }: { message: UserMsg }) {
  return <div className="msg user">{message.content}</div>;
}

export function AssistantMessage({ message, onJump, onRetry }: { message: AssistantMsg; onJump: Jump; onRetry: (m: AssistantMsg) => void }) {
  const { books } = useAppState();
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

      {anchors && anchors.consulted.length > 0 && message.status !== "streaming" && (
        <div className="strip">
          <span style={{ color: "var(--fg-muted)" }}>Pages consulted</span>
          <div className="thumbs">
            {anchors.consulted.map((p) => (
              <button key={p.book + ":" + p.page} className="thumb" title={labelOf(p.book) + " · p. " + p.page} onClick={() => onJump(p.book, p.page)}>
                <img src={pageImageUrl(p.book, p.page)} alt={"Page " + p.page} loading="lazy" decoding="async" />
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
