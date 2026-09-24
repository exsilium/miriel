import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "@miriel/shared/db";
import { buildServer, type ServerDeps } from "../server.js";
import { canRollBack, queueStatus, safeName, sniffImage, type LogEntry } from "./retakes.js";

const BOOK = {
  id: "vol1", title: "T", label: "Vol 1", page_count: 513, printed_to_pdf_offset: 1,
  pdf_path: "vol1.pdf", image_dir: "img", image_pattern: "p - {n}.jpg",
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

/** Just enough of retake_jobs for the routes: an in-memory table keyed by id. */
function jobsPool() {
  const jobs = new Map<string, Record<string, unknown>>();
  const now = new Date("2026-09-24T12:00:00Z");
  const pool = {
    async query(text: string, params: unknown[] = []) {
      if (text.includes("FROM books WHERE id")) return { rows: params[0] === "vol1" ? [BOOK] : [] };
      if (text.startsWith("INSERT INTO retake_jobs (id,")) {
        const [id, book_id, page, upload_path, upload_name, batch_id] = params;
        const row = { id, book_id, page, kind: "retake", status: "uploaded", stage: null, message: "m", upload_path, upload_name,
          image_sha256: null, folio_check: null, estimate_usd: null, cost_usd: null, before: null, after: null, error: null,
          pdf_committed: false, txn_id: null, batch_id, created_at: now, updated_at: now };
        jobs.set(id as string, row);
        return { rows: [row] };
      }
      if (text.startsWith("UPDATE retake_jobs SET status = $3")) {
        const row = jobs.get(params[0] as string);
        if (!row || !(params[1] as string[]).includes(row["status"] as string)) return { rows: [] };
        row["status"] = params[2];
        return { rows: [row] };
      }
      if (text.includes("FROM retake_jobs WHERE id = $1")) return { rows: jobs.has(params[0] as string) ? [jobs.get(params[0] as string)] : [] };
      if (text.includes("FROM retake_events")) return { rows: [{ id: "1", at: now, stage: "validate", message: "checking" }] };
      throw new Error("jobsPool: unexpected query " + text.slice(0, 70));
    },
  } as unknown as Pool;
  return { pool, jobs };
}

async function makeApp(retake: ServerDeps["retake"], pool = jobsPool().pool) {
  return buildServer({
    pool,
    dataDir: mkdtempSync(path.join(os.tmpdir(), "miriel-rt-data-")),
    logger: false,
    retrieve: async () => { throw new Error("unused"); },
    answer: async function* () { /* unused */ },
    resolvePrior: async () => [],
    retake,
  });
}

test("retake routes do not exist unless enabled", async () => {
  const app = await makeApp(undefined);
  const res = await app.inject({ method: "POST", url: "/api/retakes?book=vol1", headers: { "content-type": "image/jpeg" }, payload: JPEG });
  assert.equal(res.statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/retakes" })).statusCode, 404);
});

test("upload stores the photo in UPLOAD_DIR and records an uploaded job; confirm needs a validated job", async () => {
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), "miriel-rt-up-"));
  const { pool, jobs } = jobsPool();
  const app = await makeApp({ uploadDir }, pool);
  const res = await app.inject({
    method: "POST",
    url: "/api/retakes?book=vol1&page=289&batch=b1&filename=" + encodeURIComponent("../page_290.JPG"),
    headers: { "content-type": "image/jpeg" },
    payload: JPEG,
  });
  assert.equal(res.statusCode, 201, res.body);
  const job = res.json();
  assert.equal(job.status, "uploaded");
  assert.equal(job.page, 289);
  assert.equal(job.uploadName, "page_290.jpg");
  assert.equal(job.batchId, "b1");
  assert.ok(readFileSync(path.join(uploadDir, job.id, "page_290.jpg")).equals(JPEG));

  const early = await app.inject({ method: "POST", url: "/api/retakes/" + job.id + "/confirm" });
  assert.equal(early.statusCode, 409);
  jobs.get(job.id)!["status"] = "validated";
  const ok = await app.inject({ method: "POST", url: "/api/retakes/" + job.id + "/confirm" });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, "confirmed");

  const got = await app.inject({ method: "GET", url: "/api/retakes/" + job.id });
  assert.equal(got.json().events[0].message, "checking");
});

