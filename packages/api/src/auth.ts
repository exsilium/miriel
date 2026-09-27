/**
 * Sessions, login and the AUTH_REQUIRED gate (docs/build-spec-checklist.md §3 decisions 7-8).
 *
 *   POST /api/auth/login     {username, password}   -> {user}; sets the session cookie
 *   POST /api/auth/logout                           -> {ok}; ends the session
 *   GET  /api/auth/me                               -> {user | null, authRequired}
 *   POST /api/auth/password  {current, next}        -> {user}; ends the user's other sessions
 *
 * The session cookie (httpOnly, SameSite=Lax, Secure with COOKIE_SECURE=true) lasts SESSION_DAYS and is renewed
 * when used, at most once per TOUCH_MS. A request authenticated by the cookie that changes state (not GET/HEAD)
 * must carry `x-miriel: 1`, which a cross-site form cannot send. Failed logins are limited per username and per
 * client address. With AUTH_REQUIRED=true every /api route except /api/health and /api/auth/* needs a user whose
 * password is not a temporary one.
 */
import {
  AccountError,
  checkPassword,
  hashPassword,
  newSessionToken,
  normalizeUsername,
  sessionId,
  verifyPassword,
  type AuthStore,
  type Role,
  type SessionUser,
} from "@miriel/shared/users";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpProblem } from "./problem.js";
import { parse } from "./routes/books.js";

export const SESSION_COOKIE = "miriel_session";
export const CSRF_HEADER = "x-miriel";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
/** Renew a session's expiry at most this often (one UPDATE per session and hour, not per request). */
const TOUCH_MS = 3600 * 1000;
/** Resolved sessions are cached this long, so a page with 40 thumbnails costs one lookup. */
const CACHE_MS = 15 * 1000;

export interface AuthConfig {
  store: AuthStore;
  /** AUTH_REQUIRED: every api route needs a login. */
  required: boolean;
  /** COOKIE_SECURE: send the cookie only over https. */
  cookieSecure: boolean;
}

/** What routes see of the logged-in user. */
export interface RequestUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

export function publicUser(u: RequestUser | null): { id: string; username: string; role: Role; mustChangePassword: boolean } | null {
  return u ? { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword } : null;
}

// ---------------------------------------------------------------- login rate limit

/** Sliding-window limit on failed logins: per username and per client address. */
export class LoginLimiter {
  private readonly fails = new Map<string, number[]>();

  constructor(
    readonly windowMs = 15 * 60 * 1000,
    readonly perUser = 5,
    readonly perAddress = 20,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }

  /** Seconds until the next attempt is allowed, or 0. */
  retryAfter(username: string, address: string): number {
    const checks: [string, number][] = [["u:" + username, this.perUser], ["a:" + address, this.perAddress]];
    let wait = 0;
    for (const [key, max] of checks) {
      const list = this.recent(key);
      if (list.length >= max) wait = Math.max(wait, Math.ceil((list[list.length - max]! + this.windowMs - this.now()) / 1000));
    }
    return wait;
  }

  fail(username: string, address: string): void {
    for (const key of ["u:" + username, "a:" + address]) this.fails.set(key, [...this.recent(key), this.now()]);
  }

  succeed(username: string): void {
    this.fails.delete("u:" + username);
  }
}

// ---------------------------------------------------------------- cookies

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function sessionCookie(value: string, maxAgeS: number, secure: boolean): string {
  return [SESSION_COOKIE + "=" + value, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + maxAgeS, ...(secure ? ["Secure"] : [])].join("; ");
}

// ---------------------------------------------------------------- guards for routes

export function requireUser(request: FastifyRequest): RequestUser {
  const u = request.user;
  if (!u) throw new HttpProblem(401, "Login required", "Log in to use this.");
  if (u.mustChangePassword) {
    throw new HttpProblem(403, "Password change required", "Set a new password first.", { code: "password_change_required" });
  }
  return u;
}

export function requireAdmin(request: FastifyRequest): RequestUser {
  const u = requireUser(request);
  if (u.role !== "admin") throw new HttpProblem(403, "Admins only", "This needs an admin account.");
  return u;
}

/** AccountError -> problem details (400 / 404 / 409). */
export function accountProblem(err: unknown): never {
  if (err instanceof AccountError) {
    const status = err.code === "not_found" ? 404 : err.code === "exists" || err.code === "last_admin" || err.code === "self" ? 409 : 400;
    throw new HttpProblem(status, err.code === "not_found" ? "Not found" : "Not allowed", err.message, { code: err.code });
  }
  throw err;
}

// ---------------------------------------------------------------- hook + routes

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(500) });
const PasswordBody = z.object({ current: z.string().min(1).max(500), next: z.string().min(1).max(500) });

