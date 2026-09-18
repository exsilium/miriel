/**
 * Postgres helpers shared by indexer and api. Exported from the
 * "@miriel/shared/db" subpath (not the package root) so browser code that
 * imports "@miriel/shared" never pulls in `pg`.
 */
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://miriel:miriel@localhost:5432/miriel";

export function createPool(connectionString?: string, max = 4): pg.Pool {
  return new pg.Pool({
    connectionString: connectionString ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
    max,
  });
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
