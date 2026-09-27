/**
 * User administration (docs/build-spec-checklist.md §3 decision 10). Admins only.
 *
 *   GET    /api/admin/users              users with role, state, last login, run and session counts
 *   POST   /api/admin/users              {username, role}  -> {user, password}: a temporary password, shown once
 *   PATCH  /api/admin/users/:id          {role?, disabled?, resetPassword?}  -> {user, password?}
 *   DELETE /api/admin/users/:id          removes the user with their runs, progress and sessions
 *
 * Nobody can demote, disable or delete their own account, and the last active admin stays an admin.
 */
import { addUser, changeUser, removeUser, resetUserPassword } from "@miriel/shared/users";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { accountProblem, requireAdmin, type AuthConfig, type AuthRuntime } from "../auth.js";
import { parse } from "./books.js";

const Role = z.enum(["admin", "user"]);
const CreateBody = z.object({ username: z.string().min(1).max(64), role: Role.default("user") });
const PatchBody = z
  .object({ role: Role.optional(), disabled: z.boolean().optional(), resetPassword: z.literal(true).optional() })
  .refine((b) => b.role !== undefined || b.disabled !== undefined || b.resetPassword, { message: "nothing to change" });
const Params = z.object({ id: z.uuid() });

export function registerAdminRoutes(app: FastifyInstance, cfg: AuthConfig, runtime: AuthRuntime): void {
  const { store } = cfg;

  app.get("/api/admin/users", async (request) => {
    requireAdmin(request);
    return { users: await store.listUsers() };
  });

  app.post("/api/admin/users", async (request) => {
    requireAdmin(request);
    const body = parse(CreateBody, request.body);
    try {
      return await addUser(store, { username: body.username, role: body.role });
    } catch (err) {
      return accountProblem(err);
    }
  });

  app.patch("/api/admin/users/:id", async (request) => {
    const actor = requireAdmin(request);
    const { id } = parse(Params, request.params);
    const body = parse(PatchBody, request.body);
    try {
      let user = await changeUser(store, id, { role: body.role, disabled: body.disabled }, actor.id);
      let password: string | undefined;
      if (body.resetPassword) ({ user, password } = await resetUserPassword(store, id));
      runtime.forget(id);
      return password ? { user, password } : { user };
    } catch (err) {
      return accountProblem(err);
    }
  });

  app.delete("/api/admin/users/:id", async (request) => {
    const actor = requireAdmin(request);
    const { id } = parse(Params, request.params);
    try {
      await removeUser(store, id, actor.id);
      runtime.forget(id);
      return { ok: true };
    } catch (err) {
      return accountProblem(err);
    }
  });
}
