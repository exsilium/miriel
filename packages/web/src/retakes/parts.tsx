/** Small building blocks shared by the retake views. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/context.js";
import { canApprove, canUpload, getToken, setToken, watchJob, type Job, type JobEvent, type QualitySummary, type QueueStatus } from "./client.js";
import { useRetakes } from "./context.js";

export const QUEUE_LABEL: Record<QueueStatus, string> = {
  flagged: "Flagged",
  in_progress: "In progress",
  done: "Done",
  still_flagged: "Still flagged",
  accepted: "Accepted",
};

export function StatusBadge({ status }: { status: QueueStatus }) {
  return <span className={"badge badge-" + status}>{QUEUE_LABEL[status]}</span>;
}

export const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : "$" + n.toFixed(n < 1 ? 3 : 2));

export function Quality({ q }: { q: QualitySummary | null | undefined }) {
  if (!q) return <span className="muted">–</span>;
  return (
    <span>
      {q.image_quality ?? "?"}
      {q.retake_recommended ? <span className="warn-text"> · retake recommended</span> : <span className="ok-text"> · ok</span>}
      {q.ocr_agreement ? <span className="muted"> · OCR {q.ocr_agreement}</span> : null}
    </span>
  );
}

export function BeforeAfter({ before, after }: { before: QualitySummary | null; after: QualitySummary | null }) {
  const row = (label: string, a: ReactNode, b: ReactNode) => (
    <tr>
      <th>{label}</th>
      <td>{a ?? "–"}</td>
      <td>{b ?? "–"}</td>
    </tr>
  );
  return (
    <table className="before-after">
      <thead>
        <tr>
          <th />
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {row("Image quality", before?.image_quality, after?.image_quality)}
        {row("Retake recommended", yesNo(before?.retake_recommended), yesNo(after?.retake_recommended))}
        {row("OCR agreement", before?.ocr_agreement, after?.ocr_agreement)}
        {row("Entities", before?.entities, after?.entities)}
        {row("Markdown chars", before?.markdown_chars?.toLocaleString(), after?.markdown_chars?.toLocaleString())}
      </tbody>
    </table>
  );
}

const yesNo = (v: boolean | undefined): string | undefined => (v === undefined ? undefined : v ? "yes" : "no");

/**
 * Who may change retakes, above each retake view: with accounts a "Log in" prompt for visitors and a note for users
 * whose photos go to an admin; without accounts the token field (when the server sets RETAKE_TOKEN).
 */
export function AccessNote() {
  const { config } = useRetakes();
  const { user, showLogin } = useAuth();
  if (!config) return null;
  if (!config.accounts) return <TokenField required={config.tokenRequired} />;
  if (!canUpload(config)) {
    return (
      <div className="card access-note">
        <span>Log in to upload new photos. Anyone with an account can send photos; an admin approves the re-extraction.</span>
        {!user && (
          <button className="primary" onClick={showLogin}>
            Log in
          </button>
        )}
      </div>
    );
  }
  if (!canApprove(config)) {
    return <p className="muted access-note">Your photos are checked right away; an admin approves the re-extraction (it costs model credit).</p>;
  }
  return null;
}

/** Shown when the server requires RETAKE_TOKEN; the value stays in this browser. */
export function TokenField({ required }: { required: boolean }) {
  const [value, setValue] = useState(getToken());
  const [saved, setSaved] = useState(Boolean(getToken()));
  if (!required) return null;
  return (
    <form
      className="token-field"
      onSubmit={(e) => {
        e.preventDefault();
        setToken(value.trim());
        setSaved(Boolean(value.trim()));
      }}
    >
      <label>
        Retake token{" "}
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" placeholder="RETAKE_TOKEN" />
      </label>
      <button type="submit">{saved ? "Update" : "Save"}</button>
      {!saved && <span className="warn-text">Uploads and confirms need the token.</span>}
    </form>
  );
}

export const RETAKE_STAGES: [string, string][] = [
  ["validate", "Check the photo (folio, aspect)"],
  ["stage", "Stage the photo"],
  ["build", "Build the PDF page (OCR)"],
  ["splice", "Splice into the book PDF and verify"],
  ["commit_pdf", "Replace the PDF (old version kept)"],
  ["commit_images", "Replace the photo (old version kept)"],
  ["history", "Keep the old extraction"],
  ["extract", "Re-extract the page"],
  ["ingest", "Re-index"],
  ["thumbs", "Refresh thumbnails"],
  ["qa", "Update the QA report"],
];
const ROLLBACK_STAGES: [string, string][] = [
  ["stage", "Stage the previous photo"],
  ["splice", "Splice the saved page back and verify"],
  ["commit_pdf", "Replace the PDF"],
  ["commit_images", "Restore the photo"],
  ["history", "Restore the previous extraction"],
  ["ingest", "Re-index"],
  ["thumbs", "Refresh thumbnails"],
  ["qa", "Update the QA report"],
];

/**
 * Follow one job over SSE; job is null until the first snapshot arrives. The server ends the stream when the job
 * settles (validated, submitted, rejected, declined, done, failed); bump restartKey after confirm, submit or retry
 * to follow it again.
 */
export function useJobStream(jobId: string | null, onChange?: (job: Job) => void, restartKey = 0): { job: Job | null; events: JobEvent[] } {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    setEvents([]);
    if (!jobId) {
      setJob(null);
      return;
    }
    return watchJob(
      jobId,
      (j) => {
        setJob(j);
        onChangeRef.current?.(j);
      },
      // EventSource may reconnect and replay; ids keep the list unique
      (e) => setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e])),
    );
  }, [jobId, restartKey]);
  return { job: job && job.id === jobId ? job : null, events };
}

/** Stage list of a job, from its SSE events. */
export function JobProgress({ job, events }: { job: Job | null; events: JobEvent[] }) {
  if (!job) return <div className="muted">Connecting…</div>;
  const stages = job.kind === "rollback" ? ROLLBACK_STAGES : RETAKE_STAGES.filter(([s]) => s !== "validate");
  const started = new Set(events.filter((e) => e.message.endsWith(" started")).map((e) => e.stage));
  const lastStarted = [...stages].reverse().find(([s]) => started.has(s))?.[0];
  const finished = job.status === "done";
  const logLines = events.filter((e) => !e.message.endsWith(" started")).slice(-8);
  return (
    <div className="progress">
      <ol className="stages">
        {stages.map(([s, label]) => {
          const state = finished || (started.has(s) && s !== lastStarted) ? "done" : s === lastStarted ? (job.status === "failed" ? "failed" : "current") : "pending";
          return (
            <li key={s} className={"stage stage-" + state}>
              <span className="stage-mark" aria-hidden="true">
                {state === "done" ? "✓" : state === "current" ? "●" : state === "failed" ? "✕" : "○"}
              </span>
              {label}
            </li>
          );
        })}
      </ol>
      <div className="muted progress-message">{job.message}</div>
      {logLines.length > 0 && (
        <details>
          <summary>Log</summary>
          <pre className="log">{logLines.map((e) => e.message).join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
