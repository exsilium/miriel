/**
 * /retakes/<book>/<page>: one page's retake. Current photo and what the extraction flagged; upload a new photo
 * (file picker, or the camera on a phone); compare old and new with the folio check and the cost estimate;
 * accept or discard; follow the stages; see the before/after result; history of versions with rollback.
 * A user who is not an admin submits the checked photo for approval; an admin approves or declines it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pageImageUrl } from "../api.js";
import { navigate, readerPath } from "../route.js";
import { useAppState } from "../state.js";
import { useImageVersions } from "../versions.js";
import {
  acceptPage,
  canApprove,
  canUpload,
  confirmJob,
  declineJob,
  discardJob,
  fetchHistory,
  OPEN_STATUSES,
  retryJob,
  rollbackPage,
  submitJob,
  uploadPhoto,
  uploadUrl,
  type Job,
  type PageHistory,
} from "./client.js";
import { useRetakes } from "./context.js";
import { AccessNote, BeforeAfter, JobProgress, Quality, usd, useJobStream } from "./parts.js";

interface PageQuality {
  image_quality?: string;
  quality_issues?: string[];
  retake_recommended?: boolean;
  retake_reason?: string | null;
  affected_areas?: string | null;
  ocr_agreement?: string;
}

export function PageRetake({ book: bookId, page }: { book: string; page: number }) {
  const { books, refreshBooks, goTo } = useAppState();
  const { config, refresh: refreshCounts } = useRetakes();
  useImageVersions();
  const book = books.find((b) => b.id === bookId);
  const [quality, setQuality] = useState<PageQuality | null>(null);
  const [history, setHistory] = useState<PageHistory | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastDone, setLastDone] = useState<Job | null>(null);

  const loadHistory = useCallback(async () => {
    const h = await fetchHistory(bookId, page);
    setHistory(h);
    return h;
  }, [bookId, page]);

  useEffect(() => {
    setQuality(null);
    setJobId(null);
    setLastDone(null);
    setError(null);
    fetch("/api/books/" + encodeURIComponent(bookId) + "/pages/" + page)
      .then((r) => (r.ok ? (r.json() as Promise<{ quality: PageQuality }>) : null))
      .then((p) => setQuality(p?.quality ?? null))
      .catch(() => setQuality(null));
    loadHistory()
      .then((h) => {
        const open = h.jobs.find((j) => (j.kind === "retake" || j.kind === "rollback") && OPEN_STATUSES.includes(j.status));
        if (open) setJobId(open.id);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [bookId, page, loadHistory]);

  // The retake is finished: pick up the new PDF revision and photo versions right away (no need to wait for the poll).
  const settledFor = useRef<string | null>(null);
  const onJob = useCallback(
    (j: Job) => {
      if ((j.status === "done" || j.status === "rolled_back") && settledFor.current !== j.id) {
        settledFor.current = j.id;
        setLastDone(j);
        void refreshBooks();
        void loadHistory();
        refreshCounts();
        fetch("/api/books/" + encodeURIComponent(bookId) + "/pages/" + page)
          .then((r) => (r.ok ? (r.json() as Promise<{ quality: PageQuality }>) : null))
          .then((p) => p && setQuality(p.quality))
          .catch(() => undefined);
      }
    },
    [bookId, page, refreshBooks, loadHistory, refreshCounts],
  );
  const [streamKey, setStreamKey] = useState(0);
  const { job, events } = useJobStream(jobId, onJob, streamKey);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    if (config && file.size > config.maxUploadBytes) {
      setError(file.name + " is larger than " + Math.round(config.maxUploadBytes / 1048576) + " MB.");
      return;
    }
    void act(async () => {
      if (active?.status === "rejected" || active?.status === "declined") await discardJob(active.id);
      const j = await uploadPhoto(bookId, file, { page });
      setLastDone(null);
      setJobId(j.id);
      refreshCounts();
    });
  };

  const accepted = useMemo(() => history?.jobs.find((j) => j.kind === "accept")?.status === "done", [history]);
  const active = job && OPEN_STATUSES.includes(job.status) ? job : null;
  const mayWrite = canUpload(config);
  const approver = canApprove(config);
  const mine = Boolean(active?.uploadedBy?.id) && active?.uploadedBy?.id === config?.viewer?.userId;
  const showUpload = mayWrite && (!active || active.status === "rejected" || active.status === "declined");

  // a submitted photo waits for an admin elsewhere: look again now and then
  const waiting = active?.status === "submitted";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setStreamKey((k) => k + 1), 15_000);
    return () => clearInterval(t);
  }, [waiting]);

  const decline = (id: string) => {
    const note = window.prompt("Why is the photo declined? (optional, shown to the uploader)", "");
    if (note === null) return;
    void act(async () => {
      await declineJob(id, note);
      setStreamKey((k) => k + 1);
      refreshCounts();
    });
  };

  if (!book) return <div className="retakes muted">Unknown book {bookId}.</div>;
  const maxPrinted = book.pageCount - book.printedToPdfOffset;

  return (
    <div className="retakes page-retake">
      <div className="retakes-head">
        <button onClick={() => navigate("/retakes")}>‹ Queue</button>
        <h2>
          {book.label} · p. {page}
        </h2>
        <span className="spacer" />
        <button onClick={() => navigate("/retakes/" + encodeURIComponent(bookId) + "/" + Math.max(page - 1, 1 - book.printedToPdfOffset))} disabled={page <= 1 - book.printedToPdfOffset} aria-label="Previous page">
          ‹
        </button>
        <button onClick={() => navigate("/retakes/" + encodeURIComponent(bookId) + "/" + Math.min(page + 1, maxPrinted))} disabled={page >= maxPrinted} aria-label="Next page">
          ›
        </button>
        <button
          onClick={() => {
            navigate(readerPath(bookId, page));
            goTo(bookId, page);
          }}
        >
          Open in viewer
        </button>
      </div>
      <AccessNote />
      {error && <div className="error-box">{error}</div>}

      <div className="retake-grid">
        <figure className="photo">
          <figcaption>Current photo</figcaption>
          <img src={pageImageUrl(bookId, page)} alt={"Current photo of page " + page} />
        </figure>

        {active && active.kind === "retake" && active.uploadName && ["uploaded", "validated", "submitted", "rejected", "declined"].includes(active.status) && (
          <figure className="photo">
            <figcaption>New photo · {active.uploadName}</figcaption>
            <img src={uploadUrl(active.id)} alt="Uploaded photo" />
          </figure>
        )}

        <div className="retake-side">
          <section className="card">
            <h3>What the extraction flagged</h3>
            {quality ? (
              <>
                <p>
                  <Quality q={quality} />
                  {accepted && <span className="badge badge-accepted"> Accepted</span>}
                </p>
                {quality.quality_issues && quality.quality_issues.length > 0 && <p className="muted">Issues: {quality.quality_issues.join(", ").replaceAll("_", " ")}</p>}
                {quality.retake_reason && <p>{quality.retake_reason}</p>}
                {quality.affected_areas && <p className="muted">Affected areas: {quality.affected_areas}</p>}
                {(quality.retake_recommended || accepted) && !active && approver && (
                  <button disabled={busy} onClick={() => void act(async () => { await acceptPage(bookId, page, !accepted); await loadHistory(); refreshCounts(); })}>
                    {accepted ? "Undo accept" : "Mark accepted (no retake needed)"}
                  </button>
                )}
              </>
            ) : (
              <p className="muted">This page has not been indexed.</p>
            )}
          </section>

          {lastDone && !active && (
            <section className="card result">
              <h3>{lastDone.kind === "rollback" ? "Rolled back" : "Retake done"}</h3>
              {lastDone.kind === "retake" && <BeforeAfter before={lastDone.before} after={lastDone.after} />}
              {lastDone.costUsd !== null && <p className="muted">Cost {usd(lastDone.costUsd)}</p>}
              {lastDone.after?.retake_recommended && <p className="warn-text">The new photo is still flagged for a retake; the page stays in the queue.</p>}
              <button
                className="primary"
                onClick={() => {
                  navigate(readerPath(bookId, page));
                  goTo(bookId, page);
                }}
              >
                Open the page in the viewer
              </button>
            </section>
          )}

          {active && (
            <section className="card">
              {active.kind === "rollback" ? <h3>Rollback</h3> : <h3>New photo</h3>}
              {active.uploadedBy?.username && (
                <p className="muted">
                  Uploaded by {active.uploadedBy.username}
                  {mine ? " (you)" : ""}
                  {active.submittedAt ? " · submitted " + new Date(active.submittedAt).toLocaleString() : ""}
                </p>
              )}
              {active.status === "uploaded" && <p className="muted">Checking the photo (folio, aspect)…</p>}
              {["validated", "submitted", "rejected", "declined"].includes(active.status) && active.folioCheck && (
                <>
                  <p>
                    Folio:{" "}
                    {active.folioCheck.folio && !active.folioCheck.warnings.includes(active.folioCheck.folio) && !active.folioCheck.errors.includes(active.folioCheck.folio)
                      ? active.folioCheck.folio
                      : "see below"}
                    {active.folioCheck.size && <span className="muted"> · {active.folioCheck.size[0]}×{active.folioCheck.size[1]} px</span>}
                  </p>
                  {active.folioCheck.errors.map((e) => (
                    <p key={e} className="error-text">
                      ✕ {e}
                    </p>
                  ))}
                  {active.folioCheck.warnings.map((w) => (
                    <p key={w} className="warn-text">
                      ! {w}
                    </p>
                  ))}
                  {active.folioCheck.notes.map((n) => (
                    <p key={n} className="muted">
                      {n}
                    </p>
                  ))}
                </>
              )}
              {active.status === "rejected" && !active.folioCheck && <p className="error-text">✕ {active.error}</p>}
              {active.status === "validated" && (
                <>
                  <p>
                    Re-extraction estimate: <strong>{usd(active.estimateUsd)}</strong>
                  </p>
                  {approver ? (
                    <div className="actions">
                      <button className="primary" disabled={busy} onClick={() => void act(async () => { await confirmJob(active.id); setStreamKey((k) => k + 1); })}>
                        Accept and process
                      </button>
                      <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                        Discard
                      </button>
                    </div>
                  ) : mine ? (
                    <div className="actions">
                      <button className="primary" disabled={busy} onClick={() => void act(async () => { await submitJob(active.id); setStreamKey((k) => k + 1); refreshCounts(); })}>
                        Submit for approval
                      </button>
                      <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                        Discard
                      </button>
                    </div>
                  ) : (
                    <p className="muted">Waiting for {active.uploadedBy?.username ?? "the uploader"} to submit it.</p>
                  )}
                </>
              )}
              {active.status === "submitted" && (
                <>
                  <p>
                    Re-extraction estimate: <strong>{usd(active.estimateUsd)}</strong>
                  </p>
                  {approver ? (
                    <div className="actions">
                      <button className="primary" disabled={busy} onClick={() => void act(async () => { await confirmJob(active.id); setStreamKey((k) => k + 1); refreshCounts(); })}>
                        Approve and process
                      </button>
                      <button disabled={busy} onClick={() => decline(active.id)}>
                        Decline
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="warn-text">Waiting for an admin's approval.</p>
                      {mine && (
                        <div className="actions">
                          <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                            Withdraw
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {active.status === "declined" && (
                <>
                  <p className="error-text">
                    ✕ Declined{active.decidedBy?.username ? " by " + active.decidedBy.username : ""}
                    {active.decisionNote ? ": " + active.decisionNote : ""}
                  </p>
                  {(mine || approver) && (
                    <div className="actions">
                      <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                        Discard
                      </button>
                    </div>
                  )}
                </>
              )}
              {active.status === "rejected" && (mine || approver) && (
                <div className="actions">
                  <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                    Discard
                  </button>
                </div>
              )}
              {(active.status === "confirmed" || active.status === "running" || active.status === "failed") && <JobProgress job={job} events={events} />}
              {active.status === "failed" && approver && (
                <>
                  <p className="error-text">✕ {active.error}</p>
                  <div className="actions">
                    <button className="primary" disabled={busy} onClick={() => void act(async () => { await retryJob(active.id); setStreamKey((k) => k + 1); })}>
                      Retry
                    </button>
                    {!active.pdfCommitted && (
                      <button disabled={busy} onClick={() => void act(async () => { await discardJob(active.id); setJobId(null); refreshCounts(); })}>
                        Discard
                      </button>
                    )}
                  </div>
                  {active.pdfCommitted && <p className="muted">The book PDF was already replaced, so this retake can only be finished (Retry) and then rolled back.</p>}
                </>
              )}
            </section>
          )}

          {showUpload && (
            <section className="card">
              <h3>{active?.status === "rejected" || active?.status === "declined" ? "Try another photo" : "Upload a new photo"}</h3>
              <p className="muted">
                JPEG or PNG from vFlat. The photo is checked before anything is changed; re-extraction starts only after{" "}
                {approver ? "you accept" : "an admin approves it"}.
              </p>
              <div className="actions">
                <label className="button primary">
                  Choose photo
                  <input type="file" accept="image/jpeg,image/png" hidden disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
                </label>
                <label className="button">
                  Use camera
                  <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
                </label>
              </div>
            </section>
          )}

          <section className="card">
            <h3>History</h3>
            {!history || history.versions.length === 0 ? (
              <p className="muted">No retakes of this page yet.</p>
            ) : (
              <ul className="history">
                {history.versions.map((v) => (
                  <li key={v.at + v.txn}>
                    <span>{new Date(v.at).toLocaleString()}</span> · <strong>{v.action === "rollback" ? "rolled back to v" + v.restored : "retake"}</strong> · {v.source}
                    <span className="muted"> · previous photo kept as v{v.keptAs}</span>
                    {v.after && (
                      <div className="muted">
                        Result: <Quality q={v.after} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {history?.canRollBack && !active && approver && (
              <button
                disabled={busy}
                onClick={() => {
                  if (!window.confirm("Roll back the latest retake of page " + page + "? The previous photo, PDF page and extraction come back; no model call.")) return;
                  void act(async () => {
                    const j = await rollbackPage(bookId, page);
                    setLastDone(null);
                    setJobId(j.id);
                  });
                }}
              >
                Roll back the latest retake
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
