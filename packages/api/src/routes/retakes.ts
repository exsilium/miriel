/**
 * Page retake jobs (docs/build-spec-retakes.md §4). Registered only when RETAKE_ENABLED=true. The api never
 * writes source files: it stores uploads in UPLOAD_DIR (the `uploads` volume) and records jobs; the retake
 * worker validates and runs them. With RETAKE_TOKEN set, every POST needs `x-retake-token: <token>`.
 *
 *   POST /api/retakes?book=vol1[&page=289][&batch=<id>][&filename=x.jpg]   body: the photo (image/jpeg | image/png)
 *   GET  /api/retakes[?book=][&status=][&batch=]    jobs, newest first
 *   GET  /api/retakes/:id                           job + progress events
 *   GET  /api/retakes/:id/events                    SSE: `job` snapshots and `event` lines until the job settles
 *   POST /api/retakes/:id/confirm                   validated -> confirmed (spends the estimate)
 *   POST /api/retakes/batches/:batch/confirm        every validated job of a batch, run as one retake
 *   POST /api/retakes/:id/discard                   any job that has not started, or failed before the PDF swap
 *   POST /api/retakes/:id/retry                     failed -> confirmed (resumes from the last completed stage)
 *   POST /api/retakes/rollback   {book, page}       undo the page's latest retake (no model call)
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "@miriel/shared/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpProblem } from "../problem.js";
import type { ServerDeps } from "../server.js";
import { openSse } from "../sse.js";
import { parse, requireBook } from "./books.js";

export interface RetakeConfig {
  uploadDir: string;
  token?: string | undefined;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Statuses after which a job no longer changes on its own. */
export const SETTLED = new Set(["validated", "rejected", "done", "failed", "rolled_back", "discarded"]);
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
}

const COLUMNS =
  "id, book_id, page, kind, status, stage, message, upload_path, upload_name, image_sha256, folio_check, estimate_usd, cost_usd, " +
  "before, after, error, pdf_committed, txn_id, batch_id, created_at, updated_at";

export function toJob(r: JobRow) {
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
  };
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

