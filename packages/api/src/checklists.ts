/**
 * Checklists, runs and progress (docs/build-spec-checklist.md §4-5; tables in migrations 0008 and 0010). The routes
 * (routes/checklists.ts) talk to a ChecklistStore; pgChecklistStore is the Postgres one, the tests use a fake.
 */
import type { Pool } from "@miriel/shared/db";

export interface ChecklistSummary {
  id: string;
  title: string;
  label: string;
  author: string | null;
  sourceUrl: string | null;
  books: string[];
  items: number;
}

export interface ChecklistItemOut {
  id: string;
  ord: number;
  section: string;
  path: string[];
  text: string;
  prompt: string;
  optional: boolean;
  collectible: { name: string; n: number } | null;
  footnote: string | null;
  chain: string | null;
  npcs: unknown[];
  pages: { book: string; page: number; score?: number }[];
}

export interface ChecklistDetail extends ChecklistSummary {
  outline: ({ type: "item"; id: string } | { type: "heading" | "note"; [k: string]: unknown })[];
  chains: unknown[];
  footnotes: unknown[];
  itemRows: ChecklistItemOut[];
  /** Items that were in the list once and are gone now (their ticks are kept). */
  retired: { id: string; text: string; retiredAt: string }[];
}

export interface RunOut {
  id: string;
  name: string;
  createdAt: string;
  /** checklist id -> items done in this run (current items only). */
  done: Record<string, number>;
}

export interface ChecklistStore {
  listChecklists(): Promise<ChecklistSummary[]>;
  getChecklist(id: string): Promise<ChecklistDetail | null>;
  /** The current (not retired) item, for validating a tick. */
  itemExists(itemId: string): Promise<boolean>;
  listRuns(userId: string): Promise<RunOut[]>;
  /** The run's owner, or null when there is no such run. */
  runOwner(runId: string): Promise<string | null>;
  createRun(userId: string, name: string): Promise<RunOut>;
  renameRun(runId: string, name: string): Promise<RunOut | null>;
  deleteRun(runId: string): Promise<void>;
  progress(runId: string): Promise<Record<string, string>>;
  setDone(runId: string, itemId: string, done: boolean): Promise<string | null>;
}

export class RunNameTaken extends Error {}

interface ChecklistRow {
  id: string;
  title: string;
  label: string;
  author: string | null;
  source_url: string | null;
  books: string[];
}

const summary = (r: ChecklistRow, items: number): ChecklistSummary => ({
  id: r.id,
  title: r.title,
  label: r.label,
  author: r.author,
  sourceUrl: r.source_url,
  books: r.books,
  items,
});

export function pgChecklistStore(pool: Pool): ChecklistStore {
  const runOut = async (id: string): Promise<RunOut | null> => {
    const { rows } = await pool.query<{ id: string; name: string; created_at: Date }>("SELECT id, name, created_at FROM runs WHERE id = $1", [id]);
    if (!rows[0]) return null;
    const done = await pool.query<{ checklist_id: string; n: string }>(
      `SELECT i.checklist_id, count(*) AS n FROM progress p JOIN checklist_items i ON i.id = p.item_id AND i.retired_at IS NULL
        WHERE p.run_id = $1 GROUP BY i.checklist_id`,
      [id],
    );
    return { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at.toISOString(), done: Object.fromEntries(done.rows.map((d) => [d.checklist_id, Number(d.n)])) };
  };

  return {
    async listChecklists() {
      const { rows } = await pool.query<ChecklistRow & { items: string }>(
        `SELECT c.id, c.title, c.label, c.author, c.source_url, c.books,
                (SELECT count(*) FROM checklist_items i WHERE i.checklist_id = c.id AND i.retired_at IS NULL) AS items
           FROM checklists c ORDER BY c.sort, c.id`,
      );
      return rows.map((r) => summary(r, Number(r.items)));
    },

    async getChecklist(id) {
      const { rows } = await pool.query<ChecklistRow & { outline: ChecklistDetail["outline"]; chains: unknown[]; footnotes: unknown[] }>(
        "SELECT id, title, label, author, source_url, books, outline, chains, footnotes FROM checklists WHERE id = $1",
        [id],
      );
      const c = rows[0];
      if (!c) return null;
      const items = await pool.query<{
        id: string; ord: number; section: string; path: string[]; text: string; prompt: string; optional: boolean;
        collectible: ChecklistItemOut["collectible"]; footnote: string | null; chain: string | null; npcs: unknown[];
        pages: ChecklistItemOut["pages"]; retired_at: Date | null;
      }>(
        "SELECT id, ord, section, path, text, prompt, optional, collectible, footnote, chain, npcs, pages, retired_at FROM checklist_items WHERE checklist_id = $1 ORDER BY ord",
        [id],
      );
      const current = items.rows.filter((r) => !r.retired_at);
      return {
        ...summary(c, current.length),
        outline: c.outline,
        chains: c.chains,
        footnotes: c.footnotes,
        itemRows: current.map(({ retired_at: _r, ...rest }) => rest),
        retired: items.rows.filter((r) => r.retired_at).map((r) => ({ id: r.id, text: r.text, retiredAt: r.retired_at!.toISOString() })),
      };
    },

    async itemExists(itemId) {
      const { rows } = await pool.query("SELECT 1 FROM checklist_items WHERE id = $1 AND retired_at IS NULL", [itemId]);
      return rows.length > 0;
    },

    async listRuns(userId) {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM runs WHERE user_id = $1 ORDER BY created_at, name", [userId]);
      return (await Promise.all(rows.map((r) => runOut(r.id)))).filter((r): r is RunOut => r !== null);
    },

    async runOwner(runId) {
      const { rows } = await pool.query<{ user_id: string }>("SELECT user_id FROM runs WHERE id = $1", [runId]);
      return rows[0]?.user_id ?? null;
    },

    async createRun(userId, name) {
      try {
        const { rows } = await pool.query<{ id: string }>("INSERT INTO runs (user_id, name) VALUES ($1, $2) RETURNING id", [userId, name]);
        return (await runOut(rows[0]!.id))!;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new RunNameTaken(name);
        throw err;
      }
    },

    async renameRun(runId, name) {
      try {
        const { rowCount } = await pool.query("UPDATE runs SET name = $2 WHERE id = $1", [runId, name]);
        return rowCount ? runOut(runId) : null;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new RunNameTaken(name);
        throw err;
      }
    },

    async deleteRun(runId) {
      await pool.query("DELETE FROM runs WHERE id = $1", [runId]);
    },

    async progress(runId) {
      const { rows } = await pool.query<{ item_id: string; done_at: Date }>("SELECT item_id, done_at FROM progress WHERE run_id = $1", [runId]);
      return Object.fromEntries(rows.map((r) => [r.item_id, r.done_at.toISOString()]));
    },

    async setDone(runId, itemId, done) {
      if (!done) {
        await pool.query("DELETE FROM progress WHERE run_id = $1 AND item_id = $2", [runId, itemId]);
        return null;
      }
      const { rows } = await pool.query<{ done_at: Date }>(
        `INSERT INTO progress (run_id, item_id) VALUES ($1, $2)
         ON CONFLICT (run_id, item_id) DO UPDATE SET done_at = progress.done_at RETURNING done_at`,
        [runId, itemId],
      );
      return rows[0]!.done_at.toISOString();
    },
  };
}