test("discard removes the upload", async () => {
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), "miriel-rt-up-"));
  const app = await makeApp({ uploadDir });
  const job = (await app.inject({ method: "POST", url: "/api/retakes?book=vol1", headers: { "content-type": "image/png" },
    payload: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]) })).json();
  assert.equal(job.uploadName, "upload.png");
  assert.ok(existsSync(path.join(uploadDir, job.id)));
  const res = await app.inject({ method: "POST", url: "/api/retakes/" + job.id + "/discard" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "discarded");
  assert.ok(!existsSync(path.join(uploadDir, job.id)));
});

test("uploads are checked: token, image bytes, book and page range", async () => {
  const app = await makeApp({ uploadDir: mkdtempSync(path.join(os.tmpdir(), "miriel-rt-up-")), token: "s3cret" });
  const post = (url: string, payload: Buffer, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { "content-type": "image/jpeg", ...headers }, payload });
  assert.equal((await post("/api/retakes?book=vol1", JPEG)).statusCode, 401);
  assert.equal((await post("/api/retakes?book=vol1", JPEG, { "x-retake-token": "wrong!" })).statusCode, 401);
  const auth = { "x-retake-token": "s3cret" };
  assert.equal((await post("/api/retakes?book=vol1", Buffer.from("not an image at all"), auth)).statusCode, 415);
  assert.equal((await post("/api/retakes?book=nope", JPEG, auth)).statusCode, 404);
  assert.equal((await post("/api/retakes?book=vol1&page=900", JPEG, auth)).statusCode, 400);
  assert.equal((await post("/api/retakes?book=vol1&page=12", JPEG, auth)).statusCode, 201);
  // reads need no token
  assert.equal((await app.inject({ method: "GET", url: "/api/retakes/00000000-0000-4000-8000-000000000000" })).statusCode, 404);
});

test("sniffImage and safeName", () => {
  assert.equal(sniffImage(JPEG), "jpg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), undefined);
  assert.equal(safeName("C:\\photos\\Elden Ring Vol 1 - 290.jpeg", "jpg"), "Elden Ring Vol 1 - 290.jpg");
  assert.equal(safeName("../../etc/passwd", "png"), "passwd.png");
  assert.equal(safeName("...", "jpg"), "upload.jpg");
  assert.equal(safeName("päge <1>.png", "png"), "p_ge _1_.png");
});

test("queueStatus: accept overrides, open jobs are in progress, a finished retake is done or still flagged", () => {
  assert.equal(queueStatus(true, null), "flagged");
  assert.equal(queueStatus(true, { kind: "accept", status: "done" }), "accepted");
  for (const st of ["uploaded", "validated", "rejected", "confirmed", "running", "failed"]) {
    assert.equal(queueStatus(true, { kind: "retake", status: st }), "in_progress");
  }
  assert.equal(queueStatus(false, { kind: "retake", status: "done" }), "done");
  assert.equal(queueStatus(true, { kind: "retake", status: "done" }), "still_flagged");
  assert.equal(queueStatus(true, { kind: "retake", status: "rolled_back" }), "flagged");
});

test("canRollBack follows retake.py: a retake whose version no rollback restored", () => {
  const e = (action: "retake" | "rollback", version: number, restored?: number): LogEntry => ({
    at: "", book: "vol1", page: 26, image_no: 27, action, version, archived: "", sha256: "", source: "", txn: "",
    ...(restored !== undefined ? { restored } : {}),
  });
  assert.equal(canRollBack([]), false);
  assert.equal(canRollBack([e("retake", 1)]), true);
  assert.equal(canRollBack([e("retake", 1), e("rollback", 2, 1)]), false);
  assert.equal(canRollBack([e("retake", 1), e("retake", 2), e("rollback", 3, 2)]), true);
  assert.equal(canRollBack([e("retake", 1), e("retake", 2), e("rollback", 3, 2), e("rollback", 4, 1)]), false);
});
