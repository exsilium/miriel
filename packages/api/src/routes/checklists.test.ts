import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "@miriel/shared/db";
import { hashPassword, memoryAuthStore } from "@miriel/shared/users";
import { RunNameTaken, type ChecklistDetail, type ChecklistItemOut, type ChecklistStore, type RunOut } from "../checklists.js";
import { buildServer } from "../server.js";

const item = (id: string, ord: number): ChecklistItemOut => ({
  id, ord, section: "limgrave", path: ["Limgrave"], text: "Talk to **Boc**", prompt: "[Limgrave] Talk to Boc", optional: false,
  collectible: null, footnote: null, chain: null, npcs: [], pages: [{ book: "vol1", page: 369 }],
});

const MAIN: ChecklistDetail = {
  id: "main", title: "All NPC interactions", label: "Base game", author: "u/Stellarwand", sourceUrl: "https://example.org", books: ["vol1"], items: 2,
  outline: [
    { type: "heading", section: "limgrave", level: 2, title: "Limgrave", path: ["Limgrave"] },
    { type: "item", id: "m001" },
    { type: "note", section: "limgrave", text: "Note: a note." },
    { type: "item", id: "m002" },
  ],
  chains: [], footnotes: [], itemRows: [item("m001", 1), item("m002", 2)],
  retired: [{ id: "m099", text: "an old step", retiredAt: "2026-09-27T00:00:00.000Z" }],
};

/** Runs and progress in memory; one checklist. */
function memoryChecklists(): ChecklistStore & { runs: Map<string, { userId: string; name: string }> } {
  const runs = new Map<string, { userId: string; name: string }>();
  const done = new Map<string, Map<string, string>>();
  const out = (id: string): RunOut => ({
    id, name: runs.get(id)!.name, createdAt: "2026-09-27T00:00:00.000Z",
    done: { main: [...(done.get(id)?.keys() ?? [])].filter((k) => MAIN.itemRows.some((i) => i.id === k)).length },
  });
  return {
    runs,
    async listChecklists() {
      const { outline: _o, chains: _c, footnotes: _f, itemRows: _i, retired: _r, ...s } = MAIN;
      return [s];
    },
    async getChecklist(id) {
      return id === "main" ? MAIN : null;
    },
    async itemExists(itemId) {
      return MAIN.itemRows.some((i) => i.id === itemId);
    },
    async listRuns(userId) {
      return [...runs].filter(([, r]) => r.userId === userId).map(([id]) => out(id));
    },
    async runOwner(runId) {
      return runs.get(runId)?.userId ?? null;
    },
    async createRun(userId, name) {
      if ([...runs.values()].some((r) => r.userId === userId && r.name === name)) throw new RunNameTaken(name);
      const id = randomUUID();
      runs.set(id, { userId, name });
      return out(id);
    },
    async renameRun(runId, name) {
      const r = runs.get(runId)!;
      if ([...runs].some(([k, x]) => k !== runId && x.userId === r.userId && x.name === name)) throw new RunNameTaken(name);
      r.name = name;
      return out(runId);
    },
    async deleteRun(runId) {
      runs.delete(runId);
      done.delete(runId);
    },
    async progress(runId) {
      return Object.fromEntries(done.get(runId) ?? []);
    },
    async setDone(runId, itemId, isDone) {
      const m = done.get(runId) ?? new Map<string, string>();
      done.set(runId, m);
      if (!isDone) {
        m.delete(itemId);
        return null;
      }
      if (!m.has(itemId)) m.set(itemId, new Date().toISOString());
      return m.get(itemId)!;
    },
  };
}

async function setup() {
  const store = memoryAuthStore();
  const checklists = memoryChecklists();
  const app = await buildServer({
    pool: {} as Pool,
    dataDir: process.cwd(),
    logger: false,
    retrieve: async () => { throw new Error("unused"); },
    answer: async function* () { /* unused */ },
    resolvePrior: async () => [],
    auth: { store, required: false, cookieSecure: false },
    checklists,
  });
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const name of ["alice", "bob"]) {
    const u = await store.createUser({ username: name, role: "user", passwordHash: await hashPassword(name + " password"), mustChangePassword: false });
    ids[name] = u.id;
    await checklists.createRun(u.id, "Tarnished 1");
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: name, password: name + " password" } });
    cookies[name] = String(res.headers["set-cookie"]).split(";")[0]!;
  }
  const as = (who: string) => ({ cookie: cookies[who]!, "x-miriel": "1" });
  const runOf = async (who: string) => (await app.inject({ url: "/api/runs", headers: as(who) })).json().runs[0].id as string;
  return { app, as, runOf, ids };
}