const OPEN_WHEN_REQUIRED = (url: string): boolean => url === "/api/health" || url.startsWith("/api/auth/");

export interface AuthRuntime {
  /** Drop cached sessions of a user (after disable, reset or delete). */
  forget(userId: string): void;
}

export function registerAuth(app: FastifyInstance, cfg: AuthConfig, limiter = new LoginLimiter()): AuthRuntime {
  const { store } = cfg;
  const cache = new Map<string, { user: SessionUser | null; at: number }>();
  const forget = (userId: string): void => {
    for (const [k, v] of cache) if (v.user?.id === userId) cache.delete(k);
  };

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request, reply) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      const sid = sessionId(token);
      const hit = cache.get(sid);
      let user: SessionUser | null;
      if (hit && Date.now() - hit.at < CACHE_MS) user = hit.user;
      else {
        user = await store.sessionUser(sid);
        cache.set(sid, { user, at: Date.now() });
        if (cache.size > 5000) cache.clear();
      }
      if (user && user.expiresAt.getTime() > Date.now()) {
        if (Date.now() - user.lastSeenAt.getTime() > TOUCH_MS) {
          const expiresAt = new Date(Date.now() + SESSION_MS);
          await store.touchSession(sid, expiresAt);
          user.lastSeenAt = new Date();
          user.expiresAt = expiresAt;
          void reply.header("set-cookie", sessionCookie(token, SESSION_MS / 1000, cfg.cookieSecure));
        }
        request.user = { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword, sessionId: sid };
        const method = request.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !request.headers[CSRF_HEADER]) {
          throw new HttpProblem(403, "Missing " + CSRF_HEADER + " header", "Requests that change data must send '" + CSRF_HEADER + ": 1'.");
        }
      }
    }
    const url = request.url.split("?")[0]!;
    if (cfg.required && url.startsWith("/api/") && !OPEN_WHEN_REQUIRED(url)) requireUser(request);
  });

  app.get("/api/auth/me", async (request) => ({ user: publicUser(request.user), authRequired: cfg.required }));

  app.post("/api/auth/login", async (request, reply) => {
    const body = parse(LoginBody, request.body);
    const username = normalizeUsername(body.username);
    const wait = limiter.retryAfter(username, request.ip);
    if (wait > 0) {
      void reply.header("retry-after", String(wait));
      throw new HttpProblem(429, "Too many attempts", "Too many failed logins; try again in " + Math.ceil(wait / 60) + " minute(s).");
    }
    const found = await store.findForLogin(username);
    // verify even for unknown users, so the response time does not reveal which usernames exist
    const ok = await verifyPassword(body.password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok || found.disabled) {
      limiter.fail(username, request.ip);
      throw new HttpProblem(401, "Login failed", "Wrong username or password, or the account is disabled.");
    }
    limiter.succeed(username);
    const token = newSessionToken();
    const sid = sessionId(token);
    await store.createSession({ id: sid, userId: found.id, expiresAt: new Date(Date.now() + SESSION_MS), userAgent: request.headers["user-agent"]?.slice(0, 200) ?? null });
    await store.recordLogin(found.id);
    const user = await store.getUser(found.id);
    void reply.header("set-cookie", sessionCookie(token, SESSION_MS / 1000, cfg.cookieSecure));
    return { user: user && { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.user) {
      await store.deleteSession(request.user.sessionId);
      cache.delete(request.user.sessionId);
    }
    void reply.header("set-cookie", sessionCookie("", 0, cfg.cookieSecure));
    return { ok: true };
  });

  app.post("/api/auth/password", async (request) => {
    const u = request.user;
    if (!u) throw new HttpProblem(401, "Login required", "Log in to change your password.");
    const body = parse(PasswordBody, request.body);
    const hash = await store.passwordHash(u.id);
    if (!hash || !(await verifyPassword(body.current, hash))) {
      throw new HttpProblem(400, "Wrong password", "The current password is not right.", { code: "wrong_password" });
    }
    if (body.next === body.current) throw new HttpProblem(400, "Same password", "Choose a password different from the current one.", { code: "weak_password" });
    try {
      checkPassword(body.next);
    } catch (err) {
      accountProblem(err);
    }
    const user = await store.updateUser(u.id, { passwordHash: await hashPassword(body.next), mustChangePassword: false });
    await store.deleteUserSessions(u.id, u.sessionId);
    forget(u.id);
    return { user: user && { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword } };
  });

  return { forget };
}

/** A valid scrypt hash of a random string: verified against when the username does not exist. */
const DUMMY_HASH = await hashPassword(newSessionToken());
