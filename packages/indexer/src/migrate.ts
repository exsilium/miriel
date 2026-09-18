/**
 * Tiny migration runner: applies db/migrations/*.sql in name order, once each,
 * recording them in schema_migrations. `${EMBEDDING_DIM}` in a migration is
 * replaced with the shared constant so the vector width has one source.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { EMBEDDING_DIM } from "@miriel/shared";

const LOCK_KEY = 727_001; // arbitrary advisory lock id shared by all migrate runs

export async function migrate(pool: pg.Pool, dir: string, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), "utf8").replaceAll("${EMBEDDING_DIM}", String(EMBEDDING_DIM));
      log("applying " + file);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error("migration " + file + " failed: " + (err instanceof Error ? err.message : String(err)));
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
