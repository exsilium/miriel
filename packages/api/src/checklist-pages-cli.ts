#!/usr/bin/env node
/**
 * Guide pages for every checklist item (docs/build-spec-checklist.md §3 decision 5):
 *   npm run checklist-pages [-- --checklist main] [--force] [--concurrency 3]
 *
 * Reads out/checklists/<id>.json (scripts/checklist_build.py), runs retrieval on each item's prompt within the
 * checklist's books and writes out/checklists/<id>_pages.json: {itemId: {key, pages[{book, page, score, chunks}],
 * anchors[], routeQuestion}}. The top pages feed "Open page" and the chat `focus`. Incremental: an item is looked up
 * again only when its prompt or the book scope changed (`key`), or with --force.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createEmbeddingProvider, describeError, findRepoRoot, loadDotEnv } from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { retrieve, type RetrievalResult } from "./retrieval/index.js";

/** Pages kept per item. */
const PAGES_PER_ITEM = 3;

interface ChecklistItem {
  type: "item";
  id: string;
  prompt: string;
}

interface ItemPages {
  key: string;
  pages: { book: string; page: number; score: number; chunks: number }[];
  anchors: string[];
  routeQuestion: boolean;
}

/** Distinct pages of the retrieved chunks in rank order, with the best chunk score and the chunk count. */
function topPages(r: RetrievalResult, n = PAGES_PER_ITEM): ItemPages["pages"] {
  const byPage = new Map<string, { book: string; page: number; score: number; chunks: number }>();
  for (const c of r.chunks) {
    const k = c.book + ":" + c.page;
    const hit = byPage.get(k);
    if (hit) hit.chunks += 1;
    else byPage.set(k, { book: c.book, page: c.page, score: Number(c.score.toFixed(4)), chunks: 1 });
  }
  return [...byPage.values()].slice(0, n);
}

function itemKey(prompt: string, books: string[]): string {
  return createHash("sha256").update(prompt + "\n" + [...books].sort().join(",")).digest("hex").slice(0, 16);
}

const { values } = parseArgs({
  options: {
    checklist: { type: "string", multiple: true },
    force: { type: "boolean", default: false },
    concurrency: { type: "string", default: "3" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  process.stderr.write("usage: checklist-pages [--checklist main] [--force] [--concurrency 3]\n");
  process.exit(0);
}

loadDotEnv();
const root = findRepoRoot();
const config = JSON.parse(readFileSync(path.join(root, "config", "checklists.json"), "utf8")) as Record<string, { books: string[] }>;
const ids = values.checklist ?? Object.keys(config);
for (const id of ids) if (!config[id]) throw new Error("unknown checklist " + id + "; configured: " + Object.keys(config).join(", "));

const pool = createPool();
const embedder = createEmbeddingProvider();
try {
  for (const id of ids) {
    const books = config[id]!.books;
    const src = path.join(root, "out", "checklists", id + ".json");
    if (!existsSync(src)) throw new Error(src + " is missing; run scripts/checklist_build.py first");
    const items = (JSON.parse(readFileSync(src, "utf8")) as { rows: { type: string }[] }).rows.filter(
      (r): r is ChecklistItem => r.type === "item",
    );
    const outFile = path.join(root, "out", "checklists", id + "_pages.json");
    const done: Record<string, ItemPages> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
    const live = new Set(items.map((i) => i.id));
    for (const k of Object.keys(done)) if (!live.has(k)) delete done[k];

    const todo = items.filter((i) => values.force || done[i.id]?.key !== itemKey(i.prompt, books));
    process.stdout.write(id + ": " + items.length + " items, " + todo.length + " to look up (" + books.join(", ") + ")\n");
    const save = () => {
      const sorted = Object.fromEntries(Object.entries(done).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(outFile + ".tmp", JSON.stringify(sorted, null, 2) + "\n");
      renameSync(outFile + ".tmp", outFile);
    };

    let next = 0;
    let tokens = 0;
    let failed = 0;
    let completed = 0;
    const started = Date.now();
    const worker = async () => {
      while (next < todo.length) {
        const item = todo[next++]!;
        try {
          const r = await retrieve({ pool, embedder }, item.prompt, { bookIds: books });
          tokens += r.stats.embeddingTokens;
          done[item.id] = {
            key: itemKey(item.prompt, books),
            pages: topPages(r),
            anchors: r.anchors.entities.map((e) => e.name).slice(0, 8),
            routeQuestion: r.routeQuestion,
          };
        } catch (err) {
          failed += 1;
          process.stderr.write("  " + item.id + ": " + describeError(err) + "\n");
        }
        completed += 1;
        if (completed % 20 === 0) {
          save();
          process.stdout.write("  " + completed + "/" + todo.length + "\n");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker));
    save();
    process.stdout.write(
      "  " + (todo.length - failed) + " looked up, " + failed + " failed, " + tokens + " embedding tokens, " +
        ((Date.now() - started) / 1000).toFixed(1) + " s -> out/checklists/" + id + "_pages.json\n",
    );
    if (failed) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
