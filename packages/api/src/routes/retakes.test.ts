import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "@miriel/shared/db";
import { hashPassword, memoryAuthStore } from "@miriel/shared/users";
import { buildServer, type ServerDeps } from "../server.js";
import { canRollBack, queueStatus, replacedPages, safeName, sniffImage, type LogEntry } from "./retakes.js";

const BOOK = {
  id: "vol1", title: "T", label: "Vol 1", page_count: 513, printed_to_pdf_offset: 1,
  pdf_path: "vol1.pdf", image_dir: "img", image_pattern: "p - {n}.jpg",
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

/** Just enough of retake_jobs (and users, for names) for the routes: an in-memory table keyed by id. */
function jobsPool(usernames: Map<string, string> = new Map()) {
  const jobs = new Map<string, Record<string, unknown>>();
  const now = new Date("2026-09-24T12:00:00Z");
  /** Applies "status = $3, message = $4, col = $n | now(), ..." from a transition's SET clause. */
  const apply = (row: Record<string, unknown>, text: string, params: unknown[]) => {
    const set = text.slice(text.indexOf(" SET ") + 5, text.indexOf(" WHERE "));
    for (const part of set.split(", ")) {
      const [col, val] = part.split(" = ") as [string, string];
      row[col] = val === "now()" ? now : params[Number(val.slice(1)) - 1];
    }
  };
  const pool = {
    async query(text: string, params: unknown[] = []) {
      if (text.includes("FROM books WHERE id")) return { rows: params[0] === "vol1" ? [BOOK] : [] };
      if (text.startsWith("INSERT INTO retake_jobs (id,")) {
        const [id, book_id, page, upload_path, upload_name, batch_id, uploaded_by] = params;
        const row = { id, book_id, page, kind: "retake", status: "uploaded", stage: null, message: "m", upload_path, upload_name,
          image_sha256: null, folio_check: null, estimate_usd: null, cost_usd: null, before: null, after: null, error: null,
          pdf_committed: false, txn_id: null, batch_id, created_at: now, updated_at: now,
          uploaded_by: uploaded_by ?? null, submitted_at: null, decided_by: null, decided_at: null, decision_note: null };
        jobs.set(id as string, row);
        return { rows: [row] };
      }
      if (text.startsWith("UPDATE retake_jobs SET status = $3") && text.includes("WHERE batch_id = $1")) {
        const owner = /AND uploaded_by = \$(\d+)/.exec(text);
        const rows = [...jobs.values()].filter(
          (r) => r["batch_id"] === params[0] && (params[1] as string[]).includes(r["status"] as string) && (!owner || r["uploaded_by"] === params[Number(owner[1]) - 1]),
        );
        for (const r of rows) apply(r, text, params);
        return { rows };
      }
      if (text.startsWith("UPDATE retake_jobs SET status = $3")) {
        const row = jobs.get(params[0] as string);
        if (!row || !(params[1] as string[]).includes(row["status"] as string)) return { rows: [] };
        apply(row, text, params);
        return { rows: [row] };
      }
      if (text.startsWith("SELECT count(*) AS n FROM retake_jobs WHERE uploaded_by")) {
        const n = [...jobs.values()].filter((r) => r["uploaded_by"] === params[0] && (params[1] as string[]).includes(r["status"] as string)).length;
        return { rows: [{ n: String(n) }] };
      }
      if (text.startsWith("SELECT id, username FROM users")) {
        return { rows: (params[0] as string[]).filter((id) => usernames.has(id)).map((id) => ({ id, username: usernames.get(id) })) };
      }
      if (text.includes("FROM retake_jobs WHERE id = $1")) return { rows: jobs.has(params[0] as string) ? [jobs.get(params[0] as string)] : [] };
      if (text.includes("FROM retake_events")) return { rows: [{ id: "1", at: now, stage: "validate", message: "checking" }] };
      throw new Error("jobsPool: unexpected query " + text.slice(0, 70));
    },
  } as unknown as Pool;
  return { pool, jobs };
}

async function makeApp(retake: ServerDeps["retake"], pool = jobsPool().pool, auth?: ServerDeps["auth"]) {
  return buildServer({
    pool,
    dataDir: mkdtempSync(path.join(os.tmpdir(), "miriel-rt-data-")),
    logger: false,
    retrieve: async () => { throw new Error("unused"); },
    answer: async function* () { /* unused */ },
    resolvePrior: async () => [],
    retake,
    auth,
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

test("replacedPages counts distinct pages retaken after the last rebuild, minus undone ones", () => {
  const e = (action: "retake" | "rollback", page: number, version: number, at: string, txn: string, restored?: number): LogEntry => ({
    at, book: "vol1", page, image_no: page + 1, action, version, archived: "", sha256: "", source: "", txn,
    ...(restored !== undefined ? { restored } : {}),
  });
  const log = [
    e("retake", 10, 1, "2026-09-01T10:00:00Z", "a"),
    e("retake", 11, 1, "2026-09-10T10:00:00Z", "b"),
    e("retake", 11, 2, "2026-09-11T10:00:00Z", "c"),
    e("retake", 12, 1, "2026-09-12T10:00:00Z", "d"),
    e("rollback", 12, 2, "2026-09-12T11:00:00Z", "e", 1),
  ];
  assert.equal(replacedPages(log, null), 2); // 10 and 11; 12 was rolled back
  assert.equal(replacedPages(log, "2026-09-05T00:00:00Z"), 1); // only 11 since the rebuild
});

// ---------------------------------------------------------------- approvals (docs/build-spec-checklist.md §3 decision 13)

async function approvalsApp(token?: string) {
  const store = memoryAuthStore();
  const names = new Map<string, string>();
  const { pool, jobs } = jobsPool(names);
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), "miriel-rt-ap-"));
  const app = await makeApp({ uploadDir, token }, pool, { store, required: false, cookieSecure: false });
  const cookies: Record<string, string> = {};
  for (const [name, role] of [["alice", "user"], ["bob", "user"], ["admin", "admin"]] as const) {
    const u = await store.createUser({ username: name, role, passwordHash: await hashPassword(name + " password"), mustChangePassword: false });
    names.set(u.id, name);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: name + " password" } });
    cookies[name] = String(res.headers["set-cookie"]).split(";")[0]!;
  }
  const as = (who: string | null, extra: Record<string, string> = {}) => ({ ...(who ? { cookie: cookies[who]!, "x-miriel": "1" } : {}), ...extra });
  const upload = async (who: string | null, batch?: string) =>
    app.inject({ method: "POST", url: "/api/retakes?book=vol1&page=289" + (batch ? "&batch=" + batch : ""), headers: as(who, { "content-type": "image/jpeg" }), payload: JPEG });
  const post = (who: string | null, url: string, payload?: object, extra: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: as(who, extra), ...(payload ? { payload } : {}) });
  /** What the worker does after checking the photo. */
  const validate = (id: string) => void (jobs.get(id)!["status"] = "validated");
  return { app, jobs, upload, post, validate };
}

