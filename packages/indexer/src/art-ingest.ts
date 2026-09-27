/**
 * Art book ingest: out/<art id>/sNNNN.json (+ _overrides.json) -> art_spreads, artworks (docs/build-spec-artbooks.md §6).
 *
 * Per spread: validate, apply the hand corrections from _overrides.json (same rules as scripts/art_overrides.py),
 * embed one text per artwork (names, kind, section, description), replace the spread's rows in one transaction.
 * A spread whose label file and override entry hash to the stored source_hash is skipped unless --force.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { z } from "zod";
import { normalizeName, type ArtBookConfig, type EmbeddingProvider } from "@miriel/shared";
import { vectorLiteral, withTransaction } from "@miriel/shared/db";

const NameSchema = z.object({
  name: z.string().min(1),
  source: z.enum(["caption", "visual"]),
  verified: z.boolean().optional(),
  entity: z.string().nullable().optional(),
  match: z.string().optional(),
});
export type ArtName = z.infer<typeof NameSchema>;

const ArtworkSchema = z.object({
  boxes: z.array(z.int()),
  bbox: z.array(z.number()).length(4),
  kind: z.string().min(1),
  caption_ja: z.string().nullable(),
  names: z.array(NameSchema),
  description: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
});
type Artwork = z.infer<typeof ArtworkSchema>;

export const LabelFileSchema = z.object({
  book: z.string(),
  pdf_page: z.int().positive(),
  folios: z.array(z.int()),
  contents: z.array(z.object({
    chapter: z.string().nullable().optional(),
    section: z.string().nullable().optional(),
    section_ja: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
  })),
  artworks: z.array(ArtworkSchema),
  not_art: z.array(z.int()),
  section_heading_ja: z.string().nullable(),
  notes: z.string().nullable(),
});
export type LabelFile = z.infer<typeof LabelFileSchema>;

const OverrideFields = z.strictObject({
  names: z.array(NameSchema.pick({ name: true, source: true })).optional(),
  kind: z.string().optional(),
  caption_ja: z.string().nullable().optional(),
  description: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  drop: z.boolean().optional(),
});
const OverridesSchema = z.record(z.string().regex(/^\d+$/), z.object({ artworks: z.record(z.string().regex(/^\d+$/), OverrideFields).default({}), note: z.string().optional() }));
type SpreadOverride = z.infer<typeof OverridesSchema>[string];

export function loadOverrides(outDir: string): Record<string, SpreadOverride> {
  const file = path.join(outDir, "_overrides.json");
  if (!existsSync(file)) return {};
  return OverridesSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The label with a spread's overrides applied; overridden names come back without a guide check (see verifyNames). */
export function applyOverrides(label: LabelFile, spec: SpreadOverride | undefined): LabelFile {
  if (!spec) return label;
  const artworks = label.artworks.map((a) => ({ ...a }));
  for (const [idx, fields] of Object.entries(spec.artworks)) {
    const i = Number(idx) - 1;
    const art = artworks[i];
    if (!art) throw new Error("spread " + label.pdf_page + ": override for artwork " + idx + ", which does not exist (" + artworks.length + ")");
    if (fields.names) art.names = fields.names.map((n) => ({ ...n }));
    if (fields.kind !== undefined) art.kind = fields.kind;
    if (fields.caption_ja !== undefined) art.caption_ja = fields.caption_ja;
    if (fields.description !== undefined) art.description = fields.description;
    if (fields.confidence !== undefined) art.confidence = fields.confidence;
  }
  return { ...label, artworks: artworks.filter((_, i) => !spec.artworks[String(i + 1)]?.drop) };
}

/** Names without a `verified` flag (from overrides) are checked against the guides' entity names (exact name_norm). */
async function verifyNames(pool: pg.Pool, labels: LabelFile[]): Promise<void> {
  const pending = labels.flatMap((l) => l.artworks.flatMap((a) => a.names.filter((n) => n.verified === undefined)));
  if (!pending.length) return;
  const { rows } = await pool.query<{ name_norm: string; name: string }>(
    "SELECT DISTINCT ON (name_norm) name_norm, name FROM entities WHERE name_norm = ANY($1) ORDER BY name_norm, name",
    [[...new Set(pending.map((n) => normalizeName(n.name)))]],
  );
  const known = new Map(rows.map((r) => [r.name_norm, r.name]));
  for (const n of pending) {
    const entity = known.get(normalizeName(n.name));
    Object.assign(n, entity ? { verified: true, entity, match: "exact" } : { verified: false, entity: null, match: "none" });
  }
}

