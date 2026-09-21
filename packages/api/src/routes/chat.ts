/**
 * POST /api/chat -> SSE stream: anchors, text*, citation*, done | error
 */
import { describeError } from "@miriel/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { HistoryMessage } from "../answer/types.js";
import { HttpProblem } from "../problem.js";
import type { PageRef, RetrievalResult } from "../retrieval/types.js";
import type { ServerDeps } from "../server.js";
import { openSse } from "../sse.js";
import { parse } from "./books.js";

/** The model sees at most this many messages (the question included). */
export const HISTORY_WINDOW = 6;

export const ChatBody = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(8000) }))
    .min(1)
    .max(100),
  bookIds: z.array(z.string().regex(/^[a-z0-9_-]+$/)).max(20).optional(),
  /** name_norm values resolved in the previous turn; derived from the previous user message when absent. */
  priorEntities: z.array(z.string().max(200)).max(50).optional(),
});
export type ChatBody = z.infer<typeof ChatBody>;

export interface AnchorsEvent {
  type: "anchors";
  entities: RetrievalResult["anchors"]["entities"];
  pages: PageRef[];
  ownPages: PageRef[];
  routeQuestion: boolean;
  /** Every page the answer may draw on, in page order: for the "Pages consulted" strip. */
  consulted: PageRef[];
}

export function consultedPages(r: RetrievalResult): PageRef[] {
  const seen = new Map<string, PageRef>();
  for (const c of [...r.pages, ...r.chunks]) seen.set(c.book + ":" + c.page, { book: c.book, page: c.page });
  return [...seen.values()].sort((a, b) => a.book.localeCompare(b.book) || a.page - b.page);
}

export function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/api/chat", async (request, reply) => {
    const body = parse(ChatBody, request.body);
    const last = body.messages[body.messages.length - 1]!;
    if (last.role !== "user") throw new HttpProblem(400, "Invalid request", "The last message must be from the user.");

    const window = body.messages.slice(-HISTORY_WINDOW);
    const history: HistoryMessage[] = window.slice(0, -1);
    const bookIds = body.bookIds && body.bookIds.length ? body.bookIds : undefined;

    let priorEntities = body.priorEntities;
    if (!priorEntities) {
      const prevUser = body.messages.slice(0, -1).reverse().find((m) => m.role === "user");
      if (prevUser) priorEntities = await deps.resolvePrior(prevUser.content, bookIds);
    }

    reply.hijack();
    const sse = openSse(reply.raw, request.raw);
    try {
      const retrieval = await deps.retrieve(last.content, { bookIds, priorEntities });
      const anchors: AnchorsEvent = {
        type: "anchors",
        entities: retrieval.anchors.entities,
        pages: retrieval.anchors.pages,
        ownPages: retrieval.anchors.ownPages,
        routeQuestion: retrieval.routeQuestion,
        consulted: consultedPages(retrieval),
      };
      sse.send("anchors", anchors);

      for await (const ev of deps.answer({ query: last.content, retrieval, history })) {
        if (!sse.open) break;
        sse.send(ev.type, ev);
      }
    } catch (err) {
      request.log.error({ err }, "chat failed");
      sse.send("error", { type: "error", message: describeError(err) });
    } finally {
      sse.close();
    }
  });
}