export function registerRetakeRoutes(app: FastifyInstance, deps: ServerDeps, cfg: RetakeConfig): void {
  app.addContentTypeParser(["image/jpeg", "image/png"], { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  const requireToken = (request: FastifyRequest): void => {
    if (!cfg.token) return;
    const given = Buffer.from(String(request.headers["x-retake-token"] ?? ""));
    const want = Buffer.from(cfg.token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new HttpProblem(401, "Retake token required", "Send the RETAKE_TOKEN value in the x-retake-token header.");
    }
  };

  const transition = async (id: string, from: string[], set: string, message: string) => {
    const { rows } = await deps.pool.query<JobRow>(
      "UPDATE retake_jobs SET status = $3, message = $4, updated_at = now() WHERE id = $1 AND status = ANY($2) RETURNING " + COLUMNS,
      [id, from, set, message],
    );
    if (rows[0]) return rows[0];
    const job = await getJob(deps.pool, id);
    if (!job) throw new HttpProblem(404, "Unknown retake job", "No retake job " + id + ".");
    throw new HttpProblem(409, "Wrong job status", "Job " + id + " is " + job.status + "; expected " + from.join(" or ") + ".");
  };

  app.post("/api/retakes", async (request, reply) => {
    requireToken(request);
    const q = parse(UploadQuery, request.query);
    const book = await requireBook(deps, q.book);
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
    const id = randomUUID();
    const name = safeName(q.filename ?? (request.headers["x-filename"] as string | undefined), ext);
    const rel = id + "/" + name;
    await mkdir(path.join(cfg.uploadDir, id), { recursive: true });
    await writeFile(path.join(cfg.uploadDir, rel), body);
    try {
      const { rows } = await deps.pool.query<JobRow>(
        `INSERT INTO retake_jobs (id, book_id, page, kind, status, message, upload_path, upload_name, batch_id)
         VALUES ($1, $2, $3, 'retake', 'uploaded', 'waiting for the worker to check the photo', $4, $5, $6) RETURNING ` + COLUMNS,
        [id, q.book, q.page ?? null, rel, name, q.batch ?? null],
      );
      reply.code(201);
      return toJob(rows[0]!);
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
    return rows.map(toJob);
  });

  app.get("/api/retakes/:id", async (request) => {
    const { id } = parse(Id, request.params);
    const job = await getJob(deps.pool, id);
    if (!job) throw new HttpProblem(404, "Unknown retake job", "No retake job " + id + ".");
    return { ...toJob(job), events: await getEvents(deps.pool, id) };
  });

  app.get("/api/retakes/:id/events", async (request, reply) => {
    const { id } = parse(Id, request.params);
    if (!(await getJob(deps.pool, id))) throw new HttpProblem(404, "Unknown retake job", "No retake job " + id + ".");
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
          sse.send("job", toJob(job));
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

  app.post("/api/retakes/:id/confirm", async (request) => {
    requireToken(request);
    const { id } = parse(Id, request.params);
    return toJob(await transition(id, ["validated"], "confirmed", "confirmed; queued for the worker"));
  });

  app.post("/api/retakes/batches/:batch/confirm", async (request) => {
    requireToken(request);
    const { batch } = parse(Batch, request.params);
    const { rows } = await deps.pool.query<JobRow>(
      "UPDATE retake_jobs SET status = 'confirmed', message = 'confirmed; queued for the worker', updated_at = now() " +
        "WHERE batch_id = $1 AND status = 'validated' RETURNING " + COLUMNS,
      [batch],
    );
    if (!rows.length) throw new HttpProblem(409, "Nothing to confirm", "Batch " + batch + " has no validated jobs.");
    return rows.map(toJob);
  });

  app.post("/api/retakes/:id/discard", async (request) => {
    requireToken(request);
    const { id } = parse(Id, request.params);
    const job = await getJob(deps.pool, id);
    if (!job) throw new HttpProblem(404, "Unknown retake job", "No retake job " + id + ".");
    if (job.pdf_committed) throw new HttpProblem(409, "Cannot discard", "This retake already replaced the book PDF; finish it (retry), then roll back.");
    if (job.txn_id && (job.status === "failed" || job.status === "confirmed")) {
      // the photos of one started retake are dropped together; the worker then abandons its journal
      await deps.pool.query(
        "UPDATE retake_jobs SET status = 'discarded', message = 'discarded', updated_at = now() WHERE txn_id = $1 AND status IN ('failed', 'confirmed') AND NOT pdf_committed",
        [job.txn_id],
      );
    } else {
      // a confirmed job the worker is claiming right now is `running` once its lock is released: 409
      await transition(id, ["uploaded", "validated", "rejected", "confirmed", "failed"], "discarded", "discarded");
    }
    if (job.upload_path) await rm(path.join(cfg.uploadDir, path.dirname(job.upload_path)), { recursive: true, force: true });
    return toJob((await getJob(deps.pool, id))!);
  });

  app.post("/api/retakes/:id/retry", async (request) => {
    requireToken(request);
    const { id } = parse(Id, request.params);
    const job = await transition(id, ["failed"], "confirmed", "retry queued; resumes from the last completed stage");
    if (job.txn_id) {
      await deps.pool.query(
        "UPDATE retake_jobs SET status = 'confirmed', message = $2, updated_at = now() WHERE txn_id = $1 AND status = 'failed'",
        [job.txn_id, "retry queued; resumes from the last completed stage"],
      );
    }
    return toJob(job);
  });

  app.post("/api/retakes/rollback", async (request, reply) => {
    requireToken(request);
    const body = parse(RollbackBody, request.body);
    await requireBook(deps, body.book);
    const { rows } = await deps.pool.query<JobRow>(
      `INSERT INTO retake_jobs (book_id, page, kind, status, message) VALUES ($1, $2, 'rollback', 'confirmed', 'rollback queued for the worker')
       RETURNING ` + COLUMNS,
      [body.book, body.page],
    );
    reply.code(201);
    return toJob(rows[0]!);
  });
}
