/**
 * Fastify application. buildServer() wires routes against injected
 * dependencies so tests can pass fakes; main.ts supplies the real ones.
 */
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { Pool } from "@miriel/shared/db";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AnswerEvent, AnswerInput } from "./answer/index.js";
import { HttpProblem, sendProblem } from "./problem.js";
import type { RetrievalResult, RetrieveOptions } from "./retrieval/types.js";
import { registerBookRoutes } from "./routes/books.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerEntityRoutes } from "./routes/entities.js";

export interface ServerDeps {
  pool: Pool;
  /** Directory the PDFs and image directories live under (read-only mount in Docker). */
  dataDir: string;
  /** Allowed browser origin in dev (Vite); unset in Compose where nginx serves both. */
  corsOrigin?: string | undefined;
  retrieve: (query: string, opts: RetrieveOptions) => Promise<RetrievalResult>;
  answer: (input: AnswerInput) => AsyncIterable<AnswerEvent>;
  /** name_norm values for entities mentioned in a previous user message. */
  resolvePrior: (text: string, bookIds: string[] | undefined) => Promise<string[]>;
  logger?: boolean | object | undefined;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? { level: process.env["LOG_LEVEL"] ?? "info" } });

  if (deps.corsOrigin) {
    await app.register(fastifyCors, { origin: deps.corsOrigin.split(",").map((s) => s.trim()) });
  }
  await app.register(fastifyStatic, { root: deps.dataDir, serve: false, cacheControl: false, acceptRanges: true, etag: true, lastModified: true });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpProblem) return sendProblem(reply, error, request.url);
    if (error instanceof z.ZodError) {
      return sendProblem(reply, new HttpProblem(400, "Invalid request", "Validation failed.", { errors: error.issues }), request.url);
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    if (status >= 500) request.log.error({ err }, "unhandled error");
    const detail = status >= 500 ? "An unexpected error occurred." : err.message;
    return sendProblem(reply, new HttpProblem(status, status >= 500 ? "Internal server error" : err.name || "Error", detail), request.url);
  });
  app.setNotFoundHandler((request, reply) =>
    sendProblem(reply, new HttpProblem(404, "Not found", request.method + " " + request.url + " does not exist."), request.url),
  );

  app.get("/api/health", async () => {
    try {
      await deps.pool.query("SELECT 1");
      return { status: "ok", db: "ok" };
    } catch (err) {
      throw new HttpProblem(503, "Database unavailable", err instanceof Error ? err.message : String(err), { status_text: "degraded" });
    }
  });

  registerBookRoutes(app, deps);
  registerEntityRoutes(app, deps);
  registerChatRoutes(app, deps);
  return app;
}
