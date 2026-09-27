#!/usr/bin/env node
/**
 * indexer migrate
 * indexer ingest --book <id> [--out ./out/<id>] [--pages 33,73] [--dry-run] [--force] [--provider fake]
 * indexer ingest --all [--out ./out]           # every book in config/books.json, from <out>/<id>/
 * indexer reset  --book <id>                   # guides and art books
 * indexer dump   --book <id> --page 159        # chunks as stored in the database
 * indexer dump   --file out/<id>/p0159.json    # chunks the chunker would produce, no database
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createEmbeddingProvider,
  artBooks,
  findRepoRoot,
  guideBooks,
  loadBooksConfig,
  loadDotEnv,
  EMBEDDING_DIM,
  describeError,
  type BookConfig,
} from "@miriel/shared";
import { chunkPage, type Chunk } from "./chunker.js";
import { createPool } from "@miriel/shared/db";
import { formatSummary, ingest, loadPageFile, resetBook, upsertBook } from "./ingest.js";
import { formatArtSummary, ingestArtBook, upsertArtBook } from "./art-ingest.js";
import { migrate } from "./migrate.js";

const USAGE = `usage:
  indexer migrate
  indexer ingest --book <id> [--out <dir>] [--pages 33,73] [--dry-run] [--force] [--provider voyage|fake]
  indexer ingest --all [--out <root>] [--dry-run] [--force] [--provider voyage|fake]
                         every configured book from <root>/<id>/ (default <repo>/out); a book without
                         output gets its books row and a warning, so it is browsable before extraction
                         Pages whose file hash is unchanged since the last ingest are skipped
                         ("unchanged" in the summary); --force re-indexes them.
  indexer reset  --book <id>
  indexer dump   --book <id> --page <n>
  indexer dump   --file <pNNNN.json>

options:
  --database-url <url>   overrides DATABASE_URL
  --env <file>           .env file (default: nearest .env walking up from cwd)
  -h, --help`;

const log = (msg: string): void => {
  process.stderr.write(msg + "\n");
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      book: { type: "string" },
      all: { type: "boolean", default: false },
      out: { type: "string" },
      pages: { type: "string" },
      page: { type: "string" },
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      provider: { type: "string" },
      "database-url": { type: "string" },
      env: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    log(USAGE);
    return values.help ? 0 : 2;
  }

  loadDotEnv(values.env);
  const root = findRepoRoot();
  const config = loadBooksConfig(path.join(root, "config", "books.json"));
  const books = guideBooks(config);
  /** Art books (docs/build-spec-artbooks.md): labels from <out>/<id>/sNNNN.json, indexed by art-ingest.ts. */
  const arts = artBooks(config);
  /** Page photos, for pages.image_sha256 (DATA_DIR, else <repo>/data; skipped with a note when absent). */
  const dataDir = path.resolve(process.env["DATA_DIR"] ?? path.join(root, "data"));

  const requireBook = (): [string, BookConfig] => {
    const id = values.book;
    if (!id) throw new Error("--book is required");
    const book = books[id];
    if (!book) {
      if (arts[id]) throw new Error(id + " is an art book; this command works on guides only");
      throw new Error("unknown book \"" + id + "\"; configured: " + Object.keys(config).join(", "));
    }
    return [id, book];
  };

  /** `ingest --all`: every configured book, in config order. Exit 1 if any page file was invalid. */
  const ingestAll = async (outRoot: string): Promise<number> => {
    const dryRun = values["dry-run"];
    const provider = dryRun ? createEmbeddingProvider({ provider: "fake" }) : createEmbeddingProvider({ provider: values.provider });
    if (provider.dimension !== EMBEDDING_DIM) {
      throw new Error("provider dimension " + provider.dimension + " != EMBEDDING_DIM " + EMBEDDING_DIM);
    }
    const pool = createPool(values["database-url"]);
    let invalid = 0;
    try {
      for (const [bookId, book] of Object.entries(books)) {
        const outDir = path.join(outRoot, bookId);
        log("== " + bookId + " (" + book.label + ") from " + outDir);
        if (!existsSync(outDir)) {
          log("warning: no extraction output for " + bookId + " yet; registering the book without pages");
          if (!dryRun) await upsertBook(pool, bookId, book);
          continue;
        }
        const summary = await ingest({ bookId, book, outDir, dryRun, force: values.force, provider, pool, dataDir, log });
        process.stdout.write(formatSummary(summary) + "\n");
        invalid += summary.pagesSkipped;
      }
      for (const [bookId, book] of Object.entries(arts)) {
        const outDir = path.join(outRoot, bookId);
        log("== " + bookId + " (" + book.label + ", art book) from " + outDir);
        if (!existsSync(outDir)) {
          log("warning: no labels for " + bookId + " yet; registering the book without artworks");
          if (!dryRun) await upsertArtBook(pool, bookId, book);
          continue;
        }
        const summary = await ingestArtBook({ bookId, book, outDir, dryRun, force: values.force, provider, pool, dataDir, log });
        process.stdout.write(formatArtSummary(summary) + "\n");
        invalid += summary.skipped.length;
      }
    } finally {
      await pool.end();
    }
    return invalid > 0 ? 1 : 0;
  };

  switch (command) {
    case "migrate": {
      const pool = createPool(values["database-url"]);
      try {
        const applied = await migrate(pool, path.join(root, "db", "migrations"), log);
        log(applied.length ? "applied " + applied.length + " migration(s)" : "database is up to date");
      } finally {
        await pool.end();
      }
      return 0;
    }

    case "ingest": {
      if (values.all) {
        if (values.book || values.pages) throw new Error("--all cannot be combined with --book or --pages");
        return ingestAll(values.out ? path.resolve(values.out) : path.join(root, "out"));
      }
      const art = values.book ? arts[values.book] : undefined;
      if (art) {
        if (values.pages) throw new Error("--pages is not supported for art books (spreads are hash-checked; use --force to redo)");
        const bookId = values.book!;
        const provider = values["dry-run"] ? createEmbeddingProvider({ provider: "fake" }) : createEmbeddingProvider({ provider: values.provider });
        const pool = createPool(values["database-url"]);
        try {
          const outDir = path.resolve(values.out ?? path.join(root, "out", bookId));
          const summary = await ingestArtBook({ bookId, book: art, outDir, dryRun: values["dry-run"], force: values.force, provider, pool, dataDir, log });
          process.stdout.write(formatArtSummary(summary) + "\n");
          return summary.skipped.length > 0 ? 1 : 0;
        } finally {
          await pool.end();
        }
      }
      const [bookId, book] = requireBook();
      const outDir = path.resolve(values.out ?? path.join(root, "out", bookId));
      const pages = values.pages
        ? values.pages.split(",").map((s) => {
            const n = Number(s.trim());
            if (!Number.isInteger(n)) throw new Error("bad --pages value: " + s);
            return n;
          })
        : undefined;
      const dryRun = values["dry-run"];
      const provider = dryRun
        ? createEmbeddingProvider({ provider: "fake" })
        : createEmbeddingProvider({ provider: values.provider });
      if (provider.dimension !== EMBEDDING_DIM) {
        throw new Error("provider dimension " + provider.dimension + " != EMBEDDING_DIM " + EMBEDDING_DIM);
      }
      const pool = createPool(values["database-url"]);
      try {
        const summary = await ingest({ bookId, book, outDir, pages, dryRun, force: values.force, provider, pool, dataDir, log });
        process.stdout.write(formatSummary(summary) + "\n");
        return summary.pagesSkipped > 0 ? 1 : 0;
      } finally {
        await pool.end();
      }
    }

    case "reset": {
      const bookId = values.book && arts[values.book] ? values.book : requireBook()[0];
      const pool = createPool(values["database-url"]);
      try {
        const c = await resetBook(pool, bookId);
        log("reset " + bookId + ": removed " + c.pages + " pages, " + c.chunks + " chunks, " + c.entities + " entities, " + c.figures + " figures");
      } finally {
        await pool.end();
      }
      return 0;
    }

    case "dump": {
      if (values.file) {
        const file = path.resolve(values.file);
        const bookId = values.book ?? Object.keys(books)[0]!;
        const book = books[bookId];
        if (!book) throw new Error("unknown book " + bookId);
        const loaded = loadPageFile(file, book);
        if ("error" in loaded) throw new Error(loaded.error);
        const chunks = chunkPage(loaded.page);
        process.stdout.write(formatChunks(bookId, loaded.page.page, chunks, "chunker, not database") + "\n");
        return 0;
      }
      const [bookId] = requireBook();
      const page = Number(values.page);
      if (!Number.isInteger(page)) throw new Error("--page <n> is required");
      const pool = createPool(values["database-url"]);
      try {
        const { rows } = await pool.query<{ chunk_idx: number; text: string; heading_path: string; token_count: number }>(
          "SELECT chunk_idx, text, heading_path, token_count FROM chunks WHERE book_id = $1 AND page = $2 ORDER BY chunk_idx",
          [bookId, page],
        );
        const chunks: Chunk[] = rows.map((r) => ({ text: r.text, headingPath: r.heading_path, tokenCount: r.token_count }));
        process.stdout.write(formatChunks(bookId, page, chunks, "database") + "\n");
      } finally {
        await pool.end();
      }
      return 0;
    }

    default:
      log("unknown command: " + command + "\n\n" + USAGE);
      return 2;
  }
}

function formatChunks(bookId: string, page: number, chunks: Chunk[], source: string): string {
  const total = chunks.reduce((n, c) => n + c.tokenCount, 0);
  const out = ["# " + bookId + " p. " + page + " — " + chunks.length + " chunks, " + total + " tokens (" + source + ")", ""];
  chunks.forEach((c, i) => {
    out.push("## [" + i + "] " + c.tokenCount + " tok — " + c.headingPath, "", c.text, "", "---", "");
  });
  return out.join("\n");
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log("error: " + describeError(err));
    process.exitCode = 1;
  },
);
