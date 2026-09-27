/**
 * User accounts (docs/build-spec-checklist.md §3 decisions 7-11; tables in db/migrations/0008_accounts.sql).
 * Exported from the "@miriel/shared/users" subpath: it needs `pg` and node:crypto, like "@miriel/shared/db".
 *
 * The AuthStore interface is everything the api and the `indexer user` CLI need; pgAuthStore() is the Postgres
 * implementation and the api tests use an in-memory one. Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key,
 * 16-byte salt), stored as "scrypt$N$r$p$<salt b64>$<hash b64>". Session tokens: 32 random bytes (base64url)
 * in the cookie, only their sha256 in the database.
 */
import { createHash, randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Pool } from "pg";

export type Role = "admin" | "user";

export interface UserRow {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AdminUserRow extends UserRow {
  runs: number;
  sessions: number;
  /** Checklist items ticked, over all the user's runs. */
  done: number;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

export class AccountError extends Error {
  constructor(
    readonly code: "invalid_username" | "weak_password" | "exists" | "not_found" | "last_admin" | "self",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

export function checkUsername(name: string): string {
  const u = normalizeUsername(name);
  if (!USERNAME_RE.test(u)) {
    throw new AccountError("invalid_username", "Usernames are 3-32 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.");
  }
  return u;
}

export function checkPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) throw new AccountError("weak_password", "Passwords need at least " + PASSWORD_MIN + " characters.");
  if (pw.length > PASSWORD_MAX) throw new AccountError("weak_password", "Passwords are at most " + PASSWORD_MAX + " characters.");
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

const maxmem = (N: number, r: number): number => 128 * N * r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(password, salt, keylen, { N, r, p, maxmem: maxmem(N, r) });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, "base64");
  const want = Buffer.from(parts[5]!, "base64");
  const got = await scrypt(password, salt, want.length, { N, r, p, maxmem: maxmem(N, r) });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A temporary password an admin hands over: 4 groups of 4, no look-alike characters (0/o, 1/l/i). */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(""));
  return groups.join("-");
}

// ---------------------------------------------------------------- sessions

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

// ---------------------------------------------------------------- store

export interface AuthStore {
  /** Login lookup by (normalised) username, including disabled users. */
  findForLogin(username: string): Promise<{ id: string; passwordHash: string; disabled: boolean } | null>;
  getUser(id: string): Promise<UserRow | null>;
  passwordHash(id: string): Promise<string | null>;
  /** Creates the user and its first run ("Tarnished 1"). */
  createUser(input: { username: string; role: Role; passwordHash: string; mustChangePassword: boolean }): Promise<UserRow>;
  updateUser(
    id: string,
    patch: { role?: Role | undefined; disabled?: boolean | undefined; passwordHash?: string | undefined; mustChangePassword?: boolean | undefined },
  ): Promise<UserRow | null>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(): Promise<AdminUserRow[]>;
  /** Active (not disabled) admins. */
  countActiveAdmins(): Promise<number>;
  recordLogin(id: string): Promise<void>;

  createSession(input: { id: string; userId: string; expiresAt: Date; userAgent: string | null }): Promise<void>;
  /** The session's user, when the session has not expired and the user is not disabled. */
  sessionUser(id: string): Promise<SessionUser | null>;
  touchSession(id: string, expiresAt: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** All sessions of a user, except `keep`. */
  deleteUserSessions(userId: string, keep?: string): Promise<void>;
}

export const FIRST_RUN_NAME = "Tarnished 1";

interface UserDbRow {
  id: string;
  username: string;
  role: Role;
  must_change_password: boolean;
  disabled_at: Date | null;
  created_at: Date;
  last_login_at: Date | null;
}

const USER_COLUMNS = "id, username, role, must_change_password, disabled_at, created_at, last_login_at";

function toUser(r: UserDbRow): UserRow {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    mustChangePassword: r.must_change_password,
    disabled: r.disabled_at !== null,
    createdAt: r.created_at.toISOString(),
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
  };
}

