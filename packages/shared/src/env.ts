/**
 * .env loading without a dependency. Node's process.loadEnvFile never
 * overrides variables that are already set in the environment.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { findUp } from "./config.js";

export function loadDotEnv(explicitPath?: string): string | undefined {
  let file = explicitPath;
  if (!file) {
    const root = findUp(".env");
    file = root ? path.join(root, ".env") : undefined;
  }
  if (!file || !existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required environment variable " + name);
  return v;
}

export function envFlag(name: string, dflt = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}
