/**
 * Read-only views of what scripts/retake.py keeps under DATA_DIR/_versions/: its journals (one per retake,
 * CLI or worker, the source of the daily spend) and the per-book lock file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function versionsRoot(dataDir: string): string {
  return path.join(dataDir, "_versions");
}

export function journalPath(dataDir: string, book: string, txn: string): string {
  return path.join(versionsRoot(dataDir), "retakes", book, txn + ".json");
}

export interface Journal {
  id: string;
  book: string;
  kind: "retake" | "rollback";
  status: "running" | "failed" | "done" | "abandoned";
  created: string;
  stages: Record<string, string>;
  cost_usd?: number;
}

export function readJournal(dataDir: string, book: string, txn: string): Journal | undefined {
  const p = journalPath(dataDir, book, txn);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as Journal;
}

/** Local calendar date (YYYY-MM-DD), the same day boundary retake.py uses for its budget. */
export function localDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** USD spent on retake extraction today, over every book's journals. */
export function spentToday(dataDir: string, now = new Date()): number {
  const root = path.join(versionsRoot(dataDir), "retakes");
  if (!existsSync(root)) return 0;
  const today = localDate(now);
  let total = 0;
  for (const book of readdirSync(root, { withFileTypes: true })) {
    if (!book.isDirectory()) continue;
    for (const f of readdirSync(path.join(root, book.name))) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(path.join(root, book.name, f), "utf8")) as Journal;
        if (j.created.slice(0, 10) === today) total += j.cost_usd ?? 0;
      } catch {
        /* a journal being rewritten; it is counted on the next poll */
      }
    }
  }
  return total;
}

/** The retake id holding the book's lock, if any (a CLI run or an unfinished worker job). */
export function lockHolder(dataDir: string, book: string): string | undefined {
  const p = path.join(versionsRoot(dataDir), book + ".lock");
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8").trim() || undefined;
}