/** The text embedded for an artwork (also stored as search_text for full-text search). */
export function artworkSearchText(a: Artwork, section: string | null, region: string | null): string {
  const names = a.names.map((n) => n.name).join("; ");
  const place = [section, region && region !== section ? region : null].filter(Boolean).join(", ");
  return [names, a.kind, place, a.description].filter(Boolean).join(". ");
}

export interface ArtIngestOptions {
  bookId: string;
  book: ArtBookConfig;
  outDir: string;
  dryRun: boolean;
  force?: boolean | undefined;
  provider: EmbeddingProvider;
  pool: pg.Pool;
  dataDir?: string | undefined;
  log: (msg: string) => void;
}

export interface ArtIngestSummary {
  bookId: string;
  spreadsIndexed: number;
  spreadsUnchanged: number;
  skipped: { file: string; reason: string }[];
  artworks: number;
  names: number;
  verifiedNames: number;
  overriddenSpreads: number;
  embeddingTokens: number;
  embeddingRequests: number;
  embeddingModel: string;
  dryRun: boolean;
}

const FILE_RE = /^s(\d{4})\.json$/;

export async function upsertArtBook(pool: pg.Pool, id: string, b: ArtBookConfig): Promise<void> {
  await pool.query(
    `INSERT INTO books (id, title, label, source_book, pdf_path, image_dir, image_pattern, printed_to_pdf_offset, page_count, kind, spread)
     VALUES ($1, $2, $3, $2, $4, $5, $6, 0, $7, 'artbook', $8)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, label = EXCLUDED.label, source_book = EXCLUDED.source_book, pdf_path = EXCLUDED.pdf_path,
       image_dir = EXCLUDED.image_dir, image_pattern = EXCLUDED.image_pattern, printed_to_pdf_offset = 0,
       page_count = EXCLUDED.page_count, kind = 'artbook', spread = EXCLUDED.spread`,
    [id, b.title, b.label, b.pdf, b.imageDir, b.imagePattern, b.pageCount, JSON.stringify(b.spread)],
  );
}

interface Prepared {
  file: string;
  label: LabelFile;
  sourceHash: string;
  imageSha: string | null;
  texts: string[];
}

export async function ingestArtBook(o: ArtIngestOptions): Promise<ArtIngestSummary> {
  const summary: ArtIngestSummary = {
    bookId: o.bookId, spreadsIndexed: 0, spreadsUnchanged: 0, skipped: [], artworks: 0, names: 0, verifiedNames: 0,
    overriddenSpreads: 0, embeddingTokens: 0, embeddingRequests: 0, embeddingModel: o.provider.model, dryRun: o.dryRun,
  };
  if (!existsSync(o.outDir)) throw new Error("output directory not found: " + o.outDir);
  const overrides = loadOverrides(o.outDir);
  if (!o.dryRun) await upsertArtBook(o.pool, o.bookId, o.book);
  const stored = new Map<number, string>();
  if (!o.dryRun && !o.force) {
    const { rows } = await o.pool.query<{ pdf_page: number; source_hash: string }>(
      "SELECT pdf_page, source_hash FROM art_spreads WHERE book_id = $1",
      [o.bookId],
    );
    for (const r of rows) stored.set(r.pdf_page, r.source_hash);
  }

  const prepared: Prepared[] = [];
  for (const name of readdirSync(o.outDir).filter((f) => FILE_RE.test(f)).sort()) {
    const file = path.join(o.outDir, name);
    const bytes = readFileSync(file);
    let label: LabelFile;
    try {
      const parsed = LabelFileSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + ": " + i.message).join("; "));
      label = parsed.data;
      if (label.pdf_page !== Number(FILE_RE.exec(name)![1])) throw new Error("pdf_page " + label.pdf_page + " does not match the file name");
      if (label.book !== o.bookId) throw new Error("book " + label.book + " is not " + o.bookId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      o.log("skip " + name + ": " + reason);
      summary.skipped.push({ file: name, reason });
      continue;
    }
    const spec = overrides[String(label.pdf_page)];
    const sourceHash = createHash("sha256").update(bytes).update(JSON.stringify(spec ?? null)).digest("hex");
    if (stored.get(label.pdf_page) === sourceHash) {
      summary.spreadsUnchanged += 1;
      continue;
    }
    if (spec) summary.overriddenSpreads += 1;
    const applied = applyOverrides(label, spec);
    const imagePath = o.dataDir ? path.join(o.dataDir, o.book.imageDir, o.book.imagePattern.replace("{n}", String(label.pdf_page))) : null;
    const imageSha = imagePath && existsSync(imagePath) ? createHash("sha256").update(readFileSync(imagePath)).digest("hex") : null;
    prepared.push({ file: name, label: applied, sourceHash, imageSha, texts: [] });
  }
  if (summary.spreadsUnchanged) o.log(summary.spreadsUnchanged + " spread(s) unchanged since the last ingest (use --force to redo)");
  if (!o.dryRun) await verifyNames(o.pool, prepared.map((p) => p.label));

  for (const p of prepared) {
    const { section, region } = spreadPlace(p.label);
    p.texts = p.label.artworks.map((a) => artworkSearchText(a, section, region));
  }
  // embed in batches across spreads, then write spread by spread
  const all = prepared.flatMap((p) => p.texts);
  const vectors: number[][] = [];
  if (!o.dryRun) {
    for (let i = 0; i < all.length; i += o.provider.maxBatchSize) {
      const res = await o.provider.embed(all.slice(i, i + o.provider.maxBatchSize), "document");
      vectors.push(...res.embeddings);
      summary.embeddingTokens += res.tokens;
      summary.embeddingRequests += 1;
    }
    if (vectors.length !== all.length) throw new Error("embedding count mismatch");
  }
  let offset = 0;
  for (const p of prepared) {
    const v = vectors.slice(offset, offset + p.texts.length);
    offset += p.texts.length;
    if (!o.dryRun) await writeSpread(o.pool, o.bookId, p, v);
    summary.spreadsIndexed += 1;
    summary.artworks += p.label.artworks.length;
    for (const a of p.label.artworks) {
      summary.names += a.names.length;
      summary.verifiedNames += a.names.filter((n) => n.verified).length;
    }
  }
  return summary;
}

