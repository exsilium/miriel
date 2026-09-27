import type { Pool } from "@miriel/shared/db";

export interface BookRow {
  id: string;
  title: string;
  label: string;
  page_count: number;
  printed_to_pdf_offset: number;
  pdf_path: string;
  image_dir: string;
  image_pattern: string;
  /** 'guide' | 'artbook' (migration 0007). */
  kind: "guide" | "artbook";
  /** Art books: {pdfPage, leftFolio} anchor of the folio rule; null for guides. */
  spread: { pdfPage: number; leftFolio: number } | null;
}

export const BOOK_COLUMNS = "id, title, label, page_count, printed_to_pdf_offset, pdf_path, image_dir, image_pattern, kind, spread";

export async function listBooks(pool: Pool): Promise<BookRow[]> {
  const { rows } = await pool.query<BookRow>(
    // guides first, then art books, each by id
    "SELECT " + BOOK_COLUMNS + " FROM books ORDER BY kind = 'artbook', id",
  );
  return rows;
}

/** book id -> short label ("vol1" -> "Vol 1"), as used in document titles and inline citation markers. */
export async function loadBookLabels(pool: Pool): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await listBooks(pool)) out[b.id] = b.label;
  return out;
}
