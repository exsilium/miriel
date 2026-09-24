#!/usr/bin/env node
/**
 * Retake worker entry point (Compose service `retake-worker`, Docker `retake` image).
 * DATABASE_URL, DATA_DIR (/data), UPLOAD_DIR (/uploads), RETAKE_DAILY_BUDGET_USD (10), RETAKE_POLL_MS (3000),
 * RETAKE_PYTHON (python), RETAKE_SCRIPT (<repo>/scripts/retake.py).
 */
import os from "node:os";
import path from "node:path";
import { describeError, findRepoRoot, loadDotEnv } from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { killCurrent } from "./runner.js";
import { RetakeWorker } from "./worker.js";

loadDotEnv();

const root = findRepoRoot();
const log = (msg: string): void => {
  process.stdout.write(new Date().toISOString() + " " + msg + "\n");
};

const pool = createPool(undefined, 4, (err) => log("postgres pool error (idle client dropped): " + err.message));
const worker = new RetakeWorker(pool, {
  dataDir: path.resolve(process.env["DATA_DIR"] ?? path.join(root, "data")),
  uploadDir: path.resolve(process.env["UPLOAD_DIR"] ?? path.join(os.tmpdir(), "miriel-uploads")),
  python: process.env["RETAKE_PYTHON"] ?? "python",
  script: process.env["RETAKE_SCRIPT"] ?? path.join(root, "scripts", "retake.py"),
  cwd: root,
  budgetUsd: Number(process.env["RETAKE_DAILY_BUDGET_USD"] || 10),
  pollMs: Number(process.env["RETAKE_POLL_MS"] || 3000),
  log,
});

const shutdown = (signal: string): void => {
  log("received " + signal + "; stopping (an interrupted job resumes on the next start)");
  worker.stop();
  killCurrent();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await worker.loop();
  await pool.end();
} catch (err) {
  log("worker failed: " + describeError(err));
  process.exit(1);
}
