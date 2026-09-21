#!/usr/bin/env node
/**
 * indexer migrate
 * indexer ingest --book vol1 [--out ./out/vol1] [--pages 33,73] [--dry-run] [--provider fake]
 * indexer reset  --book vol1
 * indexer dump   --book vol1 --page 159        # chunks as stored in the database
 * indexer dump   --file out/vol1/p0159.json    # chunks the chunker would produce, no database
 */
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createEmbeddingProvider,
  findRepoRoot,
  loadBooksConfig,
  loadDotEnv,
  EMBEDDING_DIM,
  describeError,
  type BookConfig,
} from "@miriel/shared";
import { chunkPage, type Chunk } from "./chunker.js";
import { createPool } from "@miriel/shared/db";
import { formatSummary, ingest, loadPageFile, resetBook } from "./ingest.js";
import { migrate } from "./migrate.js";

const USAGE = `usage:
  indexer migrate
  indexer ingest --book <id> [--out <dir>] [--pages 33,73] [--dry-run] [--provider voyage|fake]
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
      out: { type: "string" },
      pages: { type: "string" },
      page: { type: "string" },
      file: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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
  const books = loadBooksConfig(path.join(root, "config", "books.json"));

  const requireBook = (): [string, BookConfig] => {
    const id = values.book;
    if (!id) throw new Error("--book is required");
    const book = books[id];
    if (!book) throw new Error("unknown book \"" + id + "\"; configured: " + Object.keys(books).join(", "));
    return [id, book];
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
        const summary = await ingest({ bookId, book, outDir, pages, dryRun, provider, pool, log });
        process.stdout.write(formatSummary(summary) + "\n");
        return summary.pagesSkipped > 0 ? 1 : 0;
      } finally {
        await pool.end();
      }
    }

    case "reset": {
      const [bookId] = requireBook();
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
