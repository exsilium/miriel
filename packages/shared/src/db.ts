/**
 * Postgres helpers shared by indexer and api. Exported from the
 * "@miriel/shared/db" subpath (not the package root) so browser code that
 * imports "@miriel/shared" never pulls in `pg`.
 */
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://miriel:miriel@localhost:5432/miriel";

export function createPool(connectionString?: string, max = 4, onError?: (err: Error) => void): pg.Pool {
  const pool = new pg.Pool({
    connectionString: connectionString ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
    max,
  });
  // When Postgres restarts, idle clients emit "error" on the pool. Without a
  // listener that is an uncaught exception and the process dies; with one,
  // the client is dropped and the next query reconnects.
  pool.on("error", (err) => {
    if (onError) onError(err);
    else process.stderr.write("[pg pool] " + (err.message || String(err)) + "\n");
  });
  return pool;
}

/** pgvector text literal: "[0.1,0.2,...]" — bind as $n::vector. */
export function vectorLiteral(v: number[]): string {
  return "[" + v.join(",") + "]";
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export type { Pool, PoolClient } from "pg";
