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
}

export async function listBooks(pool: Pool): Promise<BookRow[]> {
  const { rows } = await pool.query<BookRow>(
    "SELECT id, title, label, page_count, printed_to_pdf_offset, pdf_path, image_dir, image_pattern FROM books ORDER BY id",
  );
  return rows;
}

/** book id -> short label ("vol1" -> "Vol 1"), as used in document titles and inline citation markers. */
export async function loadBookLabels(pool: Pool): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const b of await listBooks(pool)) out[b.id] = b.label;
  return out;
}
