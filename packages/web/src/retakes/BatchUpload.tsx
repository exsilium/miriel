/**
 * /retakes/batch: many photos at once (files, a whole folder, or drag and drop). Each photo becomes a job in one
 * batch; the worker matches it to a page (file name, else the folio) and checks it. Unmatched or conflicting
 * photos get a page number by hand. One confirm runs every checked photo as a single retake: one PDF write,
 * one extraction run, one ingest.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate, retakePagePath } from "../route.js";
import { useAppState } from "../state.js";
import { confirmBatch, discardJob, fetchBatch, setJobPage, uploadPhoto, type Job } from "./client.js";
import { useRetakes } from "./context.js";
import { Quality, TokenField, usd } from "./parts.js";

const POLL_MS = 2000;
const UPLOAD_CONCURRENCY = 2;
const PHOTO = /\.(jpe?g|png)$/i;

const MATCH_LABEL: Record<string, string> = { filename: "file name", folio: "folio + photo", photo: "photo similarity", "--page": "set by hand" };

function batchFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("batch");
}

export function BatchUpload({ book: initialBook }: { book: string | null }) {
  const { books, refreshBooks } = useAppState();
  const { config, refresh: refreshCounts } = useRetakes();
  const [bookId, setBookId] = useState(initialBook && books.some((b) => b.id === initialBook) ? initialBook : books[0]!.id);
  const [batch, setBatch] = useState<string | null>(batchFromUrl);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploading, setUploading] = useState<{ done: number; total: number; failed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pageInput, setPageInput] = useState<Record<string, string>>({});
  const book = books.find((b) => b.id === bookId)!;

  // the batch id is passed explicitly by addFiles: its closure predates the setBatch of a new batch
  const load = useCallback(async (id: string | null = batch) => {
    if (!id) return;
    try {
      setJobs((await fetchBatch(id)).sort((a, b) => (a.uploadName ?? "").localeCompare(b.uploadName ?? "", undefined, { numeric: true })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [batch]);

  const live = jobs.filter((j) => j.status !== "discarded");
  const pending = live.some((j) => ["uploaded", "confirmed", "running"].includes(j.status));
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!batch || (!pending && !uploading)) return;
    const t = setInterval(() => void load(), POLL_MS);
    // (load follows `batch`; a new batch re-creates this interval)
    return () => clearInterval(t);
  }, [batch, pending, uploading, load]);

  // When the whole batch has run, the viewer should see the new PDF revision at once.
  const finished = live.length > 0 && live.every((j) => j.status === "done" || j.status === "rejected");
  const announced = useRef(false);
  useEffect(() => {
    if (finished && live.some((j) => j.status === "done") && !announced.current) {
      announced.current = true;
      void refreshBooks();
      refreshCounts();
    }
  }, [finished, live, refreshBooks, refreshCounts]);

  const addFiles = async (list: FileList | File[] | null): Promise<void> => {
    const files = [...(list ?? [])].filter((f) => PHOTO.test(f.name));
    if (!files.length) {
      setError("No JPEG or PNG files among those.");
      return;
    }
    setError(null);
    const id = batch ?? crypto.randomUUID().replaceAll("-", "");
    if (!batch) {
      setBatch(id);
      const url = new URL(window.location.href);
      url.searchParams.set("book", bookId);
      url.searchParams.set("batch", id);
      window.history.replaceState(null, "", url);
    }
    const state = { done: 0, total: files.length, failed: [] as string[] };
    setUploading({ ...state });
    const queue = [...files];
    const worker = async (): Promise<void> => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          if (config && f.size > config.maxUploadBytes) throw new Error("larger than " + Math.round(config.maxUploadBytes / 1048576) + " MB");
          await uploadPhoto(bookId, f, { batch: id });
          void load(id);
        } catch (e) {
          state.failed.push(f.name + ": " + (e instanceof Error ? e.message : String(e)));
        }
        state.done += 1;
        setUploading({ ...state, failed: [...state.failed] });
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    setUploading(state.failed.length ? { ...state } : null);
    refreshCounts();
    await load(id);
  };

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const validated = live.filter((j) => j.status === "validated");
  const estimate = validated.reduce((s, j) => s + (j.estimateUsd ?? 0), 0);
  const conflicts = useMemo(() => {
    const seen = new Map<number, number>();
    for (const j of live) if (j.page !== null && j.status === "validated") seen.set(j.page, (seen.get(j.page) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([p]) => p));
  }, [live]);

  return (
    <div className="retakes batch">
      <div className="retakes-head">
        <button onClick={() => navigate("/retakes")}>‹ Queue</button>
        <h2>Batch upload</h2>
        <span className="spacer" />
        {batch && (
          <button
            onClick={() => {
              setBatch(null);
              setJobs([]);
              setUploading(null);
              announced.current = false;
              window.history.replaceState(null, "", "/retakes/batch?book=" + encodeURIComponent(bookId));
            }}
          >
            New batch
          </button>
        )}
      </div>
      <TokenField required={Boolean(config?.tokenRequired)} />
      <div className="filters">
        <select value={bookId} onChange={(e) => setBookId(e.target.value)} disabled={Boolean(batch)} aria-label="Book">
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      </div>

      <div
        className={"dropzone" + (dragging ? " dragging" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <p>Drop vFlat photos here, or</p>
        <div className="actions">
          <label className="button primary">
            Choose photos
            <input type="file" accept="image/jpeg,image/png" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          </label>
          <label className="button">
            Choose a folder
            <input type="file" hidden onChange={(e) => void addFiles(e.target.files)} {...({ webkitdirectory: "" } as Record<string, string>)} />
          </label>
        </div>
        <p className="muted">
          The page comes from the file name (the book&apos;s own image names or page_NNN.jpg, where NNN is the image number = printed page +{" "}
          {book.printedToPdfOffset}), else from the printed folio.
        </p>
      </div>

      {uploading && (
        <div className={uploading.failed.length ? "error-box" : "muted"}>
          Uploaded {uploading.done} of {uploading.total}
          {uploading.failed.map((f) => (
            <div key={f}>✕ {f}</div>
          ))}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      {live.length > 0 && (
        <>
          <table className="batch-table">
            <thead>
              <tr>
                <th>Photo</th>
                <th>Page</th>
                <th>Matched by</th>
                <th>Check</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {live.map((j) => {
                const fc = j.folioCheck;
                const needsPage = j.status === "rejected" || (j.page !== null && conflicts.has(j.page));
                return (
                  <tr key={j.id} className={"row-" + j.status}>
                    <td data-label="Photo">{j.uploadName}</td>
                    <td data-label="Page">
                      {j.page !== null ? (
                        <a
                          href={retakePagePath(j.book, j.page)}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(retakePagePath(j.book, j.page!));
                          }}
                        >
                          p. {j.page}
                        </a>
                      ) : (
                        "–"
                      )}
                      {conflicts.has(j.page ?? NaN) && <div className="error-text">also in another photo</div>}
                    </td>
                    <td data-label="Matched by">{fc && j.page !== null ? MATCH_LABEL[fc.match] ?? fc.match : j.status === "uploaded" ? "…" : "–"}</td>
                    <td data-label="Check">
                      {fc?.folio && !fc.warnings.includes(fc.folio) && !fc.errors.includes(fc.folio) && <div>{fc.folio}</div>}
                      {fc?.errors.map((e) => (
                        <div key={e} className="error-text">
                          ✕ {e}
                        </div>
                      ))}
                      {!fc && j.error && <div className="error-text">✕ {j.error}</div>}
                      {fc?.warnings.map((w) => (
                        <div key={w} className="warn-text">
                          ! {w}
                        </div>
                      ))}
                    </td>
                    <td data-label="Status">
                      <strong>{j.status}</strong>
                      {j.stage && j.status === "running" ? <span className="muted"> · {j.stage}</span> : null}
                      {j.status === "validated" && <div className="muted">~{usd(j.estimateUsd)}</div>}
                      {j.status === "done" && (
                        <div>
                          <Quality q={j.after} /> <span className="muted">{usd(j.costUsd)}</span>
                        </div>
                      )}
                      {(j.status === "confirmed" || j.status === "failed") && <div className="muted">{j.message}</div>}
                    </td>
                    <td data-label="">
                      {needsPage && (
                        <form
                          className="set-page"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const n = Number(pageInput[j.id]);
                            if (Number.isInteger(n)) void act(() => setJobPage(j.id, n));
                          }}
                        >
                          <input
                            inputMode="numeric"
                            placeholder="page"
                            value={pageInput[j.id] ?? ""}
                            onChange={(e) => setPageInput((p) => ({ ...p, [j.id]: e.target.value }))}
                            aria-label={"Printed page for " + j.uploadName}
                          />
                          <button type="submit">Set</button>
                        </form>
                      )}
                      {["uploaded", "validated", "rejected"].includes(j.status) && (
                        <button onClick={() => void act(() => discardJob(j.id))} aria-label={"Discard " + j.uploadName}>
                          Discard
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(validated.length > 0 || live.some((j) => j.status === "uploaded")) && (
            <div className="batch-confirm">
              <span>
                {validated.length} photo{validated.length === 1 ? "" : "s"} ready · re-extraction ~<strong>{usd(estimate)}</strong>
                {live.some((j) => j.status === "uploaded") && <span className="muted"> · still checking {live.filter((j) => j.status === "uploaded").length}</span>}
              </span>
              <button
                className="primary"
                disabled={validated.length === 0 || conflicts.size > 0 || live.some((j) => j.status === "uploaded")}
                onClick={() => void act(() => confirmBatch(batch!))}
                title={conflicts.size ? "Two photos claim the same page: set or discard one" : undefined}
              >
                Accept and process {validated.length} page{validated.length === 1 ? "" : "s"}
              </button>
            </div>
          )}
          {finished && live.some((j) => j.status === "done") && <div className="card result">Batch finished. Pages still flagged stay in the queue.</div>}
        </>
      )}
    </div>
  );
}