export function pgAuthStore(pool: Pool): AuthStore {
  return {
    async findForLogin(username) {
      const { rows } = await pool.query<{ id: string; password_hash: string; disabled_at: Date | null }>(
        "SELECT id, password_hash, disabled_at FROM users WHERE username = $1",
        [username],
      );
      const r = rows[0];
      return r ? { id: r.id, passwordHash: r.password_hash, disabled: r.disabled_at !== null } : null;
    },

    async getUser(id) {
      const { rows } = await pool.query<UserDbRow>("SELECT " + USER_COLUMNS + " FROM users WHERE id = $1", [id]);
      return rows[0] ? toUser(rows[0]) : null;
    },

    async passwordHash(id) {
      const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [id]);
      return rows[0]?.password_hash ?? null;
    },

    async createUser(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<UserDbRow>(
          "INSERT INTO users (username, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4) RETURNING " + USER_COLUMNS,
          [input.username, input.role, input.passwordHash, input.mustChangePassword],
        );
        await client.query("INSERT INTO runs (user_id, name) VALUES ($1, $2)", [rows[0]!.id, FIRST_RUN_NAME]);
        await client.query("COMMIT");
        return toUser(rows[0]!);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        if ((err as { code?: string }).code === "23505") throw new AccountError("exists", "The username " + input.username + " is taken.");
        throw err;
      } finally {
        client.release();
      }
    },

    async updateUser(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (col: string, v: unknown): void => {
        params.push(v);
        sets.push(col + " = $" + params.length);
      };
      if (patch.role !== undefined) set("role", patch.role);
      if (patch.disabled !== undefined) sets.push(patch.disabled ? "disabled_at = coalesce(disabled_at, now())" : "disabled_at = NULL");
      if (patch.passwordHash !== undefined) set("password_hash", patch.passwordHash);
      if (patch.mustChangePassword !== undefined) set("must_change_password", patch.mustChangePassword);
      if (!sets.length) return this.getUser(id);
      const { rows } = await pool.query<UserDbRow>("UPDATE users SET " + sets.join(", ") + " WHERE id = $1 RETURNING " + USER_COLUMNS, params);
      return rows[0] ? toUser(rows[0]) : null;
    },

    async deleteUser(id) {
      const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [id]);
      return (rowCount ?? 0) > 0;
    },

    async listUsers() {
      const { rows } = await pool.query<UserDbRow & { runs: string; sessions: string; done: string }>(
        "SELECT " + USER_COLUMNS.split(", ").map((c) => "u." + c).join(", ") + "," +
          " (SELECT count(*) FROM runs r WHERE r.user_id = u.id) AS runs," +
          " (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions," +
          " (SELECT count(*) FROM progress p JOIN runs r ON r.id = p.run_id WHERE r.user_id = u.id) AS done" +
          " FROM users u ORDER BY u.username",
      );
      return rows.map((r) => ({ ...toUser(r), runs: Number(r.runs), sessions: Number(r.sessions), done: Number(r.done) }));
    },

    async countActiveAdmins() {
      const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
      return Number(rows[0]?.n ?? 0);
    },

    async recordLogin(id) {
      await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [id]);
    },

    async createSession(input) {
      await pool.query("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)", [
        input.id,
        input.userId,
        input.expiresAt,
        input.userAgent,
      ]);
      // housekeeping: expired sessions are useless; drop them when someone logs in
      await pool.query("DELETE FROM sessions WHERE expires_at < now()");
    },

    async sessionUser(id) {
      const { rows } = await pool.query<{
        id: string;
        username: string;
        role: Role;
        must_change_password: boolean;
        expires_at: Date;
        last_seen_at: Date;
      }>(
        "SELECT u.id, u.username, u.role, u.must_change_password, s.expires_at, s.last_seen_at FROM sessions s" +
          " JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL",
        [id],
      );
      const r = rows[0];
      return r
        ? { id: r.id, username: r.username, role: r.role, mustChangePassword: r.must_change_password, sessionId: id, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at }
        : null;
    },

    async touchSession(id, expiresAt) {
      await pool.query("UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1", [id, expiresAt]);
    },

    async deleteSession(id) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [id]);
    },

    async deleteUserSessions(userId, keep) {
      if (keep) await pool.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, keep]);
      else await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    },
  };
}

// ---------------------------------------------------------------- account operations (api + CLI)

/** Creates a user with a temporary password (generated unless given); they must change it at first login. */
export async function addUser(
  store: AuthStore,
  input: { username: string; role: Role; password?: string | undefined },
): Promise<{ user: UserRow; password: string }> {
  const username = checkUsername(input.username);
  const password = input.password ?? generatePassword();
  if (input.password !== undefined) checkPassword(password);
  const user = await store.createUser({ username, role: input.role, passwordHash: await hashPassword(password), mustChangePassword: true });
  return { user, password };
}

/** New temporary password; every session of the user ends. */
export async function resetUserPassword(store: AuthStore, id: string): Promise<{ user: UserRow; password: string }> {
  const password = generatePassword();
  const user = await store.updateUser(id, { passwordHash: await hashPassword(password), mustChangePassword: true });
  if (!user) throw new AccountError("not_found", "No such user.");
  await store.deleteUserSessions(id);
  return { user, password };
}

/**
 * Changes the role or the disabled flag, refusing to leave no active admin and (with `actorId`) to demote,
 * disable or delete oneself. Disabling ends the user's sessions.
 */
