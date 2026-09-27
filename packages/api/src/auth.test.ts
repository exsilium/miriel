import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "@miriel/shared/db";
import { hashPassword, memoryAuthStore, type Role } from "@miriel/shared/users";
import type { FastifyInstance } from "fastify";
import { LoginLimiter, readCookie, SESSION_COOKIE } from "./auth.js";
import { buildServer, type ServerDeps } from "./server.js";

const pool = {
  async query(text: string) {
    if (text.includes("SELECT 1")) return { rows: [{ "?column?": 1 }] };
    throw new Error("fake pool: unexpected query " + text.slice(0, 60));
  },
} as unknown as Pool;

async function setup(required = false) {
  const store = memoryAuthStore();
  const deps: ServerDeps = {
    pool,
    dataDir: process.cwd(),
    retrieve: async () => {
      throw new Error("not used");
    },
    answer: async function* () {
      /* not used */
    },
    resolvePrior: async () => [],
    auth: { store, required, cookieSecure: false },
    logger: false,
  };
  const app = await buildServer(deps);
  const mk = async (username: string, password: string, role: Role, mustChangePassword = false) =>
    store.createUser({ username, role, passwordHash: await hashPassword(password), mustChangePassword });
  return { app, store, mk };
}

async function login(app: FastifyInstance, username: string, password: string): Promise<{ status: number; cookie: string | undefined; body: any }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const set = res.headers["set-cookie"];
  const header = Array.isArray(set) ? set[0] : set;
  const token = readCookie(header?.split(";")[0], SESSION_COOKIE);
  return { status: res.statusCode, cookie: token ? SESSION_COOKIE + "=" + token : undefined, body: res.json() };
}

const w = (cookie: string | undefined) => ({ cookie: cookie ?? "", "x-miriel": "1" });

// ---------------------------------------------------------------- tests

test("login sets an httpOnly session cookie; /me reports the user; logout ends the session", async () => {
  const { app, store, mk } = await setup();
  await mk("tarnished", "correct horse battery", "user");
  const r = await login(app, "Tarnished", "correct horse battery");
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, "tarnished");
  assert.ok(r.cookie);
  const raw = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "tarnished", password: "correct horse battery" } });
  assert.match(String(raw.headers["set-cookie"]), /HttpOnly; SameSite=Lax; Max-Age=2592000/);

  const me = await app.inject({ url: "/api/auth/me", headers: { cookie: r.cookie! } });
  assert.deepEqual(me.json(), { user: { id: r.body.user.id, username: "tarnished", role: "user", mustChangePassword: false }, authRequired: false });
  assert.ok([...store.users.values()][0]!.lastLoginAt);

  const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: w(r.cookie) });
  assert.equal(out.statusCode, 200);
  assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  assert.equal(store.sessions.size, 1, "only the second login's session is left");
  const after = await app.inject({ url: "/api/auth/me", headers: { cookie: r.cookie! } });
  assert.equal(after.json().user, null);
});

test("wrong password, unknown user and disabled user all fail the same way", async () => {
  const { app, store, mk } = await setup();
  const u = await mk("melina", "the kindling maiden", "user");
  for (const [name, pw] of [["melina", "wrong password!"], ["nobody", "the kindling maiden"]] as const) {
    const r = await login(app, name, pw);
    assert.equal(r.status, 401);
    assert.equal(r.body.title, "Login failed");
  }
  store.users.get(u.id)!.disabled = true;
  assert.equal((await login(app, "melina", "the kindling maiden")).status, 401);
});

test("failed logins are rate-limited per username", async () => {
  const { app, mk } = await setup();
  await mk("ranni", "the witch of the moon", "user");
  for (let i = 0; i < 5; i++) assert.equal((await login(app, "ranni", "nope nope nope")).status, 401);
  const blocked = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "ranni", password: "the witch of the moon" } });
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
});

test("LoginLimiter: window slides, success clears the username count, address limit is separate", () => {
  let now = 0;
  const lim = new LoginLimiter(1000, 2, 3, () => now);
  lim.fail("a", "ip1");
  lim.fail("a", "ip1");
  assert.ok(lim.retryAfter("a", "ip1") > 0);
  now = 1001;
  assert.equal(lim.retryAfter("a", "ip1"), 0);
  lim.fail("b", "ip2");
  lim.succeed("b");
  lim.fail("b", "ip2");
  assert.equal(lim.retryAfter("b", "ip2"), 0, "one failure since the success");
  lim.fail("c", "ip2");
  assert.ok(lim.retryAfter("d", "ip2") > 0, "3 failures from ip2 block every username from it");
});

test("a cookie-authenticated write without the x-miriel header is refused", async () => {
  const { app, mk } = await setup();
  await mk("gideon", "the all knowing one", "user");
  const r = await login(app, "gideon", "the all knowing one");
  const res = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: r.cookie! } });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().title, /x-miriel/);
});

