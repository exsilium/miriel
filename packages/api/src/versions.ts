/**
 * Content versions for cache-safe URLs (docs/build-spec-retakes.md §5).
 *
 * pdfRevision: sha256 prefix of a book PDF. Hashing 250-310 MB takes about a second, so the value is cached per
 * file and recomputed only when the file's size or mtime changes: after a retake swaps the PDF in (worker or
 * CLI), the next /api/books call sees the new revision without any signal from the worker.
 *
 * imageVersion: sha256 prefix of a page photo, from pages.image_sha256 (written by `indexer ingest`).
 *
 * A URL carrying ?v=<current version> is cached as immutable; without ?v (or with an old one) the response is
 * revalidated, so a replaced page can never hide behind a long-lived cache entry.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Pool } from "@miriel/shared/db";

export const VERSION_LENGTH = 12;

export function shortVersion(sha256: string | null | undefined): string | null {
  return sha256 ? sha256.slice(0, VERSION_LENGTH) : null;
}

interface Cached {
  key: string;
  revision: Promise<string>;
}

const pdfCache = new Map<string, Cached>();

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** sha256 prefix of the file, recomputed when size or mtime change; concurrent callers share one hash run. */
export async function fileRevision(file: string): Promise<string> {
  const st = await stat(file);
  const key = st.size + ":" + st.mtimeMs;
  const hit = pdfCache.get(file);
  if (hit && hit.key === key) return hit.revision;
  const revision = hashFile(file).then((sha) => sha.slice(0, VERSION_LENGTH));
  pdfCache.set(file, { key, revision });
  revision.catch(() => {
    if (pdfCache.get(file)?.revision === revision) pdfCache.delete(file);
  });
  return revision;
}

/** printed page -> imageVersion for the pages of one book that have a recorded photo hash. */
export async function imageVersions(pool: Pool, book: string): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ page: number; image_sha256: string }>(
    "SELECT page, image_sha256 FROM pages WHERE book_id = $1 AND image_sha256 IS NOT NULL ORDER BY page",
    [book],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.page)] = shortVersion(r.image_sha256)!;
  return out;
}

export async function imageVersion(pool: Pool, book: string, page: number): Promise<string | null> {
  const { rows } = await pool.query<{ image_sha256: string | null }>(
    "SELECT image_sha256 FROM pages WHERE book_id = $1 AND page = $2",
    [book, page],
  );
  return shortVersion(rows[0]?.image_sha256);
}

/** "book:page" -> imageVersion for a set of pages (citations and "Pages consulted"). */
export async function imageVersionsFor(pool: Pool, refs: { book: string; page: number }[]): Promise<Record<string, string>> {
  if (!refs.length) return {};
  const { rows } = await pool.query<{ book_id: string; page: number; image_sha256: string }>(
    `SELECT p.book_id, p.page, p.image_sha256 FROM pages p
       JOIN unnest($1::text[], $2::int[]) AS r(book_id, page) ON p.book_id = r.book_id AND p.page = r.page
      WHERE p.image_sha256 IS NOT NULL`,
    [refs.map((r) => r.book), refs.map((r) => r.page)],
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.book_id + ":" + r.page] = shortVersion(r.image_sha256)!;
  return out;
}

/** Cache-Control for a versioned resource: immutable only when the URL names the version being served. */
export function versionedCache(requested: string | undefined, current: string | null, maxAge: number): string {
  return requested && current && requested === current ? "public, max-age=" + maxAge + ", immutable" : "no-cache";
}
