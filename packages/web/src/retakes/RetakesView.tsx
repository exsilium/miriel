/**
 * /retakes: the retake queue. Pages flagged retake_recommended plus every page with retake activity, per book,
 * with filters (book, issue, status), page order and optional grouping by quality issue.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { pageThumbUrl } from "../api.js";
import { navigate, retakePagePath } from "../route.js";
import { useAppState } from "../state.js";
import { rememberVersions, useImageVersions } from "../versions.js";
import { acceptPage, fetchQueue, type QueueItem, type QueueStatus } from "./client.js";
import { useRetakes } from "./context.js";
import { QUEUE_LABEL, StatusBadge, TokenField } from "./parts.js";

type StatusFilter = "open" | "all" | QueueStatus;
const STATUS_FILTERS: [StatusFilter, string][] = [
  ["open", "Needs a photo"],
  ["all", "All"],
  ["flagged", QUEUE_LABEL.flagged],
  ["in_progress", QUEUE_LABEL.in_progress],
  ["still_flagged", QUEUE_LABEL.still_flagged],
  ["done", QUEUE_LABEL.done],
  ["accepted", QUEUE_LABEL.accepted],
];

export function RetakesView() {
  const { books } = useAppState();
  const { config, refresh } = useRetakes();
  useImageVersions();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [book, setBook] = useState<string>(() => (books.length === 1 ? books[0]!.id : "all"));
  const [issue, setIssue] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [descending, setDescending] = useState(false);
  const [group, setGroup] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchQueue()
      .then((rows) => {
        rememberVersions(Object.fromEntries(rows.filter((r) => r.imageVersion).map((r) => [r.book + ":" + r.page, r.imageVersion!])));
        setItems(rows);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const labelOf = (id: string): string => books.find((b) => b.id === id)?.label ?? id;
  const issues = useMemo(() => [...new Set((items ?? []).flatMap((i) => i.qualityIssues))].sort(), [items]);
  const shown = useMemo(() => {
    const rows = (items ?? []).filter(
      (i) =>
        (book === "all" || i.book === book) &&
        (issue === "all" || i.qualityIssues.includes(issue)) &&
        (status === "all" || (status === "open" ? i.status === "flagged" || i.status === "still_flagged" || i.status === "in_progress" : i.status === status)),
    );
    rows.sort((a, b) => a.book.localeCompare(b.book) || (descending ? b.page - a.page : a.page - b.page));
    return rows;
  }, [items, book, issue, status, descending]);

  const sections = useMemo<[string, QueueItem[]][]>(() => {
    if (!group) return [["", shown]];
    const by = new Map<string, QueueItem[]>();
    for (const i of shown) for (const q of i.qualityIssues.length ? i.qualityIssues : ["(no issue listed)"]) by.set(q, [...(by.get(q) ?? []), i]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [shown, group]);

  const toggleAccept = async (item: QueueItem, accepted: boolean): Promise<void> => {
    setBusy(item.book + ":" + item.page);
    try {
      await acceptPage(item.book, item.page, accepted);
      load();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadList = (): void => {
    const open = (items ?? []).filter((i) => (book === "all" || i.book === book) && (i.status === "flagged" || i.status === "still_flagged"));
    const lines = ["# pages to re-shoot (printed page numbers), " + new Date().toISOString().slice(0, 10)];
    for (const b of [...new Set(open.map((i) => i.book))]) {
      lines.push("", "# " + labelOf(b) + " (" + b + ")");
      for (const i of open.filter((x) => x.book === b)) lines.push(String(i.page) + "  # " + (i.qualityIssues.join(", ") || "-"));
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (book === "all" ? "all-books" : book) + "-retakes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="retakes">
      <div className="retakes-head">
        <h2>Retake queue</h2>
        <span className="spacer" />
        <button onClick={downloadList} disabled={!items}>
          Download list
        </button>
        <button className="primary" onClick={() => navigate("/retakes/batch" + (book !== "all" ? "?book=" + encodeURIComponent(book) : ""))}>
          Batch upload
        </button>
      </div>
      <TokenField required={Boolean(config?.tokenRequired)} />
      <div className="filters">
        {books.length > 1 && (
          <select value={book} onChange={(e) => setBook(e.target.value)} aria-label="Book">
            <option value="all">All books</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          {STATUS_FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={issue} onChange={(e) => setIssue(e.target.value)} aria-label="Quality issue">
          <option value="all">Any issue</option>
          {issues.map((q) => (
            <option key={q} value={q}>
              {q.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button onClick={() => setDescending((d) => !d)} aria-label="Sort by page">
          Page {descending ? "↓" : "↑"}
        </button>
        <label className="check">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group by issue
        </label>
        <span className="muted">{items ? shown.length + " page" + (shown.length === 1 ? "" : "s") : ""}</span>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!items && !error && <div className="muted">Loading…</div>}
      {items && shown.length === 0 && <div className="muted">Nothing here with these filters.</div>}
      {sections.map(([title, rows]) => (
        <section key={title || "all"}>
          {title && (
            <h3 className="group-title">
              {title.replaceAll("_", " ")} <span className="muted">({rows.length})</span>
            </h3>
          )}
          <ul className="queue">
            {rows.map((i) => (
              <li key={title + i.book + ":" + i.page} className="queue-row">
                <button className="queue-thumb" onClick={() => navigate(retakePagePath(i.book, i.page))} aria-label={"Open page " + i.page}>
                  <img src={pageThumbUrl(i.book, i.page)} alt="" loading="lazy" decoding="async" />
                </button>
                <div className="queue-body">
                  <div className="queue-title">
                    <a
                      href={retakePagePath(i.book, i.page)}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(retakePagePath(i.book, i.page));
                      }}
                    >
                      {labelOf(i.book)} · p. {i.page}
                    </a>
                    <StatusBadge status={i.status} />
                    <span className="muted">{i.imageQuality}</span>
                    {i.qualityIssues.length > 0 && <span className="muted">· {i.qualityIssues.join(", ").replaceAll("_", " ")}</span>}
                  </div>
                  {i.retakeReason && <div className="queue-reason">{i.retakeReason}</div>}
                  {i.affectedAreas && <div className="muted queue-areas">Affected: {i.affectedAreas}</div>}
                  {i.job && i.status === "in_progress" && <div className="muted">Job: {i.job.status} · {i.job.message}</div>}
                </div>
                <div className="queue-actions">
                  <button onClick={() => navigate(retakePagePath(i.book, i.page))}>Retake</button>
                  {i.status === "accepted" ? (
                    <button disabled={busy === i.book + ":" + i.page} onClick={() => void toggleAccept(i, false)}>
                      Undo accept
                    </button>
                  ) : i.status === "flagged" || i.status === "still_flagged" ? (
                    <button disabled={busy === i.book + ":" + i.page} onClick={() => void toggleAccept(i, true)} title="The page is fine as it is: clear it from the queue without a retake">
                      Mark accepted
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