/** Most specific contents entry of the spread: its section, else its chapter; and its region. */
function spreadPlace(label: LabelFile): { section: string | null; region: string | null } {
  const e = label.contents[0];
  return { section: e?.section ?? e?.chapter ?? null, region: e?.region ?? null };
}

async function writeSpread(pool: pg.Pool, bookId: string, p: Prepared, vectors: number[][]): Promise<void> {
  const l = p.label;
  const { section, region } = spreadPlace(l);
  await withTransaction(pool, async (c) => {
    await c.query("DELETE FROM art_spreads WHERE book_id = $1 AND pdf_page = $2", [bookId, l.pdf_page]); // cascades to artworks
    await c.query(
      `INSERT INTO art_spreads (book_id, pdf_page, folios, contents, section_heading_ja, notes, source_hash, image_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [bookId, l.pdf_page, l.folios, JSON.stringify(l.contents), l.section_heading_ja, l.notes, p.sourceHash, p.imageSha],
    );
    for (const [i, a] of l.artworks.entries()) {
      const nameNorms = [...new Set(a.names.map((n) => normalizeName(n.name)).filter(Boolean))];
      const entityNorms = [...new Set(a.names.filter((n) => n.verified && n.entity).map((n) => normalizeName(n.entity!)))];
      await c.query(
        `INSERT INTO artworks (book_id, pdf_page, art_idx, bbox, kind, caption_ja, names, name_norms, entity_norms,
                               confidence, description, section, region, search_text, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [bookId, l.pdf_page, i + 1, a.bbox, a.kind, a.caption_ja, JSON.stringify(a.names), nameNorms, entityNorms,
         a.confidence, a.description, section, region, p.texts[i], vectorLiteral(vectors[i]!)],
      );
    }
  });
}

export function formatArtSummary(s: ArtIngestSummary): string {
  return [
    "art ingest " + s.bookId + (s.dryRun ? " (dry run)" : "") + ":",
    "  spreads: " + s.spreadsIndexed + " indexed, " + s.spreadsUnchanged + " unchanged, " + s.skipped.length + " skipped",
    "  artworks: " + s.artworks + ", names: " + s.names + " (" + s.verifiedNames + " verified)" +
      (s.overriddenSpreads ? ", overrides on " + s.overriddenSpreads + " spread(s)" : ""),
    "  embeddings: " + s.embeddingRequests + " request(s), " + s.embeddingTokens + " tokens (" + s.embeddingModel + ")",
  ].join("\n");
}
