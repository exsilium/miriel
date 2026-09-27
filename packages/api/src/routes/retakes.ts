/**
 * Page retake jobs (docs/build-spec-retakes.md §4). Registered only when RETAKE_ENABLED=true. The api never
 * writes source files: it stores uploads in UPLOAD_DIR (the `uploads` volume) and records jobs; the retake
 * worker validates and runs them.
 *
 * Who may do what (docs/build-spec-checklist.md §3 decision 13, docs/build-spec-retakes.md §10): with accounts
 * (the api's normal setup) every POST needs a logged-in user or the RETAKE_TOKEN (`x-retake-token`, admin
 * rights, for scripts). Users upload, set pages, submit their validated photos for approval and withdraw their
 * own jobs; admins confirm (= approve) or decline, retry, roll back and mark pages accepted. An admin's own
 * photos need no approval. Without accounts (tests) only RETAKE_TOKEN guards, as before.
 *
 *   POST /api/retakes?book=vol1[&page=289][&batch=<id>][&filename=x.jpg]   body: the photo (image/jpeg | image/png)
 *   GET  /api/retakes[?book=][&status=][&batch=]    jobs, newest first
 *   GET  /api/retakes/:id                           job + progress events
 *   GET  /api/retakes/:id/events                    SSE: `job` snapshots and `event` lines until the job settles
 *   POST /api/retakes/:id/submit                    validated -> submitted (a user asks an admin to run it)
 *   POST /api/retakes/batches/:batch/submit         the user's validated jobs of a batch
 *   POST /api/retakes/:id/confirm                   validated | submitted -> confirmed (admin; spends the estimate)
 *   POST /api/retakes/batches/:batch/confirm        every validated or submitted job of a batch, run as one retake
 *   POST /api/retakes/:id/decline  {note?}          submitted -> declined (admin); the photo stays viewable
 *   POST /api/retakes/batches/:batch/decline {note?}
 *   POST /api/retakes/:id/discard                   any job that has not started, or failed before the PDF swap
 *                                                   (users: their own jobs that have not been confirmed)
 *   POST /api/retakes/:id/retry                     failed -> confirmed (admin; resumes from the last completed stage)
 *   POST /api/retakes/rollback   {book, page}       undo the page's latest retake (admin; no model call)
 *
 * For the retake UI (§6):
 *   GET  /api/retakes/config                        what the viewer may do, page counts per queue status, jobs
 *                                                   waiting for approval (404 = retakes off)
 *   GET  /api/retakes/queue[?book=]                 flagged pages and pages with retake activity, with their status
 *   GET  /api/retakes/history?book=&page=           photo versions (DATA_DIR log) + jobs of one page
 *   GET  /api/retakes/:id/upload                    the uploaded photo, for the old / new comparison
 *   POST /api/retakes/:id/page   {page}             set the page by hand (unmatched batch photo); re-validates
 *   POST /api/retakes/accept     {book, page, accepted}   mark a flagged page as fine without a retake (admin; or undo)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "@miriel/shared/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpProblem } from "../problem.js";
import type { ServerDeps } from "../server.js";
import { openSse } from "../sse.js";
import { shortVersion } from "../versions.js";
import { parse, requireBook } from "./books.js";

/** Retakes replace page photos of the scanned guides; art books have none (docs/build-spec-artbooks.md §2). */
async function requireGuide(deps: ServerDeps, id: string) {
  const book = await requireBook(deps, id);
  if (book.kind === "artbook") throw new HttpProblem(400, "Not a guide", id + " is an art book; retakes apply to the scanned guides only.");
  return book;
}