test("checklists are readable without a login; the outline carries the items in file order", async () => {
  const { app } = await setup();
  const list = (await app.inject({ url: "/api/checklists" })).json().checklists;
  assert.deepEqual(list.map((c: { id: string; items: number; author: string }) => [c.id, c.items, c.author]), [["main", 2, "u/Stellarwand"]]);
  const detail = (await app.inject({ url: "/api/checklists/main" })).json();
  assert.deepEqual(detail.outline.map((r: { type: string; id?: string }) => r.type + (r.id ? ":" + r.id : "")), ["heading", "item:m001", "note", "item:m002"]);
  assert.equal(detail.outline[1].prompt, "[Limgrave] Talk to Boc");
  assert.deepEqual(detail.outline[1].pages, [{ book: "vol1", page: 369 }]);
  assert.equal(detail.retired[0].id, "m099");
  assert.equal((await app.inject({ url: "/api/checklists/nope" })).statusCode, 404);
});

test("runs: login required, create / rename / delete, names unique per user, the last run stays", async () => {
  const { app, as } = await setup();
  assert.equal((await app.inject({ url: "/api/runs" })).statusCode, 401);
  const first = (await app.inject({ url: "/api/runs", headers: as("alice") })).json().runs;
  assert.deepEqual(first.map((r: { name: string }) => r.name), ["Tarnished 1"]);
  const created = await app.inject({ method: "POST", url: "/api/runs", headers: as("alice"), payload: { name: "  NG+ " } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().name, "NG+");
  assert.equal((await app.inject({ method: "POST", url: "/api/runs", headers: as("alice"), payload: { name: "NG+" } })).statusCode, 409);
  const renamed = await app.inject({ method: "PATCH", url: "/api/runs/" + created.json().id, headers: as("alice"), payload: { name: "Second" } });
  assert.equal(renamed.json().name, "Second");
  assert.equal((await app.inject({ method: "PATCH", url: "/api/runs/" + created.json().id, headers: as("alice"), payload: { name: "Tarnished 1" } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/runs/" + created.json().id, headers: as("alice") })).statusCode, 200);
  const last = await app.inject({ method: "DELETE", url: "/api/runs/" + first[0].id, headers: as("alice") });
  assert.equal(last.statusCode, 409);
});

test("progress: tick, idempotent re-tick, untick, counts per checklist; other users' runs are invisible", async () => {
  const { app, as, runOf } = await setup();
  const run = await runOf("alice");
  const url = (item: string) => "/api/runs/" + run + "/progress/" + item;
  const t1 = await app.inject({ method: "PUT", url: url("m001"), headers: as("alice") });
  assert.equal(t1.statusCode, 200);
  assert.equal(t1.json().done, true);
  const t2 = await app.inject({ method: "PUT", url: url("m001"), headers: as("alice") });
  assert.equal(t2.json().doneAt, t1.json().doneAt, "ticking twice keeps the first time");
  assert.equal((await app.inject({ method: "PUT", url: url("m777"), headers: as("alice") })).statusCode, 404);
  assert.deepEqual(Object.keys((await app.inject({ url: "/api/runs/" + run + "/progress", headers: as("alice") })).json().done), ["m001"]);
  assert.equal((await app.inject({ url: "/api/runs", headers: as("alice") })).json().runs[0].done.main, 1);

  assert.equal((await app.inject({ url: "/api/runs/" + run + "/progress", headers: as("bob") })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: url("m002"), headers: as("bob") })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: url("m002"), headers: { cookie: as("alice").cookie } })).statusCode, 403, "writes need x-miriel");

  const un = await app.inject({ method: "DELETE", url: url("m001"), headers: as("alice") });
  assert.equal(un.json().done, false);
  assert.deepEqual((await app.inject({ url: "/api/runs/" + run + "/progress", headers: as("alice") })).json().done, {});
});
