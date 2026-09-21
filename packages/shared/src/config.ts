/**
 * Book-level configuration: config/books.json at the repo root.
 * Paths are relative to DATA_DIR (repo root on the host, /data in Docker).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Dimension of the stored vectors. Must match the embedding model's output. */
export const EMBEDDING_DIM = 1024;

export const BookConfigSchema = z.strictObject({
  title: z.string().min(1),
  /** Short label for citations and UI pills, e.g. "Vol 1". */
  label: z.string().min(1),
  /** Value of the `book` field in the extraction JSON ({{BOOK}} in the prompt). */
  sourceBook: z.string().min(1),
  pdf: z.string().min(1),
  imageDir: z.string().min(1),
  /** File name pattern inside imageDir; {n} = printed page + printedToPdfOffset. */
  imagePattern: z.string().includes("{n}"),
  /** printed page + offset = 1-based PDF page number = image number. */
  printedToPdfOffset: z.int(),
  pageCount: z.int().positive(),
});

export const BooksConfigSchema = z.record(z.string().regex(/^[a-z0-9_-]+$/), BookConfigSchema);

export type BookConfig = z.infer<typeof BookConfigSchema>;
export type BooksConfig = z.infer<typeof BooksConfigSchema>;

export function loadBooksConfig(file: string): BooksConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return BooksConfigSchema.parse(raw);
}

/** Walk up from `start` looking for a directory that contains `marker`. */
export function findUp(marker: string, start = process.cwd()): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Repo root, located by the config/books.json marker. */
export function findRepoRoot(start = process.cwd()): string {
  const root = findUp(path.join("config", "books.json"), start);
  if (!root) throw new Error("Could not locate repo root (no config/books.json above " + start + ")");
  return root;
}

/** 0-based index into the PDF for a printed page number. */
export function pdfPageIndex(book: BookConfig, printedPage: number): number {
  return printedPage + book.printedToPdfOffset - 1;
}

export function imageFileName(book: BookConfig, printedPage: number): string {
  return book.imagePattern.replace("{n}", String(printedPage + book.printedToPdfOffset));
}