export interface RetakeConfig {
  uploadDir: string;
  token?: string | undefined;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Statuses after which a job no longer changes on its own. */
export const SETTLED = new Set(["validated", "submitted", "rejected", "declined", "done", "failed", "rolled_back", "discarded"]);
/** A user may have at most this many photos waiting (uploaded, validated or submitted); admins are not limited. */
export const MAX_OPEN_PER_USER = 50;
/** Jobs a user may still withdraw (nothing has been spent on them). */
const WITHDRAWABLE = ["uploaded", "validated", "submitted", "rejected", "declined"];
const SSE_POLL_MS = 1000;
const SSE_MAX_MS = 2 * 60 * 60 * 1000;

const Id = z.object({ id: z.uuid() });
const Batch = z.object({ batch: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const UploadQuery = z.object({
  book: z.string().regex(/^[a-z0-9_-]+$/),
  page: z.coerce.number().int().min(0).max(99_999).optional(),
  batch: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  filename: z.string().max(200).optional(),
});
const ListQuery = z.object({
  book: z.string().regex(/^[a-z0-9_-]+$/).optional(),
  status: z.string().regex(/^[a-z_]+$/).optional(),
  batch: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
const RollbackBody = z.object({ book: z.string().regex(/^[a-z0-9_-]+$/), page: z.number().int().min(0).max(99_999) });
const AcceptBody = RollbackBody.extend({ accepted: z.boolean() });
const PageBody = z.object({ page: z.number().int().min(0).max(99_999) });
const BookQuery = z.object({ book: z.string().regex(/^[a-z0-9_-]+$/).optional() });
const HistoryQuery = z.object({ book: z.string().regex(/^[a-z0-9_-]+$/), page: z.coerce.number().int().min(0).max(99_999) });

/** Where a page stands in the retake queue. */
export type QueueStatus = "flagged" | "in_progress" | "done" | "still_flagged" | "accepted";
const OPEN_JOB = new Set(["uploaded", "validated", "submitted", "rejected", "confirmed", "running", "failed"]);

export function queueStatus(flagged: boolean, job: { kind: string; status: string } | null): QueueStatus {
  if (job?.kind === "accept") return "accepted";
  if (job && OPEN_JOB.has(job.status)) return "in_progress";
  if (job?.status === "done") return flagged ? "still_flagged" : "done";
  return "flagged"; // no job, or the last retake was rolled back
}

interface QueueRow {
  book_id: string;
  page: number;
  quality: Record<string, unknown>;
  image_sha256: string | null;
  job_id: string | null;
  job_kind: string | null;
  job_status: string | null;
  job_message: string | null;
  job_updated: Date | null;
  job_txn: string | null;
}

/**
 * Flagged pages plus every page with retake activity; the latest retake/accept job that was not discarded or
 * declined decides the status (a declined photo leaves the page where it was).
 */
async function queueRows(pool: Pool, book: string | undefined, dataDir?: string): Promise<QueueRow[]> {
  const { rows } = await pool.query<QueueRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (book_id, page) book_id, page, id, kind, status, message, updated_at, txn_id
         FROM retake_jobs
        WHERE page IS NOT NULL AND kind IN ('retake', 'accept') AND status NOT IN ('discarded', 'declined')
        ORDER BY book_id, page, created_at DESC
     )
     SELECT p.book_id, p.page, p.quality, p.image_sha256,
            l.id AS job_id, l.kind AS job_kind, l.status AS job_status, l.message AS job_message, l.updated_at AS job_updated,
            l.txn_id AS job_txn
       FROM pages p LEFT JOIN latest l ON l.book_id = p.book_id AND l.page = p.page
      WHERE ($1::text IS NULL OR p.book_id = $1)
        AND ((p.quality->>'retake_recommended')::boolean IS TRUE OR l.id IS NOT NULL)
      ORDER BY p.book_id, p.page`,
    [book ?? null],
  );
  // a finished retake that a CLI rollback undid counts as rolled back
  const undone = new Set<string>();
  for (const b of new Set(rows.filter((r) => r.job_status === "done" && r.job_kind === "retake").map((r) => r.book_id))) {
    const bookRow = await pool.query<{ image_dir: string }>("SELECT image_dir FROM books WHERE id = $1", [b]);
    if (!bookRow.rows[0] || !dataDir) continue;
    for (const k of undoneRetakes(await readImageLog(dataDir, bookRow.rows[0].image_dir))) undone.add(b + ":" + k);
  }
  for (const r of rows) {
    if (r.job_kind === "retake" && r.job_status === "done" && undone.has(r.book_id + ":" + r.job_txn + ":" + r.page)) r.job_status = "rolled_back";
  }
  return rows;
}

export interface LogEntry {
  at: string;
  book: string;
  page: number;
  image_no: number;
  action: "retake" | "rollback";
  version: number;
  restored?: number;
  archived: string;
  sha256: string;
  source: string;
  txn: string;
}

/** The retake log retake.py keeps next to the page photos (data/ is read-only here; the api only reads it). */
async function readImageLog(dataDir: string, imageDir: string): Promise<LogEntry[]> {
  try {
    const text = await readFile(path.join(dataDir, imageDir, "_versions", "log.jsonl"), "utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

/** "txn:page" of retakes a later rollback undid (CLI rollbacks are only in the log, not in retake_jobs). */
export function undoneRetakes(entries: LogEntry[]): Set<string> {
  const undone = new Set<string>();
  for (const r of entries.filter((e) => e.action === "rollback")) {
    const target = entries.find((e) => e.action === "retake" && e.page === r.page && e.version === r.restored);
    if (target) undone.add(target.txn + ":" + target.page);
  }
  return undone;
}

/** Share of a book's pages replaced since the last full rebuild above which the UI suggests rebuild_pdf.py (§7.3). */
export const REBUILD_SHARE = 0.2;

/** Distinct pages with a retake (not undone by a rollback) after `since` (ISO time; null = ever). */
export function replacedPages(entries: LogEntry[], since: string | null): number {
  const undone = undoneRetakes(entries);
  const t = since ? Date.parse(since) : -Infinity;
  const pages = new Set<number>();
  for (const e of entries) {
    if (e.action === "retake" && Date.parse(e.at) > t && !undone.has(e.txn + ":" + e.page)) pages.add(e.page);
  }
  return pages.size;
}

/** Time of the book's last full rebuild (rebuild_pdf.py logs `pdf_rebuilt` in DATA_DIR/_versions/log.jsonl). */
async function lastRebuild(dataDir: string, book: string): Promise<string | null> {
  try {
    const lines = (await readFile(path.join(dataDir, "_versions", "log.jsonl"), "utf8")).split("\n").filter((l) => l.trim());
    const builds = lines.map((l) => JSON.parse(l) as { at: string; book: string; event: string }).filter((e) => e.book === book && e.event === "pdf_rebuilt");
    return builds.at(-1)?.at ?? null;
  } catch {
    return null;
  }
}

/** Same rule as retake.py's rollback: a retake that no later rollback has undone. */
export function canRollBack(entries: LogEntry[]): boolean {
  const undone = new Set(entries.filter((e) => e.action === "rollback").map((e) => e.restored));
  return entries.some((e) => e.action === "retake" && !undone.has(e.version));
}

export interface JobRow {
  id: string;
  book_id: string;
  page: number | null;
  kind: string;
  status: string;
  stage: string | null;
  message: string | null;
  upload_path: string | null;
  upload_name: string | null;
  image_sha256: string | null;
  folio_check: unknown;
  estimate_usd: string | null;
  cost_usd: string | null;
  before: unknown;
  after: unknown;
  error: string | null;
  pdf_committed: boolean;
  txn_id: string | null;
  batch_id: string | null;
  created_at: Date;
  updated_at: Date;
  uploaded_by: string | null;
  submitted_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

const COLUMNS =
  "id, book_id, page, kind, status, stage, message, upload_path, upload_name, image_sha256, folio_check, estimate_usd, cost_usd, " +
  "before, after, error, pdf_committed, txn_id, batch_id, created_at, updated_at, uploaded_by, submitted_at, decided_by, decided_at, decision_note";

/** user id -> username, for "uploaded by" / "approved by". */
export type UserNames = Map<string, string>;

export function toJob(r: JobRow, names: UserNames = new Map()) {
  const who = (id: string | null) => (id ? { id, username: names.get(id) ?? null } : null);
  return {
    id: r.id,
    book: r.book_id,
    page: r.page,
    kind: r.kind,
    status: r.status,
    stage: r.stage,
    message: r.message,
    uploadName: r.upload_name,
    imageSha256: r.image_sha256,
    folioCheck: r.folio_check,
    estimateUsd: r.estimate_usd === null ? null : Number(r.estimate_usd),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    before: r.before,
    after: r.after,
    error: r.error,
    pdfCommitted: r.pdf_committed,
    txnId: r.txn_id,
    batchId: r.batch_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    uploadedBy: who(r.uploaded_by ?? null),
    submittedAt: r.submitted_at ?? null,
    decidedBy: who(r.decided_by ?? null),
    decidedAt: r.decided_at ?? null,
    decisionNote: r.decision_note ?? null,
  };
}

async function userNames(pool: Pool, rows: JobRow[]): Promise<UserNames> {
  const ids = [...new Set(rows.flatMap((r) => [r.uploaded_by, r.decided_by]).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return new Map();
  const { rows: users } = await pool.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE id = ANY($1)", [ids]);
  return new Map(users.map((u) => [u.id, u.username]));
}

/** Jobs as the api returns them, with user names resolved. */
export async function jobsOut(pool: Pool, rows: JobRow[]) {
  const names = await userNames(pool, rows);
  return rows.map((r) => toJob(r, names));
}

/** Who is asking: a user (admin or not), the RETAKE_TOKEN (admin rights), or anyone when neither guard exists. */
export interface RetakeActor {
  userId: string | null;
  admin: boolean;
  via: "user" | "token" | "open";
}

/** Owner or admin: may change a job that has not been confirmed. */
export function ownsJob(actor: RetakeActor, job: { uploaded_by: string | null }): boolean {
  return actor.admin || (actor.userId !== null && job.uploaded_by === actor.userId);
}

/** The photo type from its first bytes; the Content-Type header alone is not trusted. */
export function sniffImage(buf: Buffer): "jpg" | "png" | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return undefined;
}

/** A safe file name that keeps what retake.py reads from it (the page number and the extension). */
export function safeName(raw: string | undefined, ext: "jpg" | "png"): string {
  const base = path.basename(String(raw ?? "").replaceAll("\\", "/")).replace(/[^A-Za-z0-9 ._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  const stem = base.replace(/\.(jpe?g|png)$/i, "") || "upload";
  return stem + "." + ext;
}

async function getJob(pool: Pool, id: string): Promise<JobRow | undefined> {
  const { rows } = await pool.query<JobRow>("SELECT " + COLUMNS + " FROM retake_jobs WHERE id = $1", [id]);
  return rows[0];
}

async function getEvents(pool: Pool, id: string, after = 0) {
  const { rows } = await pool.query<{ id: string; at: Date; stage: string | null; message: string }>(
    "SELECT id, at, stage, message FROM retake_events WHERE job_id = $1 AND id > $2 ORDER BY id LIMIT 500",
    [id, after],
  );
  return rows.map((e) => ({ id: Number(e.id), at: e.at, stage: e.stage, message: e.message }));
}

/** Marks a column to be set to now() in a status transition. */
const NOW = Symbol("now()");
type Assign = Record<string, unknown>;

/** "SET status = $3, message = $4, col = $5 | now(), ..., updated_at = now()" with params appended after the first four. */
function setClause(params: unknown[], extra: Assign): string {
  const sets = ["status = $3", "message = $4"];
  for (const [col, v] of Object.entries(extra)) {
    if (v === NOW) sets.push(col + " = now()");
    else {
      params.push(v);
      sets.push(col + " = $" + params.length);
    }
  }
  sets.push("updated_at = now()");
  return sets.join(", ");
}

const Note = z.object({ note: z.string().trim().max(500).optional() });

export function registerRetakeRoutes(app: FastifyInstance, deps: ServerDeps, cfg: RetakeConfig): void {
  app.addContentTypeParser(["image/jpeg", "image/png"], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  const tokenMatches = (request: FastifyRequest): boolean => {
    if (!cfg.token) return false;
    const given = Buffer.from(String(request.headers["x-retake-token"] ?? ""));
    const want = Buffer.from(cfg.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  /** Null when the request may not change retakes at all. */
  const actorOf = (request: FastifyRequest): RetakeActor | null => {
    const user = request.user ?? null;
    if (tokenMatches(request)) return { userId: user?.id ?? null, admin: true, via: "token" };
    if (deps.auth) {
      if (!user || user.mustChangePassword) return null;
      return { userId: user.id, admin: user.role === "admin", via: "user" };
    }
    // no accounts (tests, or an api built without them): the token alone guards, as before accounts existed
    return cfg.token ? null : { userId: null, admin: true, via: "open" };
  };

  const requireActor = (request: FastifyRequest, admin = false): RetakeActor => {
    const actor = actorOf(request);
    if (!actor) {
      if (deps.auth) throw new HttpProblem(401, "Login required", "Log in to upload photos or change retakes.");
      throw new HttpProblem(401, "Retake token required", "Send the RETAKE_TOKEN value in the x-retake-token header.");
    }
    if (admin && !actor.admin) throw new HttpProblem(403, "Admins only", "An admin confirms, declines, retries and rolls back retakes.");
    return actor;
  };

  const requireJob = async (id: string): Promise<JobRow> => {
    const job = await getJob(deps.pool, id);
    if (!job) throw new HttpProblem(404, "Unknown retake job", "No retake job " + id + ".");
    return job;
  };

  const requireOwn = (actor: RetakeActor, job: JobRow): void => {
    if (!ownsJob(actor, job)) throw new HttpProblem(403, "Not your photo", "Only the user who uploaded it (or an admin) can change this job.");
  };

  const transition = async (id: string, from: string[], set: string, message: string, extra: Assign = {}) => {
    const params: unknown[] = [id, from, set, message];
    const sql = "UPDATE retake_jobs SET " + setClause(params, extra) + " WHERE id = $1 AND status = ANY($2) RETURNING " + COLUMNS;
    const { rows } = await deps.pool.query<JobRow>(sql, params);
    if (rows[0]) return rows[0];
    const job = await requireJob(id);
    throw new HttpProblem(409, "Wrong job status", "Job " + id + " is " + job.status + "; expected " + from.join(" or ") + ".");
  };

  /** The same transition for every matching job of a batch (only the actor's own jobs unless `ownerId` is null). */
  const batchTransition = async (batch: string, from: string[], set: string, message: string, extra: Assign, ownerId: string | null) => {
    const params: unknown[] = [batch, from, set, message];
    let sql = "UPDATE retake_jobs SET " + setClause(params, extra) + " WHERE batch_id = $1 AND status = ANY($2)";
    if (ownerId !== null) {
      params.push(ownerId);
      sql += " AND uploaded_by = $" + params.length;
    }
    const { rows } = await deps.pool.query<JobRow>(sql + " RETURNING " + COLUMNS, params);
    return rows;
  };

  const out = async (row: JobRow) => (await jobsOut(deps.pool, [row]))[0]!;

  app.post("/api/retakes", async (request, reply) => {
    const actor = requireActor(request);
    const q = parse(UploadQuery, request.query);
    const book = await requireGuide(deps, q.book);
    if (q.page !== undefined) {
      const first = 1 - book.printed_to_pdf_offset;
      const last = book.page_count - book.printed_to_pdf_offset;
      if (q.page < first || q.page > last) throw new HttpProblem(400, "Page out of range", "Printed page " + q.page + " is not in " + q.book + " (" + first + ".." + last + ").");
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new HttpProblem(415, "Photo required", "POST the photo as the request body with Content-Type image/jpeg or image/png.");
    }
    const ext = sniffImage(body);
    if (!ext) throw new HttpProblem(415, "Not a JPEG or PNG", "The body is neither a JPEG nor a PNG file.");
    if (!actor.admin && actor.userId) {
      const { rows } = await deps.pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM retake_jobs WHERE uploaded_by = $1 AND status = ANY($2)",
        [actor.userId, ["uploaded", "validated", "submitted"]],
      );
      if (Number(rows[0]?.n ?? 0) >= MAX_OPEN_PER_USER) {
        throw new HttpProblem(429, "Too many open photos", "You have " + MAX_OPEN_PER_USER + " photos waiting; submit or discard some first.");
      }
    }
    const id = randomUUID();
    const name = safeName(q.filename ?? (request.headers["x-filename"] as string | undefined), ext);
    const rel = id + "/" + name;
    await mkdir(path.join(cfg.uploadDir, id), { recursive: true });
    await writeFile(path.join(cfg.uploadDir, rel), body);
    try {
      const { rows } = await deps.pool.query<JobRow>(
        `INSERT INTO retake_jobs (id, book_id, page, kind, status, message, upload_path, upload_name, batch_id, uploaded_by)
         VALUES ($1, $2, $3, 'retake', 'uploaded', 'waiting for the worker to check the photo', $4, $5, $6, $7) RETURNING ` + COLUMNS,
        [id, q.book, q.page ?? null, rel, name, q.batch ?? null, actor.userId],
      );
      reply.code(201);
      return out(rows[0]!);
    } catch (err) {
      await rm(path.join(cfg.uploadDir, id), { recursive: true, force: true });
      throw err;
    }
  });

  app.get("/api/retakes", async (request) => {
    const q = parse(ListQuery, request.query);
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [col, v] of [["book_id", q.book], ["status", q.status], ["batch_id", q.batch]] as const) {
      if (v !== undefined) {
        params.push(v);
        where.push(col + " = $" + params.length);
      }
    }
    const { rows } = await deps.pool.query<JobRow>(
      "SELECT " + COLUMNS + " FROM retake_jobs" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY created_at DESC LIMIT 500",
      params,
    );
    return jobsOut(deps.pool, rows);
  });

  app.get("/api/retakes/:id", async (request) => {
    const { id } = parse(Id, request.params);
    const job = await requireJob(id);
    return { ...(await out(job)), events: await getEvents(deps.pool, id) };
  });

  app.get("/api/retakes/:id/events", async (request, reply) => {
    const { id } = parse(Id, request.params);
    await requireJob(id);
    reply.hijack();
    const sse = openSse(reply.raw);
    const started = Date.now();
    let lastEvent = 0;
    let lastUpdate = "";
    try {
      while (sse.open && Date.now() - started < SSE_MAX_MS) {
        const job = await getJob(deps.pool, id);
        if (!job) break;
        const stamp = new Date(job.updated_at).toISOString() + job.status;
        if (stamp !== lastUpdate) {
          lastUpdate = stamp;
          sse.send("job", await out(job));
        }
        const events = await getEvents(deps.pool, id, lastEvent);
        for (const e of events) sse.send("event", e);
        if (events.length) lastEvent = events.at(-1)!.id;
        if (SETTLED.has(job.status) && events.length === 0) {
          sse.send("end", { status: job.status });
          break;
        }
        await new Promise((r) => setTimeout(r, SSE_POLL_MS));
      }
    } catch (err) {
      request.log.error({ err }, "retake events stream failed");
      sse.send("error", { message: "progress stream failed" });
    } finally {
      sse.close();
    }
  });

  app.post("/api/retakes/:id/submit", async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Id, request.params);
    requireOwn(actor, await requireJob(id));
    return out(await transition(id, ["validated"], "submitted", "waiting for an admin's approval", { submitted_at: NOW }));
  });

  app.post("/api/retakes/batches/:batch/submit", async (request) => {
    const actor = requireActor(request);
    const { batch } = parse(Batch, request.params);
    const rows = await batchTransition(batch, ["validated"], "submitted", "waiting for an admin's approval", { submitted_at: NOW }, actor.admin ? null : actor.userId);
    if (!rows.length) throw new HttpProblem(409, "Nothing to submit", "Batch " + batch + " has no validated photos of yours.");
    return jobsOut(deps.pool, rows);
  });

  app.post("/api/retakes/:id/confirm", async (request) => {
    const actor = requireActor(request, true);
    const { id } = parse(Id, request.params);
    const before = await requireJob(id);
    const message = before.status === "submitted" ? "approved; queued for the worker" : "confirmed; queued for the worker";
    return out(await transition(id, ["validated", "submitted"], "confirmed", message, { decided_by: actor.userId, decided_at: NOW }));
  });

  app.post("/api/retakes/batches/:batch/confirm", async (request) => {
    const actor = requireActor(request, true);
    const { batch } = parse(Batch, request.params);
    const rows = await batchTransition(batch, ["validated", "submitted"], "confirmed", "confirmed; queued for the worker", { decided_by: actor.userId, decided_at: NOW }, null);
    if (!rows.length) throw new HttpProblem(409, "Nothing to confirm", "Batch " + batch + " has no validated or submitted jobs.");
    return jobsOut(deps.pool, rows);
  });

  app.post("/api/retakes/:id/decline", async (request) => {
    const actor = requireActor(request, true);
    const { id } = parse(Id, request.params);
    const { note } = parse(Note, request.body ?? {});
    return out(
      await transition(id, ["submitted"], "declined", note ? "declined: " + note : "declined", { decided_by: actor.userId, decided_at: NOW, decision_note: note || null }),
    );
  });

  app.post("/api/retakes/batches/:batch/decline", async (request) => {
    const actor = requireActor(request, true);
    const { batch } = parse(Batch, request.params);
    const { note } = parse(Note, request.body ?? {});
    const rows = await batchTransition(batch, ["submitted"], "declined", note ? "declined: " + note : "declined", { decided_by: actor.userId, decided_at: NOW, decision_note: note || null }, null);
    if (!rows.length) throw new HttpProblem(409, "Nothing to decline", "Batch " + batch + " has no submitted jobs.");
    return jobsOut(deps.pool, rows);
  });

  app.post("/api/retakes/:id/discard", async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Id, request.params);
    const job = await requireJob(id);
    if (!actor.admin) {
      requireOwn(actor, job);
      if (!WITHDRAWABLE.includes(job.status)) {
        throw new HttpProblem(403, "Admins only", "This retake was confirmed; only an admin can stop it now.");
      }
    }
    if (job.pdf_committed) throw new HttpProblem(409, "Cannot discard", "This retake already replaced the book PDF; finish it (retry), then roll back.");
    if (job.txn_id && (job.status === "failed" || job.status === "confirmed")) {
      // the photos of one started retake are dropped together; the worker then abandons its journal
      await deps.pool.query(
        "UPDATE retake_jobs SET status = 'discarded', message = 'discarded', updated_at = now() WHERE txn_id = $1 AND status IN ('failed', 'confirmed') AND NOT pdf_committed",
        [job.txn_id],
      );
    } else {
      // a confirmed job the worker is claiming right now is `running` once its lock is released: 409
      await transition(id, [...WITHDRAWABLE, "confirmed", "failed"], "discarded", actor.admin && job.uploaded_by !== actor.userId && job.uploaded_by ? "discarded by an admin" : "discarded");
    }
    if (job.upload_path) await rm(path.join(cfg.uploadDir, path.dirname(job.upload_path)), { recursive: true, force: true });
    return out((await getJob(deps.pool, id))!);
  });

  app.post("/api/retakes/:id/retry", async (request) => {
    requireActor(request, true);
    const { id } = parse(Id, request.params);
    const job = await transition(id, ["failed"], "confirmed", "retry queued; resumes from the last completed stage");
    if (job.txn_id) {
      await deps.pool.query(
        "UPDATE retake_jobs SET status = 'confirmed', message = $2, updated_at = now() WHERE txn_id = $1 AND status = 'failed'",
        [job.txn_id, "retry queued; resumes from the last completed stage"],
      );
    }
    return out(job);
  });

  app.get("/api/retakes/config", async (request) => {
    const counts: Record<QueueStatus, number> = { flagged: 0, in_progress: 0, done: 0, still_flagged: 0, accepted: 0 };
    for (const r of await queueRows(deps.pool, undefined, deps.dataDir)) {
      counts[queueStatus(Boolean(r.quality["retake_recommended"]), r.job_kind ? { kind: r.job_kind, status: r.job_status ?? "" } : null)] += 1;
    }
    const { rows: books } = await deps.pool.query<{ id: string; label: string; image_dir: string; page_count: number }>(
      "SELECT id, label, image_dir, page_count FROM books WHERE kind = 'guide' ORDER BY id",
    );
    const rebuild = await Promise.all(
      books.map(async (b) => {
        const since = await lastRebuild(deps.dataDir, b.id);
        const replaced = replacedPages((await readImageLog(deps.dataDir, b.image_dir)).filter((e) => e.book === b.id), since);
        return { book: b.id, label: b.label, pageCount: b.page_count, replacedSinceBuild: replaced, lastBuild: since, suggest: replaced > b.page_count * REBUILD_SHARE };
      }),
    );
    const { rows: waiting } = await deps.pool.query<{ n: string }>("SELECT count(*) AS n FROM retake_jobs WHERE status = 'submitted'");
    const actor = actorOf(request);
    return {
      enabled: true,
      tokenRequired: Boolean(cfg.token),
      /** With accounts, changes need a login (or the token); without, only the token. */
      accounts: Boolean(deps.auth),
      viewer: { canUpload: Boolean(actor), canApprove: Boolean(actor?.admin), userId: actor?.userId ?? null },
      awaitingApproval: Number(waiting[0]?.n ?? 0),
      maxUploadBytes: MAX_UPLOAD_BYTES,
      counts,
      rebuild,
    };
  });

  app.get("/api/retakes/queue", async (request) => {
    const { book } = parse(BookQuery, request.query);
    return (await queueRows(deps.pool, book, deps.dataDir)).map((r) => {
      const q = r.quality;
      const job = r.job_id ? { id: r.job_id, kind: r.job_kind!, status: r.job_status!, message: r.job_message, updatedAt: r.job_updated } : null;
      return {
        book: r.book_id,
        page: r.page,
        imageVersion: shortVersion(r.image_sha256),
        imageQuality: q["image_quality"] ?? null,
        qualityIssues: (q["quality_issues"] as string[] | undefined) ?? [],
        retakeRecommended: Boolean(q["retake_recommended"]),
        retakeReason: q["retake_reason"] ?? null,
        affectedAreas: q["affected_areas"] ?? null,
        status: queueStatus(Boolean(q["retake_recommended"]), job),
        job,
      };
    });
  });

  app.get("/api/retakes/history", async (request) => {
    const q = parse(HistoryQuery, request.query);
    const book = await requireGuide(deps, q.book);
    const entries = (await readImageLog(deps.dataDir, book.image_dir)).filter((e) => e.book === q.book && e.page === q.page);
    const { rows } = await deps.pool.query<JobRow>(
      "SELECT " + COLUMNS + " FROM retake_jobs WHERE book_id = $1 AND page = $2 ORDER BY created_at DESC LIMIT 100",
      [q.book, q.page],
    );
    const jobs = await jobsOut(deps.pool, rows);
    const versions = [...entries].reverse().map((e) => {
      const job = jobs.find((j) => j.txnId === e.txn && j.page === e.page && j.kind === e.action);
      return {
        at: e.at,
        action: e.action,
        keptAs: e.version,
        restored: e.restored ?? null,
        source: e.source,
        imageVersion: shortVersion(e.sha256),
        txn: e.txn,
        after: job?.after ?? null,
      };
    });
    return { book: q.book, page: q.page, versions, jobs, canRollBack: canRollBack(entries) };
  });

  app.get("/api/retakes/:id/upload", async (request, reply) => {
    const { id } = parse(Id, request.params);
    const job = await getJob(deps.pool, id);
    if (!job?.upload_path) throw new HttpProblem(404, "No upload", "Job " + id + " has no uploaded photo.");
    const file = path.join(cfg.uploadDir, job.upload_path);
    try {
      await stat(file);
    } catch {
      throw new HttpProblem(404, "No upload", "The photo of job " + id + " is no longer stored (the retake finished or was discarded).");
    }
    reply.header("cache-control", "private, no-store");
    reply.type(file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    return reply.send(createReadStream(file));
  });

  app.post("/api/retakes/:id/page", async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Id, request.params);
    const { page } = parse(PageBody, request.body);
    const job = await requireJob(id);
    requireOwn(actor, job);
    const book = await requireGuide(deps, job.book_id);
    const first = 1 - book.printed_to_pdf_offset;
    const last = book.page_count - book.printed_to_pdf_offset;
    if (page < first || page > last) {
      throw new HttpProblem(400, "Page out of range", "Printed page " + page + " is not in " + job.book_id + " (" + first + ".." + last + ").");
    }
    // a submitted photo goes back through validation (and has to be submitted again)
    const { rows } = await deps.pool.query<JobRow>(
      `UPDATE retake_jobs SET page = $2, status = 'uploaded', folio_check = NULL, error = NULL, before = NULL, estimate_usd = NULL,
              submitted_at = NULL, message = 'page set by hand; waiting for the worker to check the photo', updated_at = now()
        WHERE id = $1 AND kind = 'retake' AND status IN ('validated', 'rejected', 'submitted') RETURNING ` + COLUMNS,
      [id, page],
    );
    if (!rows[0]) throw new HttpProblem(409, "Wrong job status", "Job " + id + " is " + job.status + "; the page can be set on a validated, submitted or rejected photo.");
    return out(rows[0]);
  });

  app.post("/api/retakes/accept", async (request) => {
    requireActor(request, true);
    const body = parse(AcceptBody, request.body);
    await requireGuide(deps, body.book);
    await deps.pool.query(
      "UPDATE retake_jobs SET status = 'discarded', message = 'acceptance withdrawn', updated_at = now() " +
        "WHERE kind = 'accept' AND book_id = $1 AND page = $2 AND status = 'done'",
      [body.book, body.page],
    );
    if (body.accepted) {
      await deps.pool.query(
        "INSERT INTO retake_jobs (book_id, page, kind, status, message) VALUES ($1, $2, 'accept', 'done', 'accepted without a retake')",
        [body.book, body.page],
      );
    }
    return { book: body.book, page: body.page, accepted: body.accepted };
  });

  app.post("/api/retakes/rollback", async (request, reply) => {
    const actor = requireActor(request, true);
    const body = parse(RollbackBody, request.body);
    await requireGuide(deps, body.book);
    const { rows } = await deps.pool.query<JobRow>(
      `INSERT INTO retake_jobs (book_id, page, kind, status, message, uploaded_by, decided_by, decided_at)
       VALUES ($1, $2, 'rollback', 'confirmed', 'rollback queued for the worker', $3, $3, now()) RETURNING ` + COLUMNS,
      [body.book, body.page, actor.userId],
    );
    reply.code(201);
    return out(rows[0]!);
  });
}
