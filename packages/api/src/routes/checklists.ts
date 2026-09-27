/**
 * Quest checklists and per-run progress (docs/build-spec-checklist.md §5).
 *
 *   GET    /api/checklists                       lists with item counts
 *   GET    /api/checklists/:id                   outline (headings, notes, items in order), chains, footnotes, retired
 *   GET    /api/runs                             the user's runs with items done per checklist
 *   POST   /api/runs            {name}           a new run (character / playthrough)
 *   PATCH  /api/runs/:id        {name}
 *   DELETE /api/runs/:id                         with its progress; a user keeps at least one run
 *   GET    /api/runs/:id/progress                {runId, done: {itemId: doneAt}}
 *   PUT    /api/runs/:id/progress/:itemId        tick an item (idempotent; keeps the first done_at)
 *   DELETE /api/runs/:id/progress/:itemId        untick
 *
 * Checklists can be read without a login (unless AUTH_REQUIRED); runs and progress are the logged-in user's own:
 * another user's run answers 404.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { RunNameTaken, type ChecklistStore } from "../checklists.js";
import { HttpProblem } from "../problem.js";
import { parse } from "./books.js";

const ListId = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) });
const RunId = z.object({ id: z.uuid() });
const ItemParams = z.object({ id: z.uuid(), itemId: z.string().regex(/^[a-z]+\d+$/) });
const RunBody = z.object({ name: z.string().trim().min(1).max(60) });

export function registerChecklistRoutes(app: FastifyInstance, store: ChecklistStore): void {
  const ownRun = async (request: FastifyRequest, runId: string): Promise<void> => {
    const user = requireUser(request);
    if ((await store.runOwner(runId)) !== user.id) throw new HttpProblem(404, "Unknown run", "No run " + runId + " of yours.");
  };
  const nameTaken = (err: unknown): never => {
    if (err instanceof RunNameTaken) throw new HttpProblem(409, "Name taken", "You already have a run called " + err.message + ".");
    throw err;
  };

  app.get("/api/checklists", async () => ({ checklists: await store.listChecklists() }));

  app.get("/api/checklists/:id", async (request) => {
    const { id } = parse(ListId, request.params);
    const c = await store.getChecklist(id);
    if (!c) throw new HttpProblem(404, "Unknown checklist", "No checklist " + id + ".");
    const byId = new Map(c.itemRows.map((i) => [i.id, i]));
    const { itemRows: _rows, ...rest } = c;
    return {
      ...rest,
      outline: c.outline.map((r) => (r.type === "item" ? { type: "item", ...byId.get(r.id as string)! } : r)).filter((r) => r.type !== "item" || "text" in r),
    };
  });

  app.get("/api/runs", async (request) => ({ runs: await store.listRuns(requireUser(request).id) }));

  app.post("/api/runs", async (request, reply) => {
    const user = requireUser(request);
    const { name } = parse(RunBody, request.body);
    const run = await store.createRun(user.id, name).catch(nameTaken);
    reply.code(201);
    return run;
  });

  app.patch("/api/runs/:id", async (request) => {
    const { id } = parse(RunId, request.params);
    await ownRun(request, id);
    const { name } = parse(RunBody, request.body);
    return (await store.renameRun(id, name).catch(nameTaken))!;
  });

  app.delete("/api/runs/:id", async (request) => {
    const { id } = parse(RunId, request.params);
    await ownRun(request, id);
    if ((await store.listRuns(requireUser(request).id)).length <= 1) {
      throw new HttpProblem(409, "Last run", "Every account keeps at least one run; rename this one instead.");
    }
    await store.deleteRun(id);
    return { ok: true };
  });

  app.get("/api/runs/:id/progress", async (request) => {
    const { id } = parse(RunId, request.params);
    await ownRun(request, id);
    return { runId: id, done: await store.progress(id) };
  });

  app.put("/api/runs/:id/progress/:itemId", async (request) => {
    const { id, itemId } = parse(ItemParams, request.params);
    await ownRun(request, id);
    if (!(await store.itemExists(itemId))) throw new HttpProblem(404, "Unknown item", "No checklist item " + itemId + ".");
    return { itemId, done: true, doneAt: await store.setDone(id, itemId, true) };
  });

  app.delete("/api/runs/:id/progress/:itemId", async (request) => {
    const { id, itemId } = parse(ItemParams, request.params);
    await ownRun(request, id);
    await store.setDone(id, itemId, false);
    return { itemId, done: false, doneAt: null };
  });
}
