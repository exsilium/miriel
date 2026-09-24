/**
 * Client for /api/retakes (packages/api/src/routes/retakes.ts). The routes exist only when the api runs with
 * RETAKE_ENABLED=true; fetchRetakeConfig() returns null otherwise and the UI hides every retake control.
 * With RETAKE_TOKEN set on the server, writes send the token the operator entered (kept in localStorage).
 */

export type JobStatus = "uploaded" | "validated" | "rejected" | "confirmed" | "running" | "done" | "failed" | "rolled_back" | "discarded";
export type QueueStatus = "flagged" | "in_progress" | "done" | "still_flagged" | "accepted";

export interface QualitySummary {
  image_quality?: string;
  retake_recommended?: boolean;
  ocr_agreement?: string;
  quality_issues?: string[];
  entities?: number;
  markdown_chars?: number;
}

export interface FolioCheck {
  folio: string | null;
  match: string;
  imageNo: number | null;
  size: [number, number] | null;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export interface Job {
  id: string;
  book: string;
  page: number | null;
  kind: "retake" | "rollback" | "accept";
  status: JobStatus;
  stage: string | null;
  message: string | null;
  uploadName: string | null;
  imageSha256: string | null;
  folioCheck: FolioCheck | null;
  estimateUsd: number | null;
  costUsd: number | null;
  before: QualitySummary | null;
  after: QualitySummary | null;
  error: string | null;
  pdfCommitted: boolean;
  txnId: string | null;
  batchId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent {
  id: number;
  at: string;
  stage: string | null;
  message: string;
}

export interface RetakeConfig {
  enabled: true;
  tokenRequired: boolean;
  maxUploadBytes: number;
  counts: Record<QueueStatus, number>;
}

export interface QueueItem {
  book: string;
  page: number;
  imageVersion: string | null;
  imageQuality: string | null;
  qualityIssues: string[];
  retakeRecommended: boolean;
  retakeReason: string | null;
  affectedAreas: string | null;
  status: QueueStatus;
  job: { id: string; kind: string; status: JobStatus; message: string | null; updatedAt: string } | null;
}

export interface PageHistory {
  book: string;
  page: number;
  versions: {
    at: string;
    action: "retake" | "rollback";
    keptAs: number;
    restored: number | null;
    source: string;
    imageVersion: string | null;
    txn: string;
    after: QualitySummary | null;
  }[];
  jobs: Job[];
  canRollBack: boolean;
}

/** Jobs that are still being worked on, or wait for the operator. */
export const OPEN_STATUSES: JobStatus[] = ["uploaded", "validated", "rejected", "confirmed", "running", "failed"];
export const SETTLED_STATUSES: JobStatus[] = ["validated", "rejected", "done", "failed", "rolled_back", "discarded"];

const TOKEN_KEY = "miriel.retakeToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token lasts for this page view only */
  }
  memoryToken = token;
}

let memoryToken = "";

export class RetakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken() || memoryToken;
  if (token) headers.set("x-retake-token", token);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let msg = "Request failed (" + res.status + ")";
    try {
      const p = (await res.json()) as { title?: string; detail?: string };
      msg = (p.title ?? "Request failed") + (p.detail ? ": " + p.detail : "");
    } catch {
      /* not a problem+json body */
    }
    throw new RetakeError(msg, res.status);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post: RequestInit = { method: "POST" };

/** null when the api has retakes switched off (the routes answer 404). */
export async function fetchRetakeConfig(): Promise<RetakeConfig | null> {
  try {
    return await call<RetakeConfig>("/api/retakes/config");
  } catch (err) {
    if (err instanceof RetakeError && err.status === 404) return null;
    throw err;
  }
}

export const fetchQueue = (book?: string): Promise<QueueItem[]> =>
  call("/api/retakes/queue" + (book ? "?book=" + encodeURIComponent(book) : ""));
export const fetchHistory = (book: string, page: number): Promise<PageHistory> =>
  call("/api/retakes/history?book=" + encodeURIComponent(book) + "&page=" + page);
export const fetchJob = (id: string): Promise<Job & { events: JobEvent[] }> => call("/api/retakes/" + id);
export const fetchBatch = (batch: string): Promise<Job[]> => call("/api/retakes?batch=" + encodeURIComponent(batch));

export function uploadPhoto(book: string, file: File, opts: { page?: number | undefined; batch?: string | undefined } = {}): Promise<Job> {
  const params = new URLSearchParams({ book, filename: file.name });
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.batch) params.set("batch", opts.batch);
  const type = file.type === "image/png" || /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
  return call("/api/retakes?" + params.toString(), { method: "POST", headers: { "content-type": type }, body: file });
}

export const confirmJob = (id: string): Promise<Job> => call("/api/retakes/" + id + "/confirm", post);
export const confirmBatch = (batch: string): Promise<Job[]> => call("/api/retakes/batches/" + encodeURIComponent(batch) + "/confirm", post);
export const discardJob = (id: string): Promise<Job> => call("/api/retakes/" + id + "/discard", post);
export const retryJob = (id: string): Promise<Job> => call("/api/retakes/" + id + "/retry", post);
export const setJobPage = (id: string, page: number): Promise<Job> => call("/api/retakes/" + id + "/page", json({ page }));
export const rollbackPage = (book: string, page: number): Promise<Job> => call("/api/retakes/rollback", json({ book, page }));
export const acceptPage = (book: string, page: number, accepted: boolean): Promise<unknown> =>
  call("/api/retakes/accept", json({ book, page, accepted }));

export const uploadUrl = (id: string): string => "/api/retakes/" + id + "/upload";

/** Follow a job over SSE: `job` snapshots and `event` lines until it settles. Returns a close function. */
export function watchJob(id: string, onJob: (job: Job) => void, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource("/api/retakes/" + id + "/events");
  es.addEventListener("job", (m) => onJob(JSON.parse((m as MessageEvent<string>).data) as Job));
  es.addEventListener("event", (m) => onEvent(JSON.parse((m as MessageEvent<string>).data) as JobEvent));
  es.addEventListener("end", () => es.close());
  return () => es.close();
}
