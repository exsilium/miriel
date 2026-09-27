/**
 * Client for /api/auth and /api/admin/users (packages/api/src/auth.ts, routes/admin.ts).
 */
import { noteUnauthorized, problemMessage, WRITE_HEADER } from "../api.js";

export type Role = "admin" | "user";

export interface User {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface Me {
  user: User | null;
  authRequired: boolean;
}

export interface AdminUser extends User {
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  runs: number;
  sessions: number;
  /** Checklist items ticked over all runs. */
  done: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { ...WRITE_HEADER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) {
    // /api/auth/me never answers 401; for the others a 401 means the session ended
    noteUnauthorized(res);
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const p = (await res.clone().json()) as { detail?: string; code?: string };
      code = p.code;
      detail = p.detail;
    } catch {
      /* not problem+json */
    }
    throw new ApiError(detail ?? (await problemMessage(res)), res.status, code);
  }
  return (await res.json()) as T;
}

export const fetchMe = (): Promise<Me> => call<Me>("/api/auth/me");
export const login = (username: string, password: string): Promise<{ user: User }> => call("/api/auth/login", "POST", { username, password });
export const logout = (): Promise<{ ok: true }> => call("/api/auth/logout", "POST");
export const changePassword = (current: string, next: string): Promise<{ user: User }> => call("/api/auth/password", "POST", { current, next });

export const listUsers = (): Promise<{ users: AdminUser[] }> => call("/api/admin/users");
export const createUser = (username: string, role: Role): Promise<{ user: AdminUser; password: string }> =>
  call("/api/admin/users", "POST", { username, role });
export const updateUser = (
  id: string,
  patch: { role?: Role; disabled?: boolean; resetPassword?: true },
): Promise<{ user: AdminUser; password?: string }> => call("/api/admin/users/" + encodeURIComponent(id), "PATCH", patch);
export const deleteUser = (id: string): Promise<{ ok: true }> => call("/api/admin/users/" + encodeURIComponent(id), "DELETE");
