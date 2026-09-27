/**
 * Read queries behind the HTTP routes. Each takes a Pool so tests can pass a fake.
 */
import { normalizeName } from "@miriel/shared";
import type { Pool } from "@miriel/shared/db";
import { BOOK_COLUMNS, type BookRow } from "./books.js";

export async function getBook(pool: Pool, id: string): Promise<BookRow | undefined> {
  const { rows } = await pool.query<BookRow>(
    "SELECT " + BOOK_COLUMNS + " FROM books WHERE id = $1",
    [id],
  );
  return rows[0];
}

export interface PageDetail {
  book: string;
  page: number;
  chapter: string | null;
  region: string | null;
  page_type: string;
  markdown: string;
  quality: unknown;
  figures: { figure_idx: number; kind: string; description: string; labels: string[]; legend: string | null }[];
  entities: {
    type: string;
    name: string;
    name_norm: string;
    location: string | null;
    how_to_obtain: string | null;
    connects_to: string[];
  }[];
  chunks: { chunk_idx: number; heading_path: string; token_count: number; text: string }[];
}

export async function getPage(pool: Pool, book: string, page: number): Promise<PageDetail | undefined> {
  const p = await pool.query<{ chapter: string | null; region: string | null; page_type: string; markdown: string; quality: unknown }>(
    "SELECT chapter, region, page_type, markdown, quality FROM pages WHERE book_id = $1 AND page = $2",
    [book, page],
  );
  const row = p.rows[0];
  if (!row) return undefined;
  const [figures, entities, chunks] = await Promise.all([
    pool.query<PageDetail["figures"][number]>(
      "SELECT figure_idx, kind, description, labels, legend FROM figures WHERE book_id = $1 AND page = $2 ORDER BY figure_idx",
      [book, page],
    ),
    pool.query<PageDetail["entities"][number]>(
      "SELECT type, name, name_norm, location, how_to_obtain, connects_to FROM entities WHERE book_id = $1 AND page = $2 ORDER BY entity_idx",
      [book, page],
    ),
    pool.query<PageDetail["chunks"][number]>(
      "SELECT chunk_idx, heading_path, token_count, text FROM chunks WHERE book_id = $1 AND page = $2 ORDER BY chunk_idx",
      [book, page],
    ),
  ]);
  return { book, page, ...row, figures: figures.rows, entities: entities.rows, chunks: chunks.rows };
}

export interface TypeaheadHit {
  name: string;
  nameNorm: string;
  types: string[];
  book: string;
  pages: number[];
  score: number;
}

/** Prefix matches first, then trigram similarity >= 0.3; grouped by name within a book. */
export async function typeahead(pool: Pool, q: string, bookIds: string[] | null, limit = 10): Promise<TypeaheadHit[]> {
  const norm = normalizeName(q);
  if (norm.length < 2) return [];
  const { rows } = await pool.query<{ name: string; name_norm: string; types: string[]; book_id: string; pages: number[]; score: number }>(
    `SELECT min(e.name) AS name, e.name_norm, array_agg(DISTINCT e.type ORDER BY e.type) AS types, e.book_id,
            array_agg(DISTINCT e.page ORDER BY e.page) AS pages,
            GREATEST(CASE WHEN e.name_norm LIKE $1 || '%' THEN 1.0 ELSE 0.0 END, similarity(e.name_norm, $1))::float8 AS score
     FROM entities e
     WHERE (e.name_norm LIKE $1 || '%' OR similarity(e.name_norm, $1) >= 0.3)
       AND ($2::text[] IS NULL OR e.book_id = ANY($2::text[]))
     GROUP BY e.book_id, e.name_norm
     ORDER BY score DESC, length(e.name_norm), e.name_norm
     LIMIT $3`,
    [norm, bookIds, limit],
  );
  return rows.map((r) => ({ name: r.name, nameNorm: r.name_norm, types: r.types, book: r.book_id, pages: r.pages, score: Number(r.score) }));
}
