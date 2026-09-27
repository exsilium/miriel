/**
 * Checklist ingest (docs/build-spec-checklist.md §6 Phase D): out/checklists/<id>.json (scripts/checklist_build.py)
 * + <id>_pages.json (`npm run checklist-pages`) + <id>_overrides.json (hand corrections) -> checklists,
 * checklist_items.
 *
 * One transaction per checklist: the list row (outline, chains, footnotes), every item upserted by its id, and
 * items no longer in the list retired (retired_at) rather than deleted, so progress rows keep pointing at them.
 * A checklist whose three files and config hash to the stored source_hash is skipped unless --force. No
 * embeddings: the items' page links were found at build time.
 *
 * Overrides, applied here and by scripts/checklist_qa.py, never by the builders:
 *   {"items": {"m042": {"pages": [{"book": "vol1", "page": 369}], "prompt": "...", "note": "why"}}}
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { z } from "zod";
import type { ChecklistConfig } from "@miriel/shared";
import { withTransaction } from "@miriel/shared/db";

const PageRef = z.object({ book: z.string(), page: z.int() });

const NpcSchema = z.object({
  name: z.string(),
  norm: z.string().nullable(),
  entity: z.string().optional(),
  match: z.string(),
  chapter: z.object({ book: z.string(), title: z.string(), from: z.int(), to: z.int() }).nullable(),
});

const ItemRow = z.object({
  type: z.literal("item"),
  id: z.string().regex(/^[a-z]+\d+$/),
  ord: z.int().positive(),
  section: z.string(),
  path: z.array(z.string()),
  text: z.string().min(1),
  prompt: z.string().min(1),
  optional: z.boolean(),
  collectible: z.object({ name: z.string(), n: z.int() }).nullable(),
  footnote: z.string().nullable(),
  chain: z.string().nullable(),
  npcs: z.array(NpcSchema),
});
const HeadingRow = z.object({ type: z.literal("heading"), section: z.string(), level: z.int(), title: z.string(), path: z.array(z.string()) });
const NoteRow = z.object({ type: z.literal("note"), section: z.string(), text: z.string() });

export const ChecklistFileSchema = z.object({
  checklist: z.string(),
  sourceSha256: z.string(),
  chains: z.array(z.object({ id: z.string(), label: z.string(), items: z.array(z.string()) })),
  footnotes: z.array(z.object({ id: z.string(), marker: z.string(), label: z.string(), section: z.string(), items: z.array(z.string()) })),
  rows: z.array(z.discriminatedUnion("type", [ItemRow, HeadingRow, NoteRow])),
});
export type ChecklistFile = z.infer<typeof ChecklistFileSchema>;
export type ChecklistItem = z.infer<typeof ItemRow>;

const PagesFileSchema = z.record(
  z.string(),
  z.object({ key: z.string(), pages: z.array(PageRef.extend({ score: z.number().optional(), chunks: z.int().optional() })) }).passthrough(),
);

const OverridesSchema = z.object({
  items: z.record(z.string(), z.strictObject({ pages: z.array(PageRef).optional(), prompt: z.string().min(1).optional(), note: z.string().optional() })).default({}),
});
type Overrides = z.infer<typeof OverridesSchema>;

export interface ChecklistIngestOptions {
  id: string;
  config: ChecklistConfig;
  /** out/checklists */
  dir: string;
  pool: pg.Pool;
  dryRun: boolean;
  force: boolean;
  /** Sort position among the configured checklists. */
  sort: number;
  log: (msg: string) => void;
}

export interface ChecklistIngestSummary {
  id: string;
  items: number;
  withPages: number;
  overridden: number;
  retired: number;
  unchanged: boolean;
  dryRun: boolean;
}

export interface PreparedChecklist {
  file: ChecklistFile;
  items: (ChecklistItem & { pages: { book: string; page: number; score?: number | undefined }[] })[];
  outline: unknown[];
  overridden: number;
  hash: string;
}

