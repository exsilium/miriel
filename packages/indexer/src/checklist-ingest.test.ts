import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChecklistConfig } from "@miriel/shared";
import { prepareChecklist } from "./checklist-ingest.js";

const CONFIG: ChecklistConfig = {
  title: "T", label: "L", file: "checklists/main.md", books: ["vol1", "vol2"], idPrefix: "m", markers: {},
};

const item = (id: string, ord: number) => ({
  type: "item", id, ord, section: "limgrave", path: ["Limgrave"], text: "Talk to **Boc**", prompt: "[Limgrave] Talk to Boc",
  optional: false, collectible: null, footnote: null, chain: null,
  npcs: [{ name: "Boc", norm: "boc", entity: "Boc", match: "exact", chapter: { book: "vol1", title: "Boc the Seamster", from: 369, to: 372 } }],
});

function dir(files: Record<string, unknown>): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "miriel-cl-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(d, name), JSON.stringify(body));
  return d;
}

const BUILD = {
  checklist: "main",
  sourceSha256: "abc",
  chains: [],
  footnotes: [],
  rows: [
    { type: "heading", section: "limgrave", level: 2, title: "Limgrave", path: ["Limgrave"] },
    item("m001", 1),
    { type: "note", section: "limgrave", text: "Note: n" },
    item("m002", 2),
  ],
};
const PAGES = { m001: { key: "k1", pages: [{ book: "vol1", page: 61, score: 0.06, chunks: 2 }] } };

test("prepareChecklist joins build, pages and overrides; the outline keeps file order", () => {
  const d = dir({ "main.json": BUILD, "main_pages.json": PAGES, "main_overrides.json": { items: { m002: { pages: [{ book: "vol1", page: 369 }], note: "chapter page" } } } });
  const p = prepareChecklist("main", CONFIG, d);
  assert.deepEqual(p.items.map((i) => [i.id, i.pages.map((x) => x.page)]), [["m001", [61]], ["m002", [369]]]);
  assert.equal(p.overridden, 1);
  assert.deepEqual(p.outline.map((r) => (r as { type: string }).type), ["heading", "item", "note", "item"]);
  assert.deepEqual(p.outline[1], { type: "item", id: "m001" });
});

test("prepareChecklist: the hash changes with the overrides; bad overrides and foreign pages are refused", () => {
  const a = prepareChecklist("main", CONFIG, dir({ "main.json": BUILD, "main_pages.json": PAGES }));
  const b = prepareChecklist("main", CONFIG, dir({ "main.json": BUILD, "main_pages.json": PAGES, "main_overrides.json": { items: { m001: { prompt: "x" } } } }));
  assert.notEqual(a.hash, b.hash);
  assert.equal(b.items[0]!.prompt, "x");
  assert.throws(() => prepareChecklist("main", CONFIG, dir({ "main.json": BUILD, "main_overrides.json": { items: { m404: { prompt: "x" } } } })), /m404 is not in main/);
  assert.throws(
    () => prepareChecklist("main", CONFIG, dir({ "main.json": BUILD, "main_pages.json": { m001: { key: "k", pages: [{ book: "vol3", page: 1 }] } } })),
    /outside the checklist's books/,
  );
  assert.throws(() => prepareChecklist("main", CONFIG, dir({ "main.json": { ...BUILD, checklist: "dlc" } })), /checklist dlc is not main/);
  assert.throws(() => prepareChecklist("main", CONFIG, dir({})), /missing/);
});
