import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { typeahead } from "../queries.js";
import type { ServerDeps } from "../server.js";
import { parse } from "./books.js";

const Query = z.object({
  q: z.string().trim().min(1).max(100),
  book: z.union([z.string(), z.array(z.string())]).optional(),
});

export function registerEntityRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Querystring: { q?: string; book?: string | string[] } }>("/api/entities", async (request) => {
    const { q, book } = parse(Query, request.query);
    const bookIds = book === undefined ? null : Array.isArray(book) ? book : [book];
    return typeahead(deps.pool, q, bookIds, 10);
  });
}