/** Reads and joins the three files; throws with the file name on anything malformed. */
export function prepareChecklist(id: string, config: ChecklistConfig, dir: string): PreparedChecklist {
  const buildFile = path.join(dir, id + ".json");
  if (!existsSync(buildFile)) throw new Error(buildFile + " is missing; run scripts/checklist_build.py --checklist " + id);
  const buildBytes = readFileSync(buildFile);
  const parsed = ChecklistFileSchema.safeParse(JSON.parse(buildBytes.toString("utf8")));
  if (!parsed.success) throw new Error(buildFile + ": " + parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + ": " + i.message).join("; "));
  const file = parsed.data;
  if (file.checklist !== id) throw new Error(buildFile + ": checklist " + file.checklist + " is not " + id);

  const pagesFile = path.join(dir, id + "_pages.json");
  const pagesBytes = existsSync(pagesFile) ? readFileSync(pagesFile) : Buffer.from("{}");
  const pages = PagesFileSchema.parse(JSON.parse(pagesBytes.toString("utf8")));
  const overridesFile = path.join(dir, id + "_overrides.json");
  const overridesBytes = existsSync(overridesFile) ? readFileSync(overridesFile) : Buffer.from("{}");
  const overrides: Overrides = OverridesSchema.parse(JSON.parse(overridesBytes.toString("utf8")));

  const itemRows = file.rows.filter((r): r is ChecklistItem => r.type === "item");
  const ids = new Set(itemRows.map((r) => r.id));
  if (ids.size !== itemRows.length) throw new Error(buildFile + ": duplicate item ids");
  for (const k of Object.keys(overrides.items)) if (!ids.has(k)) throw new Error(overridesFile + ": item " + k + " is not in " + id);

  let overridden = 0;
  const books = new Set(config.books);
  const items = itemRows.map((r) => {
    const o = overrides.items[r.id];
    if (o) overridden += 1;
    const found = (pages[r.id]?.pages ?? []).map((p) => ({ book: p.book, page: p.page, score: p.score }));
    const chosen = o?.pages ?? found;
    for (const p of chosen) if (!books.has(p.book)) throw new Error(id + " " + r.id + ": page " + p.book + ":" + p.page + " is outside the checklist's books");
    return { ...r, prompt: o?.prompt ?? r.prompt, pages: chosen };
  });
  const outline = file.rows.map((r) =>
    r.type === "item" ? { type: "item", id: r.id } : r.type === "heading" ? { type: "heading", section: r.section, level: r.level, title: r.title, path: r.path } : { type: "note", section: r.section, text: r.text },
  );
  const hash = createHash("sha256").update(buildBytes).update(pagesBytes).update(overridesBytes).update(JSON.stringify(config)).digest("hex");
  return { file, items, outline, overridden, hash };
}

export async function ingestChecklist(o: ChecklistIngestOptions): Promise<ChecklistIngestSummary> {
  const prep = prepareChecklist(o.id, o.config, o.dir);
  const summary: ChecklistIngestSummary = {
    id: o.id,
    items: prep.items.length,
    withPages: prep.items.filter((i) => i.pages.length).length,
    overridden: prep.overridden,
    retired: 0,
    unchanged: false,
    dryRun: o.dryRun,
  };
  if (o.dryRun) return summary;
  if (!o.force) {
    const { rows } = await o.pool.query<{ source_hash: string | null }>("SELECT source_hash FROM checklists WHERE id = $1", [o.id]);
    if (rows[0]?.source_hash === prep.hash) return { ...summary, unchanged: true };
  }
  const c = o.config;
  await withTransaction(o.pool, async (client) => {
    await client.query(
      `INSERT INTO checklists (id, title, label, author, source_url, books, sort, outline, chains, footnotes, source_hash, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (id) DO UPDATE SET title = $2, label = $3, author = $4, source_url = $5, books = $6, sort = $7, outline = $8,
         chains = $9, footnotes = $10, source_hash = $11, indexed_at = now()`,
      [o.id, c.title, c.label, c.author ?? null, c.sourceUrl ?? null, c.books, o.sort, JSON.stringify(prep.outline),
       JSON.stringify(prep.file.chains), JSON.stringify(prep.file.footnotes), prep.hash],
    );
    const clash = await client.query<{ id: string; checklist_id: string }>(
      "SELECT id, checklist_id FROM checklist_items WHERE id = ANY($1) AND checklist_id <> $2 LIMIT 1",
      [prep.items.map((i) => i.id), o.id],
    );
    if (clash.rows[0]) throw new Error("item id " + clash.rows[0].id + " already belongs to checklist " + clash.rows[0].checklist_id + "; give each list its own idPrefix");
    for (const i of prep.items) {
      await client.query(
        `INSERT INTO checklist_items (id, checklist_id, ord, section, path, text, prompt, optional, collectible, footnote, chain, npcs, pages, retired_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL)
         ON CONFLICT (id) DO UPDATE SET ord = $3, section = $4, path = $5, text = $6, prompt = $7, optional = $8, collectible = $9,
           footnote = $10, chain = $11, npcs = $12, pages = $13, retired_at = NULL`,
        [i.id, o.id, i.ord, i.section, i.path, i.text, i.prompt, i.optional, i.collectible ? JSON.stringify(i.collectible) : null,
         i.footnote, i.chain, JSON.stringify(i.npcs), JSON.stringify(i.pages)],
      );
    }
    const retired = await client.query(
      "UPDATE checklist_items SET retired_at = now() WHERE checklist_id = $1 AND retired_at IS NULL AND NOT (id = ANY($2))",
      [o.id, prep.items.map((i) => i.id)],
    );
    summary.retired = retired.rowCount ?? 0;
  });
  return summary;
}

export function formatChecklistSummary(s: ChecklistIngestSummary): string {
  if (s.unchanged) return "checklist " + s.id + ": unchanged (" + s.items + " items)";
  return (
    "checklist " + s.id + (s.dryRun ? " (dry run)" : "") + ": " + s.items + " items, " + s.withPages + " with page links, " +
    s.overridden + " overridden" + (s.dryRun ? "" : ", " + s.retired + " retired")
  );
}