test("approvals: a user's photo is submitted, an admin declines or approves it; nobody else touches it", async () => {
  const { jobs, upload, post, validate } = await approvalsApp();
  assert.equal((await upload(null)).statusCode, 401, "anonymous uploads need a login");

  const up = await upload("alice");
  assert.equal(up.statusCode, 201, up.body);
  const job = up.json();
  assert.deepEqual(job.uploadedBy, { id: jobs.get(job.id)!["uploaded_by"], username: "alice" });
  validate(job.id);

  assert.equal((await post("alice", "/api/retakes/" + job.id + "/confirm")).statusCode, 403, "users cannot confirm");
  assert.equal((await post("bob", "/api/retakes/" + job.id + "/submit")).statusCode, 403, "not bob's photo");
  const sub = await post("alice", "/api/retakes/" + job.id + "/submit");
  assert.equal(sub.statusCode, 200, sub.body);
  assert.equal(sub.json().status, "submitted");
  assert.ok(sub.json().submittedAt);
  assert.equal((await post("bob", "/api/retakes/" + job.id + "/discard")).statusCode, 403);
  assert.equal((await post("alice", "/api/retakes/" + job.id + "/decline", { note: "x" })).statusCode, 403, "users cannot decline");

  const dec = await post("admin", "/api/retakes/" + job.id + "/decline", { note: "  blurry at the gutter " });
  assert.equal(dec.statusCode, 200, dec.body);
  assert.equal(dec.json().status, "declined");
  assert.equal(dec.json().decisionNote, "blurry at the gutter");
  assert.equal(dec.json().decidedBy.username, "admin");
  assert.equal(dec.json().message, "declined: blurry at the gutter");
  assert.equal((await post("admin", "/api/retakes/" + job.id + "/confirm")).statusCode, 409, "a declined photo is not confirmed");
  assert.equal((await post("alice", "/api/retakes/" + job.id + "/discard")).json().status, "discarded", "the owner clears the declined photo");

  const second = (await upload("alice")).json();
  validate(second.id);
  await post("alice", "/api/retakes/" + second.id + "/submit");
  const ok = await post("admin", "/api/retakes/" + second.id + "/confirm");
  assert.equal(ok.json().status, "confirmed");
  assert.equal(ok.json().message, "approved; queued for the worker");
  assert.equal(ok.json().decidedBy.username, "admin");
  const late = await post("alice", "/api/retakes/" + second.id + "/discard");
  assert.equal(late.statusCode, 403, "a confirmed retake is the admin's to stop");
});

