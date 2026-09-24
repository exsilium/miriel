#!/usr/bin/env node
/**
 * API entry point. PORT (8080), HOST (0.0.0.0), DATA_DIR, THUMB_CACHE_DIR, CORS_ORIGIN,
 * DATABASE_URL, VOYAGE_API_KEY, ANTHROPIC_API_KEY, RERANK_ENABLED, RETAKE_ENABLED, RETAKE_TOKEN, UPLOAD_DIR, ...
 */
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  createEmbeddingProvider,
  createRerankProvider,
  describeError,
  envFlag,
  findUp,
  loadDotEnv,
} from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { answer } from "./answer/index.js";
import { loadBookLabels } from "./books.js";
import { RETRIEVE_DEFAULTS, resolveEntities, retrieve } from "./retrieval/index.js";
import { buildServer } from "./server.js";

loadDotEnv();

const port = Number(process.env["PORT"] ?? 8080);
const host = process.env["HOST"] ?? "0.0.0.0";
/** Source files: DATA_DIR, else <repo root>/data. Paths in config/books.json are relative to it. */
const dataDir = path.resolve(process.env["DATA_DIR"] ?? path.join(findUp(path.join("config", "books.json")) ?? process.cwd(), "data"));

const pool = createPool(undefined, 8, (err) => app.log.warn({ err: err.message }, "postgres pool error (idle client dropped)"));
const embedder = createEmbeddingProvider();
const reranker = envFlag("RERANK_ENABLED", false) ? createRerankProvider() : undefined;
const client = new Anthropic();

/** Book labels rarely change; refresh at most once a minute. */
let labelsCache: { at: number; value: Record<string, string> } | undefined;
async function labels(): Promise<Record<string, string>> {
  if (!labelsCache || Date.now() - labelsCache.at > 60_000) labelsCache = { at: Date.now(), value: await loadBookLabels(pool) };
  return labelsCache.value;
}

const thumbCacheDir = process.env["THUMB_CACHE_DIR"] || path.join(os.tmpdir(), "miriel-thumbs");
/** Page retakes (docs/build-spec-retakes.md): off unless RETAKE_ENABLED; uploads go to UPLOAD_DIR for the worker. */
const retake = envFlag("RETAKE_ENABLED", false)
  ? { uploadDir: path.resolve(process.env["UPLOAD_DIR"] || path.join(os.tmpdir(), "miriel-uploads")), token: process.env["RETAKE_TOKEN"] || undefined }
  : undefined;

const app = await buildServer({
  pool,
  dataDir,
  thumbCacheDir,
  corsOrigin: process.env["CORS_ORIGIN"],
  retake,
  retrieve: (query, opts) => retrieve({ pool, embedder, reranker }, query, opts),
  answer: async function* (input) {
    yield* answer({ client, labels: await labels(), log: (r) => app.log.info(r, "answer") }, input);
  },
  resolvePrior: async (text, bookIds) => {
    const anchors = await resolveEntities(pool, text, { bookIds, trigramThreshold: RETRIEVE_DEFAULTS.trigramThreshold, routeQuestion: false });
    return anchors.entities.map((e) => e.nameNorm);
  },
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
  app.log.info(
    { dataDir, thumbCacheDir, embedder: embedder.model, rerank: Boolean(reranker), retake: retake ? { uploadDir: retake.uploadDir, token: Boolean(retake.token) } : false },
    "miriel api ready",
  );
} catch (err) {
  app.log.error(describeError(err));
  process.exit(1);
}