export async function changeUser(
  store: AuthStore,
  id: string,
  patch: { role?: Role | undefined; disabled?: boolean | undefined },
  actorId?: string,
): Promise<UserRow> {
  const user = await store.getUser(id);
  if (!user) throw new AccountError("not_found", "No such user.");
  const demote = patch.role === "user" && user.role === "admin";
  const disable = patch.disabled === true && !user.disabled;
  if (actorId === id && (demote || disable)) throw new AccountError("self", "You cannot demote or disable your own account.");
  if (user.role === "admin" && !user.disabled && (demote || disable) && (await store.countActiveAdmins()) <= 1) {
    throw new AccountError("last_admin", "This is the last active admin; make another user admin first.");
  }
  const updated = await store.updateUser(id, patch);
  if (!updated) throw new AccountError("not_found", "No such user.");
  if (disable) await store.deleteUserSessions(id);
  return updated;
}

export async function removeUser(store: AuthStore, id: string, actorId?: string): Promise<void> {
  const user = await store.getUser(id);
  if (!user) throw new AccountError("not_found", "No such user.");
  if (actorId === id) throw new AccountError("self", "You cannot delete your own account.");
  if (user.role === "admin" && !user.disabled && (await store.countActiveAdmins()) <= 1) {
    throw new AccountError("last_admin", "This is the last active admin; make another user admin first.");
  }
  await store.deleteUser(id);
}

// ---------------------------------------------------------------- in-memory store (tests)

interface MemUser extends UserRow {
  passwordHash: string;
}

/** An AuthStore in memory, for tests; the maps are exposed for assertions. */
export function memoryAuthStore(): AuthStore & { users: Map<string, MemUser>; sessions: Map<string, { userId: string; expiresAt: Date; lastSeenAt: Date }>; runs: string[] } {
  const users = new Map<string, MemUser>();
  const sessions = new Map<string, { userId: string; expiresAt: Date; lastSeenAt: Date }>();
  const runs: string[] = [];
  const pub = (u: MemUser): UserRow => {
    const { passwordHash: _h, ...rest } = u;
    return { ...rest };
  };
  return {
    users,
    sessions,
    runs,
    async findForLogin(username) {
      const u = [...users.values()].find((x) => x.username === username);
      return u ? { id: u.id, passwordHash: u.passwordHash, disabled: u.disabled } : null;
    },
    async getUser(id) {
      const u = users.get(id);
      return u ? pub(u) : null;
    },
    async passwordHash(id) {
      return users.get(id)?.passwordHash ?? null;
    },
    async createUser(input) {
      if ([...users.values()].some((u) => u.username === input.username)) throw new AccountError("exists", "The username " + input.username + " is taken.");
      const u: MemUser = {
        id: randomUUID(),
        username: input.username,
        role: input.role,
        mustChangePassword: input.mustChangePassword,
        disabled: false,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
        passwordHash: input.passwordHash,
      };
      users.set(u.id, u);
      runs.push(u.id + ":" + FIRST_RUN_NAME);
      return pub(u);
    },
    async updateUser(id, patch) {
      const u = users.get(id);
      if (!u) return null;
      if (patch.role !== undefined) u.role = patch.role;
      if (patch.disabled !== undefined) u.disabled = patch.disabled;
      if (patch.passwordHash !== undefined) u.passwordHash = patch.passwordHash;
      if (patch.mustChangePassword !== undefined) u.mustChangePassword = patch.mustChangePassword;
      return pub(u);
    },
    async deleteUser(id) {
      for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k);
      return users.delete(id);
    },
    async listUsers(): Promise<AdminUserRow[]> {
      return [...users.values()].map((u) => ({ ...pub(u), runs: runs.filter((r) => r.startsWith(u.id)).length, sessions: [...sessions.values()].filter((s) => s.userId === u.id).length, done: 0 }));
    },
    async countActiveAdmins() {
      return [...users.values()].filter((u) => u.role === "admin" && !u.disabled).length;
    },
    async recordLogin(id) {
      const u = users.get(id);
      if (u) u.lastLoginAt = new Date().toISOString();
    },
    async createSession(input) {
      sessions.set(input.id, { userId: input.userId, expiresAt: input.expiresAt, lastSeenAt: new Date() });
    },
    async sessionUser(id): Promise<SessionUser | null> {
      const s = sessions.get(id);
      const u = s && users.get(s.userId);
      if (!s || !u || u.disabled || s.expiresAt.getTime() <= Date.now()) return null;
      return { id: u.id, username: u.username, role: u.role, mustChangePassword: u.mustChangePassword, sessionId: id, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt };
    },
    async touchSession(id, expiresAt) {
      const s = sessions.get(id);
      if (s) Object.assign(s, { expiresAt, lastSeenAt: new Date() });
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async deleteUserSessions(userId, keep) {
      for (const [k, s] of sessions) if (s.userId === userId && k !== keep) sessions.delete(k);
    },
  };
}
