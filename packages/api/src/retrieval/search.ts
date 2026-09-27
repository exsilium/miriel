/**
 * The two first-stage retrievers over `chunks`.
 */
import { vectorLiteral, type Pool } from "@miriel/shared/db";
import { buildLexicalQuery } from "./candidates.js";

export interface ChunkHit {
  book: string;
  page: number;
  chunk_idx: number;
  text: string;
  heading_path: string;
  score: number;
}

interface ChunkRow {
  book_id: string;
  page: number;
  chunk_idx: number;
  text: string;
  heading_path: string;
  score: number;
}

const toHit = (r: ChunkRow): ChunkHit => ({
  book: r.book_id,
  page: r.page,
  chunk_idx: r.chunk_idx,
  text: r.text,
  heading_path: r.heading_path,
  score: Number(r.score),
});

export const chunkKey = (h: { book: string; page: number; chunk_idx: number }): string =>
  h.book + ":" + h.page + ":" + h.chunk_idx;

/** Top k by cosine similarity (1 - cosine distance). */
export async function vectorSearch(pool: Pool, embedding: number[], k: number, bookIds: string[] | null): Promise<ChunkHit[]> {
  const { rows } = await pool.query<ChunkRow>(
    `SELECT c.book_id, c.page, c.chunk_idx, c.text, c.heading_path,
            (1 - (c.embedding <=> $1::vector))::float8 AS score
     FROM chunks c
     WHERE $2::text[] IS NULL OR c.book_id = ANY($2::text[])
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral(embedding), bookIds, k],
  );
  return rows.map(toHit);
}

/**
 * Top k by ts_rank_cd against websearch_to_tsquery('english', <content words
 * joined with " or ">); see buildLexicalQuery for why not the raw question.
 */
export async function lexicalSearch(pool: Pool, query: string, k: number, bookIds: string[] | null): Promise<ChunkHit[]> {
  const { rows } = await pool.query<ChunkRow>(
    `SELECT c.book_id, c.page, c.chunk_idx, c.text, c.heading_path,
            ts_rank_cd(c.tsv, q)::float8 AS score
     FROM chunks c, websearch_to_tsquery('english', $1) AS q
     WHERE c.tsv @@ q AND ($2::text[] IS NULL OR c.book_id = ANY($2::text[]))
     ORDER BY score DESC, c.book_id, c.page, c.chunk_idx
     LIMIT $3`,
    [buildLexicalQuery(query), bookIds, k],
  );
  return rows.map(toHit);
}

export interface PageRow {
  book_id: string;
  page: number;
  chapter: string | null;
  region: string | null;
  markdown: string;
}

/** Chunks of the given pages, in the pages' order then chunk order (at most `perPage` from each page). */
export async function pageChunks(pool: Pool, pages: { book: string; page: number }[], perPage = 6): Promise<ChunkHit[]> {
  if (pages.length === 0) return [];
  const { rows } = await pool.query<ChunkRow & { ord: number }>(
    `SELECT c.book_id, c.page, c.chunk_idx, c.text, c.heading_path, 1::float8 AS score, want.ord
     FROM chunks c
     JOIN unnest($1::text[], $2::int[]) WITH ORDINALITY AS want(book_id, page, ord) ON want.book_id = c.book_id AND want.page = c.page
     WHERE c.chunk_idx < $3
     ORDER BY want.ord, c.chunk_idx`,
    [pages.map((p) => p.book), pages.map((p) => p.page), perPage],
  );
  return rows.map(toHit);
}

export async function fetchPages(pool: Pool, pages: { book: string; page: number }[]): Promise<PageRow[]> {
  if (pages.length === 0) return [];
  const { rows } = await pool.query<PageRow>(
    `SELECT p.book_id, p.page, p.chapter, p.region, p.markdown
     FROM pages p
     JOIN unnest($1::text[], $2::int[]) AS want(book_id, page) ON want.book_id = p.book_id AND want.page = p.page`,
    [pages.map((p) => p.book), pages.map((p) => p.page)],
  );
  return rows;
}
