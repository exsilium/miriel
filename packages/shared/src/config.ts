/**
 * Book-level configuration: config/books.json at the repo root.
 * Paths are relative to DATA_DIR (./data on the host, /data in Docker).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Dimension of the stored vectors. Must match the embedding model's output. */
export const EMBEDDING_DIM = 1024;

/** A strategy guide: OCR PDF + one photo per printed page, extracted to out/<id>/pNNNN.json. */
export const BookConfigSchema = z.strictObject({
  kind: z.literal("guide").optional(),
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
  /** PDF page count (the viewer navigates the PDF); surplus image files are ignored. */
  pageCount: z.int().positive(),
  /** Operator note written by scripts/check_offset.py --record, e.g. "2026-09-23, pages 11,200,520". */
  offsetVerified: z.string().optional(),
});

/**
 * An art book (docs/build-spec-artbooks.md): one JPEG per PDF page, most pages two-page spreads. Its "page"
 * number everywhere is the 1-based PDF page; `spread` maps it to printed folios.
 */
export const ArtBookConfigSchema = z.strictObject({
  kind: z.literal("artbook"),
  title: z.string().min(1),
  label: z.string().min(1),
  pdf: z.string().min(1),
  /** Spread JPEGs exported byte for byte from the PDF by scripts/art_export.py. */
  imageDir: z.string().min(1),
  /** {n} = 1-based PDF page number. */
  imagePattern: z.string().includes("{n}"),
  pageCount: z.int().positive(),
  /** PDF page `pdfPage` shows printed folios `leftFolio` and `leftFolio + 1`; each later page adds 2. */
  spread: z.strictObject({ pdfPage: z.int().positive(), leftFolio: z.int() }),
  /** Contents file under DATA_DIR: [{from, to, chapter, section, region}] by printed folio. */
  contents: z.string().min(1),
  /** Operator note written by scripts/art_check.py --record. */
  folioVerified: z.string().optional(),
});

export const BooksConfigSchema = z.record(z.string().regex(/^[a-z0-9_-]+$/), z.union([ArtBookConfigSchema, BookConfigSchema]));

export type BookConfig = z.infer<typeof BookConfigSchema>;
export type ArtBookConfig = z.infer<typeof ArtBookConfigSchema>;
export type AnyBookConfig = BookConfig | ArtBookConfig;
export type BooksConfig = z.infer<typeof BooksConfigSchema>;

export function isArtBook(b: AnyBookConfig): b is ArtBookConfig {
  return b.kind === "artbook";
}

/** The guides of a config, in config order (every tool that reads page extractions works on these). */
export function guideBooks(config: BooksConfig): Record<string, BookConfig> {
  return Object.fromEntries(Object.entries(config).filter((e): e is [string, BookConfig] => !isArtBook(e[1])));
}

export function artBooks(config: BooksConfig): Record<string, ArtBookConfig> {
  return Object.fromEntries(Object.entries(config).filter((e): e is [string, ArtBookConfig] => isArtBook(e[1])));
}

/** Printed folios shown on a PDF page of an art book: [left, right], or [] before the first spread (cover). */
export function spreadFolios(book: ArtBookConfig, pdfPage: number): number[] {
  const { pdfPage: anchor, leftFolio } = book.spread;
  if (pdfPage < anchor || pdfPage > book.pageCount) return [];
  const left = leftFolio + 2 * (pdfPage - anchor);
  return [left, left + 1];
}

/** PDF page of an art book that shows a printed folio, or null when the folio is outside the book. */
export function spreadForFolio(book: ArtBookConfig, folio: number): number | null {
  const { pdfPage: anchor, leftFolio } = book.spread;
  if (folio < leftFolio) return null;
  const pdfPage = anchor + Math.floor((folio - leftFolio) / 2);
  return pdfPage <= book.pageCount ? pdfPage : null;
}

export function loadBooksConfig(file: string): BooksConfig {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return BooksConfigSchema.parse(raw);
}

/**
 * A quest checklist (docs/build-spec-checklist.md): config/checklists.json, id -> list. `file` is relative to
 * config/; `books` are the guides its page links and chat questions use; `markers` are read by
 * scripts/checklist_build.py.
 */
export const ChecklistConfigSchema = z.object({
  title: z.string().min(1),
  label: z.string().min(1),
  file: z.string().min(1),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  books: z.array(z.string()).min(1),
  idPrefix: z.string().regex(/^[a-z]+$/),
  markers: z.record(z.string(), z.unknown()).default({}),
});
export const ChecklistsConfigSchema = z.record(z.string().regex(/^[a-z0-9_-]+$/), ChecklistConfigSchema);
export type ChecklistConfig = z.infer<typeof ChecklistConfigSchema>;
export type ChecklistsConfig = z.infer<typeof ChecklistsConfigSchema>;

/** config/checklists.json; {} when the file does not exist (a stack without checklists). */
export function loadChecklistsConfig(file: string): ChecklistsConfig {
  if (!existsSync(file)) return {};
  return ChecklistsConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")) as unknown);
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