test("AUTH_REQUIRED: api routes need a login; health and auth routes stay open", async () => {
  const { app, mk } = await setup(true);
  assert.equal((await app.inject({ url: "/api/books" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  assert.deepEqual((await app.inject({ url: "/api/auth/me" })).json(), { user: null, authRequired: true });
  await mk("fia", "the deathbed companion", "user", true);
  const r = await login(app, "fia", "the deathbed companion");
  const blocked = await app.inject({ url: "/api/admin/users", headers: { cookie: r.cookie! } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().code, "password_change_required");

  const bad = await app.inject({ method: "POST", url: "/api/auth/password", headers: w(r.cookie), payload: { current: "the deathbed companion", next: "short" } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: "/api/auth/password", headers: w(r.cookie), payload: { current: "the deathbed companion", next: "a much longer secret" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.mustChangePassword, false);
  const now = await app.inject({ url: "/api/admin/users", headers: { cookie: r.cookie! } });
  assert.equal(now.statusCode, 403, "logged in with a real password now, but not an admin");
  assert.equal(now.json().title, "Admins only");
});

test("changing the password ends the user's other sessions", async () => {
  const { app, mk } = await setup();
  await mk("patches", "the untethered", "user");
  const a = await login(app, "patches", "the untethered");
  const b = await login(app, "patches", "the untethered");
  const res = await app.inject({ method: "POST", url: "/api/auth/password", headers: w(a.cookie), payload: { current: "the untethered", next: "a new password here" } });
  assert.equal(res.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie: a.cookie! } })).json().user?.username, "patches");
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie: b.cookie! } })).json().user, null);
  const wrong = await app.inject({ method: "POST", url: "/api/auth/password", headers: w(a.cookie), payload: { current: "the untethered", next: "another password x" } });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().code, "wrong_password");
});

test("admin: create a user with a one-time password, reset, disable, delete; guards on self and the last admin", async () => {
  const { app, store, mk } = await setup();
  const admin = await mk("admin", "admin password 1", "admin");
  const a = await login(app, "admin", "admin password 1");

  const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: w(a.cookie), payload: { username: "Latenna", role: "user" } });
  assert.equal(created.statusCode, 200);
  const { user, password } = created.json();
  assert.equal(user.username, "latenna");
  assert.equal(user.mustChangePassword, true);
  assert.match(password, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.equal(store.runs.filter((r) => r.startsWith(user.id)).length, 1, "a first run is created");
  const dup = await app.inject({ method: "POST", url: "/api/admin/users", headers: w(a.cookie), payload: { username: "latenna" } });
  assert.equal(dup.statusCode, 409);
  const badName = await app.inject({ method: "POST", url: "/api/admin/users", headers: w(a.cookie), payload: { username: "x" } });
  assert.equal(badName.statusCode, 400);

  const l = await login(app, "latenna", password);
  assert.equal(l.status, 200);
  assert.equal(l.body.user.mustChangePassword, true);

  const list = (await app.inject({ url: "/api/admin/users", headers: { cookie: a.cookie! } })).json().users;
  assert.deepEqual(list.map((u: { username: string; runs: number }) => [u.username, u.runs]), [["admin", 1], ["latenna", 1]]);

  const reset = await app.inject({ method: "PATCH", url: "/api/admin/users/" + user.id, headers: w(a.cookie), payload: { resetPassword: true } });
  assert.equal(reset.statusCode, 200);
  assert.notEqual(reset.json().password, password);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie: l.cookie! } })).json().user, null, "reset ends the sessions");
  assert.equal((await login(app, "latenna", password)).status, 401, "the old password no longer works");

  const l2 = await login(app, "latenna", reset.json().password);
  const dis = await app.inject({ method: "PATCH", url: "/api/admin/users/" + user.id, headers: w(a.cookie), payload: { disabled: true } });
  assert.equal(dis.json().user.disabled, true);
  assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie: l2.cookie! } })).json().user, null, "disable ends the sessions");

  const self = await app.inject({ method: "PATCH", url: "/api/admin/users/" + admin.id, headers: w(a.cookie), payload: { role: "user" } });
  assert.equal(self.statusCode, 409);
  assert.equal(self.json().code, "self");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/admin/users/" + admin.id, headers: w(a.cookie) })).statusCode, 409);

  // re-enable and promote; with two active admins, deleting one of them is allowed
  const promote = await app.inject({ method: "PATCH", url: "/api/admin/users/" + user.id, headers: w(a.cookie), payload: { role: "admin", disabled: false } });
  assert.equal(promote.json().user.role, "admin");
  const del = await app.inject({ method: "DELETE", url: "/api/admin/users/" + user.id, headers: w(a.cookie) });
  assert.equal(del.statusCode, 200);
  assert.equal(store.users.size, 1);
  const missing = await app.inject({ method: "DELETE", url: "/api/admin/users/" + user.id, headers: w(a.cookie) });
  assert.equal(missing.statusCode, 404);
});

test("the last active admin cannot be demoted, disabled or deleted", async () => {
  const { store } = await setup();
  const { changeUser, removeUser } = await import("@miriel/shared/users");
  const only = await store.createUser({ username: "admin", role: "admin", passwordHash: "x", mustChangePassword: false });
  await assert.rejects(changeUser(store, only.id, { role: "user" }), /last active admin/);
  await assert.rejects(changeUser(store, only.id, { disabled: true }), /last active admin/);
  await assert.rejects(removeUser(store, only.id), /last active admin/);
  const second = await store.createUser({ username: "admin2", role: "admin", passwordHash: "x", mustChangePassword: false });
  assert.equal((await changeUser(store, only.id, { role: "user" })).role, "user");
  await assert.rejects(removeUser(store, second.id), /last active admin/);
});

test("non-admins get 403 on admin routes, anonymous 401", async () => {
  const { app, mk } = await setup();
  await mk("boc", "the seamster demi", "user");
  const b = await login(app, "boc", "the seamster demi");
  assert.equal((await app.inject({ url: "/api/admin/users", headers: { cookie: b.cookie! } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/admin/users" })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/admin/users", headers: w(b.cookie), payload: { username: "x1234" } })).statusCode, 403);
});
