/**
 * Ingest: out/<book>/pNNNN.json -> Postgres.
 *
 * Per page: validate (zod), chunk, embed, then replace all of that page's rows
 * in one transaction. Embedding requests are batched across pages up to the
 * provider's batch size. Invalid files are logged and skipped; the caller
 * exits non-zero if any were.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import {
  PageSchema,
  normalizeName,
  type BookConfig,
  type EmbeddingProvider,
  type ExtractedPage,
} from "@miriel/shared";
import { chunkPage, embeddingInput, type Chunk, type ChunkOptions, DEFAULT_CHUNK_OPTIONS } from "./chunker.js";
import { vectorLiteral, withTransaction } from "./db.js";

export interface IngestOptions {
  bookId: string;
  book: BookConfig;
  outDir: string;
  /** Only these printed pages (default: every pNNNN.json in outDir). */
  pages?: number[] | undefined;
  /** Validate and chunk only: no embedding, no database writes. */
  dryRun: boolean;
  provider: EmbeddingProvider;
  pool: pg.Pool;
  chunkOptions?: ChunkOptions | undefined;
  log: (msg: string) => void;
}

export interface SkippedFile {
  file: string;
  reason: string;
}

export interface IngestSummary {
  bookId: string;
  pagesIndexed: number;
  pagesSkipped: number;
  skipped: SkippedFile[];
  chunks: number;
  figures: number;
  entities: number;
  entityLinks: number;
  embeddingTokens: number;
  embeddingRequests: number;
  embeddingModel: string;
  dryRun: boolean;
}

interface PreparedPage {
  file: string;
  page: ExtractedPage;
  chunks: Chunk[];
}

const FILE_RE = /^p(\d{4})\.json$/;

export function listPageFiles(outDir: string, pages?: number[]): string[] {
  const want = pages ? new Set(pages) : undefined;
  return readdirSync(outDir)
    .filter((f) => {
      const m = FILE_RE.exec(f);
      if (!m) return false;
      return want ? want.has(Number(m[1])) : true;
    })
    .sort();
}

/** Parse and validate one page file. Returns the page or a human-readable reason. */
export function loadPageFile(file: string, book: BookConfig): { page: ExtractedPage } | { error: string } {
  const m = FILE_RE.exec(path.basename(file));
  if (!m) return { error: "file name does not match pNNNN.json" };
  const fromName = Number(m[1]);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: "invalid JSON: " + (err instanceof Error ? err.message : String(err)) };
  }

  const parsed = PageSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length ? i.path.join(".") + ": " : "") + i.message)
      .join("; ");
    return { error: "schema: " + issues + (parsed.error.issues.length > 5 ? " (+" + (parsed.error.issues.length - 5) + " more)" : "") };
  }
  const page = parsed.data;
  if (page.page !== fromName) return { error: "page field " + page.page + " does not match file name page " + fromName };
  if (page.book !== book.sourceBook) {
    return { error: "book field \"" + page.book + "\" does not match configured sourceBook \"" + book.sourceBook + "\"" };
  }
  return { page };
}

export async function ingest(o: IngestOptions): Promise<IngestSummary> {
  const chunkOpts = o.chunkOptions ?? DEFAULT_CHUNK_OPTIONS;
  const summary: IngestSummary = {
    bookId: o.bookId,
    pagesIndexed: 0,
    pagesSkipped: 0,
    skipped: [],
    chunks: 0,
    figures: 0,
    entities: 0,
    entityLinks: 0,
    embeddingTokens: 0,
    embeddingRequests: 0,
    embeddingModel: o.provider.model,
    dryRun: o.dryRun,
  };

  if (!existsSync(o.outDir)) throw new Error("output directory not found: " + o.outDir);
  const dataDir = process.env["DATA_DIR"];
  if (dataDir) {
    for (const rel of [o.book.pdf, o.book.imageDir]) {
      if (!existsSync(path.join(dataDir, rel))) o.log("warning: " + rel + " not found under DATA_DIR=" + dataDir);
    }
  }

  if (!o.dryRun) await upsertBook(o.pool, o.bookId, o.book);

  // 1. validate + chunk
  const prepared: PreparedPage[] = [];
  for (const name of listPageFiles(o.outDir, o.pages)) {
    const file = path.join(o.outDir, name);
    const loaded = loadPageFile(file, o.book);
    if ("error" in loaded) {
      o.log("skip " + name + ": " + loaded.error);
      summary.skipped.push({ file: name, reason: loaded.error });
      continue;
    }
    const chunks = chunkPage(loaded.page, chunkOpts);
    prepared.push({ file: name, page: loaded.page, chunks });
    o.log(
      "p" + String(loaded.page.page).padStart(4, "0") + ": " + chunks.length + " chunks, " +
        loaded.page.figures.length + " figures, " + loaded.page.entities.length + " entities" +
        (o.dryRun ? " (dry run)" : ""),
    );
  }
  summary.pagesSkipped = summary.skipped.length;

  // 2. embed in cross-page batches, 3. write each page in its own transaction
  for (const group of groupByBatch(prepared, o.provider.maxBatchSize)) {
    const texts = group.flatMap((p) => p.chunks.map(embeddingInput));
    let vectors: number[][] = [];
    if (!o.dryRun) {
      for (let i = 0; i < texts.length; i += o.provider.maxBatchSize) {
        const slice = texts.slice(i, i + o.provider.maxBatchSize);
        const res = await o.provider.embed(slice, "document");
        vectors.push(...res.embeddings);
        summary.embeddingTokens += res.tokens;
        summary.embeddingRequests += 1;
      }
      if (vectors.length !== texts.length) throw new Error("embedding count mismatch");
    }

    let offset = 0;
    for (const p of group) {
      const pageVectors = vectors.slice(offset, offset + p.chunks.length);
      offset += p.chunks.length;
      if (!o.dryRun) {
        const links = await writePage(o.pool, o.bookId, p.page, p.chunks, pageVectors);
        summary.entityLinks += links;
      } else {
        summary.entityLinks += countLinks(p.page);
      }
      summary.pagesIndexed += 1;
      summary.chunks += p.chunks.length;
      summary.figures += p.page.figures.length;
      summary.entities += p.page.entities.length;
    }
    vectors = [];
  }

  return summary;
}

