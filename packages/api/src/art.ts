/**
 * Art book queries (docs/build-spec-artbooks.md §6): spread detail, artwork lookup, and artwork search by guide
 * entity (name_norm) or by text (vector + full text). Used by the HTTP routes and, in Phase D, by the chat route.
 */
import type { Pool } from "@miriel/shared/db";
import { vectorLiteral } from "@miriel/shared/db";
import { shortVersion } from "./versions.js";

export interface ArtName {
  name: string;
  source: "caption" | "visual";
  verified: boolean;
  entity: string | null;
  match: string;
}

export interface Artwork {
  id: number;
  book: string;
  pdfPage: number;
  artIdx: number;
  folios: number[];
  bbox: [number, number, number, number];
  kind: string;
  captionJa: string | null;
  names: ArtName[];
  confidence: "high" | "medium" | "low";
  description: string;
  section: string | null;
  /** sha256 prefix of the spread JPEG: ?v= for spread images and crops. */
  imageVersion: string | null;
}

interface ArtworkRow {
  id: string;
  book_id: string;
  pdf_page: number;
  art_idx: number;
  folios: number[];
  bbox: number[];
  kind: string;
  caption_ja: string | null;
  names: ArtName[];
  confidence: Artwork["confidence"];
  description: string;
  section: string | null;
  image_sha256: string | null;
}

const COLUMNS = `a.id, a.book_id, a.pdf_page, a.art_idx, s.folios, a.bbox, a.kind, a.caption_ja, a.names, a.confidence,
                 a.description, a.section, s.image_sha256`;
const FROM = "FROM artworks a JOIN art_spreads s ON s.book_id = a.book_id AND s.pdf_page = a.pdf_page";

function toArtwork(r: ArtworkRow): Artwork {
  return {
    id: Number(r.id),
    book: r.book_id,
    pdfPage: r.pdf_page,
    artIdx: r.art_idx,
    folios: r.folios,
    bbox: r.bbox.map(Number) as Artwork["bbox"],
    kind: r.kind,
    captionJa: r.caption_ja,
    names: r.names,
    confidence: r.confidence,
    description: r.description,
    section: r.section,
    imageVersion: shortVersion(r.image_sha256),
  };
}

export interface SpreadDetail {
  book: string;
  pdfPage: number;
  folios: number[];
  labelled: boolean;
  contents: unknown[];
  sectionHeadingJa: string | null;
  imageVersion: string | null;
  artworks: Artwork[];
}

export async function getSpread(pool: Pool, book: string, pdfPage: number): Promise<SpreadDetail | undefined> {
  const s = await pool.query<{ folios: number[]; contents: unknown[]; section_heading_ja: string | null; image_sha256: string | null }>(
    "SELECT folios, contents, section_heading_ja, image_sha256 FROM art_spreads WHERE book_id = $1 AND pdf_page = $2",
    [book, pdfPage],
  );
  const row = s.rows[0];
  if (!row) return undefined;
  const a = await pool.query<ArtworkRow>(`SELECT ${COLUMNS} ${FROM} WHERE a.book_id = $1 AND a.pdf_page = $2 ORDER BY a.art_idx`, [book, pdfPage]);
  return {
    book,
    pdfPage,
    folios: row.folios,
    labelled: true,
    contents: row.contents,
    sectionHeadingJa: row.section_heading_ja,
    imageVersion: shortVersion(row.image_sha256),
    artworks: a.rows.map(toArtwork),
  };
}

export interface ArtworkLocation extends Artwork {
  imageDir: string;
  imagePattern: string;
}

export async function getArtwork(pool: Pool, id: number): Promise<ArtworkLocation | undefined> {
  const { rows } = await pool.query<ArtworkRow & { image_dir: string; image_pattern: string }>(
    `SELECT ${COLUMNS}, b.image_dir, b.image_pattern ${FROM} JOIN books b ON b.id = a.book_id WHERE a.id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { ...toArtwork(r), imageDir: r.image_dir, imagePattern: r.image_pattern } : undefined;
}

/**
 * Artworks whose names or verified guide names are one of the given name_norm values, or start or end with one of
 * them as whole words ("malenia" finds "malenia blade of miquella"; the caller decides which of those count).
 */
export async function artworksForEntities(pool: Pool, nameNorms: string[], bookIds?: string[], limit = 50): Promise<Artwork[]> {
  if (!nameNorms.length) return [];
  const { rows } = await pool.query<ArtworkRow>(
    `SELECT ${COLUMNS} ${FROM}
      WHERE (a.entity_norms && $1::text[] OR a.name_norms && $1::text[]
             OR EXISTS (SELECT 1 FROM unnest(a.name_norms || a.entity_norms) n, unnest($1::text[]) q
                         WHERE n LIKE q || ' %' OR n LIKE '% ' || q))
        AND ($2::text[] IS NULL OR a.book_id = ANY($2::text[]))
      ORDER BY a.book_id, a.pdf_page, a.art_idx
      LIMIT $3`,
    [nameNorms, bookIds?.length ? bookIds : null, limit],
  );
  return rows.map(toArtwork);
}

export interface ScoredArtwork extends Artwork {
  /** Cosine similarity to the query (1 = identical). */
  similarity: number;
}

/** Nearest artworks to a query vector (HNSW), optionally limited to some art books. */
export async function artworksByVector(pool: Pool, vector: number[], bookIds?: string[], limit = 12): Promise<ScoredArtwork[]> {
  const { rows } = await pool.query<ArtworkRow & { distance: number }>(
    `SELECT ${COLUMNS}, (a.embedding <=> $1::vector) AS distance ${FROM}
      WHERE ($2::text[] IS NULL OR a.book_id = ANY($2::text[]))
      ORDER BY a.embedding <=> $1::vector
      LIMIT $3`,
    [vectorLiteral(vector), bookIds?.length ? bookIds : null, limit],
  );
  return rows.map((r) => ({ ...toArtwork(r), similarity: 1 - Number(r.distance) }));
}