test("approvals: an admin's own photo is confirmed directly; admin-only actions refuse users", async () => {
  const { upload, post, validate } = await approvalsApp();
  const mine = (await upload("admin")).json();
  validate(mine.id);
  assert.equal((await post("admin", "/api/retakes/" + mine.id + "/confirm")).json().message, "confirmed; queued for the worker");
  assert.equal((await post("alice", "/api/retakes/" + mine.id + "/retry")).statusCode, 403);
  assert.equal((await post("alice", "/api/retakes/rollback", { book: "vol1", page: 289 })).statusCode, 403);
  assert.equal((await post("alice", "/api/retakes/accept", { book: "vol1", page: 289, accepted: true })).statusCode, 403);
});

test("approvals: a batch is submitted and approved together; only the user's own photos are submitted", async () => {
  const { upload, post, validate } = await approvalsApp();
  const a1 = (await upload("alice", "b2")).json();
  const a2 = (await upload("alice", "b2")).json();
  const b1 = (await upload("bob", "b2")).json();
  for (const j of [a1, a2, b1]) validate(j.id);
  const sub = await post("alice", "/api/retakes/batches/b2/submit");
  assert.deepEqual(sub.json().map((j: { id: string }) => j.id).sort(), [a1.id, a2.id].sort());
  assert.equal((await post("alice", "/api/retakes/batches/b2/confirm")).statusCode, 403);
  const ok = await post("admin", "/api/retakes/batches/b2/confirm");
  assert.equal(ok.json().length, 3, "the admin confirms the submitted and the still-validated photo");
  assert.ok(ok.json().every((j: { status: string }) => j.status === "confirmed"));
  assert.equal((await post("admin", "/api/retakes/batches/b2/decline")).statusCode, 409);
});

test("approvals: RETAKE_TOKEN has admin rights; a user has at most 50 open photos", async () => {
  const { jobs, upload, post, validate } = await approvalsApp("s3cret");
  const j = (await upload("alice")).json();
  validate(j.id);
  await post("alice", "/api/retakes/" + j.id + "/submit");
  const viaToken = await post(null, "/api/retakes/" + j.id + "/confirm", undefined, { "x-retake-token": "s3cret" });
  assert.equal(viaToken.statusCode, 200, viaToken.body);
  assert.equal(viaToken.json().decidedBy, null, "the token is nobody in particular");
  assert.equal((await post(null, "/api/retakes/" + j.id + "/retry", undefined, { "x-retake-token": "wrong" })).statusCode, 401);

  const aliceId = jobs.get(j.id)!["uploaded_by"];
  for (let i = 0; i < 50; i++) jobs.set("open-" + i, { id: "open-" + i, uploaded_by: aliceId, status: "validated" });
  const full = await upload("alice");
  assert.equal(full.statusCode, 429);
  assert.equal((await upload("admin")).statusCode, 201, "admins are not limited");
});