function groupByBatch(pages: PreparedPage[], maxBatch: number): PreparedPage[][] {
  const groups: PreparedPage[][] = [];
  let cur: PreparedPage[] = [];
  let n = 0;
  for (const p of pages) {
    if (cur.length && n + p.chunks.length > maxBatch) {
      groups.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(p);
    n += p.chunks.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function countLinks(page: ExtractedPage): number {
  let n = 0;
  for (const e of page.entities) n += new Set(e.connects_to.map(normalizeName).filter(Boolean)).size;
  return n;
}

async function upsertBook(pool: pg.Pool, id: string, b: BookConfig): Promise<void> {
  await pool.query(
    `INSERT INTO books (id, title, source_book, pdf_path, image_dir, image_pattern, printed_to_pdf_offset, page_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, source_book = EXCLUDED.source_book, pdf_path = EXCLUDED.pdf_path,
       image_dir = EXCLUDED.image_dir, image_pattern = EXCLUDED.image_pattern,
       printed_to_pdf_offset = EXCLUDED.printed_to_pdf_offset, page_count = EXCLUDED.page_count`,
    [id, b.title, b.sourceBook, b.pdf, b.imageDir, b.imagePattern, b.printedToPdfOffset, b.pageCount],
  );
}

/** Replace every row for (book, page). Returns the number of entity_links written. */
async function writePage(
  pool: pg.Pool,
  bookId: string,
  page: ExtractedPage,
  chunks: Chunk[],
  vectors: number[][],
): Promise<number> {
  return withTransaction(pool, async (c) => {
    // cascades to chunks, figures, entities, entity_links
    await c.query("DELETE FROM pages WHERE book_id = $1 AND page = $2", [bookId, page.page]);

    await c.query(
      `INSERT INTO pages (book_id, page, chapter, region, page_type, markdown, quality)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [bookId, page.page, page.chapter, page.region, page.page_type, page.markdown, JSON.stringify(page.quality)],
    );

    for (const [i, f] of page.figures.entries()) {
      await c.query(
        `INSERT INTO figures (book_id, page, figure_idx, kind, description, labels, legend)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bookId, page.page, i + 1, f.kind, f.description, f.labels, f.legend],
      );
    }

    let links = 0;
    for (const [i, e] of page.entities.entries()) {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO entities (book_id, page, entity_idx, type, name, name_norm, location, how_to_obtain, connects_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [bookId, page.page, i, e.type, e.name, normalizeName(e.name), e.location, e.how_to_obtain, e.connects_to],
      );
      const id = rows[0]!.id;
      const seen = new Set<string>();
      for (const target of e.connects_to) {
        const norm = normalizeName(target);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        await c.query("INSERT INTO entity_links (from_entity, to_name, to_name_norm) VALUES ($1, $2, $3)", [id, target, norm]);
        links++;
      }
    }

    for (const [i, ch] of chunks.entries()) {
      await c.query(
        `INSERT INTO chunks (book_id, page, chunk_idx, text, heading_path, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [bookId, page.page, i, ch.text, ch.headingPath, ch.tokenCount, vectorLiteral(vectors[i]!)],
      );
    }
    return links;
  });
}

export async function resetBook(pool: pg.Pool, bookId: string): Promise<{ pages: number; chunks: number; entities: number; figures: number }> {
  const counts = await pool.query<{ pages: string; chunks: string; entities: string; figures: string }>(
    `SELECT (SELECT count(*) FROM pages WHERE book_id = $1) AS pages,
            (SELECT count(*) FROM chunks WHERE book_id = $1) AS chunks,
            (SELECT count(*) FROM entities WHERE book_id = $1) AS entities,
            (SELECT count(*) FROM figures WHERE book_id = $1) AS figures`,
    [bookId],
  );
  await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
  const r = counts.rows[0]!;
  return { pages: Number(r.pages), chunks: Number(r.chunks), entities: Number(r.entities), figures: Number(r.figures) };
}

export function formatSummary(s: IngestSummary): string {
  const rows: [string, string][] = [
    ["pages indexed", String(s.pagesIndexed)],
    ["pages skipped", String(s.pagesSkipped)],
    ["chunks", String(s.chunks)],
    ["figures", String(s.figures)],
    ["entities", String(s.entities)],
    ["entity links", String(s.entityLinks)],
    [
      "embedding tokens",
      s.dryRun ? "0 (dry run)" : s.embeddingTokens.toLocaleString("en-US") + " (" + s.embeddingRequests + " requests, " + s.embeddingModel + ")",
    ],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  const lines = ["Ingest summary (" + s.bookId + (s.dryRun ? ", dry run" : "") + ")"];
  for (const [k, v] of rows) lines.push("  " + k.padEnd(w) + "  " + v);
  if (s.skipped.length) {
    lines.push("  skipped files:");
    for (const sk of s.skipped) lines.push("    " + sk.file + "  " + sk.reason);
  }
  return lines.join("\n");
}
