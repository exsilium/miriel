import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "@miriel/shared";
import {
  DEFAULT_CHUNK_OPTIONS,
  chunkFigures,
  chunkMarkdown,
  chunkPage,
  packPieces,
  parseBlocks,
  type ChunkOptions,
} from "./chunker.js";

const OPTS: ChunkOptions = DEFAULT_CHUNK_OPTIONS;

/** Roughly `n` tokens of distinct prose sentences. */
function prose(n: number): string {
  const out: string[] = [];
  let tok = 0;
  for (let i = 0; tok < n; i++) {
    const s = "Sentence number " + i + " walks the Tarnished onward through the mist.";
    out.push(s);
    tok += countTokens(s);
  }
  return out.join(" ");
}

function tableRows(n: number): string {
  const lines = ["| Attribute | Default | 1 Ally | 2 Allies |", "| --- | --- | --- | --- |"];
  for (let i = 0; i < n; i++) lines.push("| Stat " + i + " | 100% | 130% | 150% |");
  return lines.join("\n");
}

test("parseBlocks recognises headings, paragraphs, tables, quotes, lists", () => {
  const md = [
    "## 24 West Windmill Pasture",
    "",
    "A paragraph",
    "on two lines.",
    "",
    "| | |",
    "| --- | --- |",
    "| **Notable Treasure** | Giant Rat Ashes |",
    "",
    "> **Tip**",
    "> Use the ledge.",
    "",
    "- one",
    "- two",
    "  continued",
    "",
    "[FIGURE 1: screenshot]",
  ].join("\n");
  const kinds = parseBlocks(md).map((b) => b.kind);
  assert.deepEqual(kinds, ["heading", "para", "table", "quote", "list", "para"]);
  const table = parseBlocks(md).find((b) => b.kind === "table");
  assert.ok(table && table.kind === "table");
  assert.equal(table.header.length, 2);
  assert.equal(table.rows.length, 1);
});

test("sections never merge across headings; heading path follows relative depth", () => {
  const md = [
    "## Lenne's Rise",
    "",
    prose(40),
    "",
    "### Items",
    "",
    prose(40),
    "",
    "## Next Place",
    "",
    prose(40),
  ].join("\n");
  const chunks = chunkMarkdown(md, ["Liurnia"], OPTS);
  assert.deepEqual(
    chunks.map((c) => c.headingPath),
    ["Liurnia > Lenne's Rise", "Liurnia > Lenne's Rise > Items", "Liurnia > Next Place"],
  );
  for (const c of chunks) assert.ok(!c.text.startsWith("#"), "heading line is carried by heading_path, not text");
});

test("consecutive sections with an identical heading path are one section", () => {
  // p. 289 prints one Items table as three columns, each transcribed under its own "## Items".
  const md = ["## Items", "", tableRows(10), "", "## Items", "", tableRows(10), "", "## Enemies", "", tableRows(3)].join("\n");
  const chunks = chunkMarkdown(md, ["Haligtree"], OPTS);
  assert.deepEqual(chunks.map((c) => c.headingPath), ["Haligtree > Items", "Haligtree > Enemies"]);
  assert.equal(chunks[0]!.text.split("\n").filter((l) => l.startsWith("| Stat")).length, 20);
});

test("a section that fits under max is kept whole even when above target", () => {
  const md = ["## A", "", prose(300), "", prose(250)].join("\n");
  const chunks = chunkMarkdown(md, [], OPTS);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.tokenCount > OPTS.targetTokens && chunks[0]!.tokenCount <= OPTS.maxTokens);
});

test("a long section is packed to about target and never exceeds max", () => {
  const paras = Array.from({ length: 8 }, () => prose(220));
  const md = ["## A", "", paras.join("\n\n")].join("\n");
  const chunks = chunkMarkdown(md, [], OPTS);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.tokenCount <= OPTS.maxTokens, "chunk over max: " + c.tokenCount);
  // no tiny fragments left at the end of the section
  assert.ok(chunks[chunks.length - 1]!.tokenCount >= OPTS.minTailTokens);
});

test("an oversize paragraph is split on sentence boundaries", () => {
  const md = prose(1500);
  const chunks = chunkMarkdown(md, ["R"], OPTS);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.tokenCount <= OPTS.maxTokens);
    assert.match(c.text, /\.$/);
  }
});

test("an oversize table is split by rows with the header repeated", () => {
  const md = ["## Stats", "", tableRows(120)].join("\n");
  const chunks = chunkMarkdown(md, [], OPTS);
  assert.ok(chunks.length >= 2);
  let rows = 0;
  for (const c of chunks) {
    assert.ok(c.tokenCount <= OPTS.maxTokens);
    const lines = c.text.split("\n");
    assert.equal(lines[0], "| Attribute | Default | 1 Ally | 2 Allies |");
    assert.match(lines[1]!, /^\| --- /);
    rows += lines.length - 2;
  }
  assert.equal(rows, 120, "every data row appears exactly once");
});

test("a small table stays whole together with its paragraph", () => {
  const md = ["## A", "", prose(60), "", tableRows(4)].join("\n");
  const chunks = chunkMarkdown(md, [], OPTS);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.text.includes("| Stat 3 |"));
});

test("an oversize sidebar is split by lines with the bold title repeated", () => {
  const lines = ["> **Boss Strategy**"];
  for (let i = 0; i < 90; i++) lines.push("> Step " + i + ": roll through the sweep and punish the recovery.");
  const chunks = chunkMarkdown(lines.join("\n"), [], OPTS);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.text.startsWith("> **Boss Strategy**\n"));
});

test("packPieces returns nothing for empty input and keeps a single big piece intact", () => {
  assert.deepEqual(packPieces([], "\n", null, OPTS), []);
  const big = prose(700);
  assert.deepEqual(packPieces([big], "\n", null, OPTS), [big]);
});

test("figures become their own chunks under '<root> > Figure n'", () => {
  const chunks = chunkFigures(
    [
      { kind: "screenshot", description: "Player at the ledge.", labels: [], legend: null },
      {
        kind: "map",
        description: "Map of Limgrave.",
        labels: ["1", "2", "3"],
        legend: "1 = Site of Grace, 2 = Meteorite Staff, 3 = Dominula, Windmill Village",
      },
    ],
    ["Limgrave"],
    OPTS,
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.headingPath, "Limgrave > Figure 1");
  assert.equal(chunks[1]!.headingPath, "Limgrave > Figure 2");
  assert.equal(chunks[1]!.text, "Map of Limgrave.\n\nLabels: 1; 2; 3\n\nLegend: 1 = Site of Grace, 2 = Meteorite Staff, 3 = Dominula, Windmill Village");
});

test("an oversize legend splits before 'N =' entries, not inside names with commas", () => {
  const entries: string[] = [];
  for (let i = 1; i <= 250; i++) entries.push(i + " = Dominula, Windmill Village " + i);
  const chunks = chunkFigures(
    [{ kind: "map", description: "Big map.", labels: [], legend: entries.join(", ") }],
    [],
    OPTS,
  );
  assert.ok(chunks.length >= 2);
  const legendParts = chunks.filter((c) => c.text.includes("Legend: "));
  for (const c of legendParts) {
    assert.ok(c.tokenCount <= OPTS.maxTokens);
    for (const line of c.text.split("\n\n")) {
      if (line.startsWith("Legend: ")) assert.match(line, /^Legend: \d+ = /);
    }
  }
  const joined = chunks.map((c) => c.text).join(" ");
  assert.ok(joined.includes("250 = Dominula, Windmill Village 250"));
});

test("chunkPage uses region as root, falls back to chapter, then to page number", () => {
  const base = {
    book: "Vol 1 - The Lands Between",
    page: 33,
    page_type: "other" as const,
    markdown: "Some text.",
    figures: [],
    entities: [],
    quality: {
      image_quality: "good" as const,
      quality_issues: [],
      affected_areas: null,
      retake_recommended: false,
      retake_reason: null,
      ocr_agreement: "high" as const,
      illegible_regions: 0,
      notes: null,
    },
  };
  assert.equal(chunkPage({ ...base, chapter: "CH 1", region: "Limgrave" })[0]!.headingPath, "Limgrave");
  assert.equal(chunkPage({ ...base, chapter: "CH 1", region: null })[0]!.headingPath, "CH 1");
  assert.equal(chunkPage({ ...base, chapter: null, region: null })[0]!.headingPath, "Page 33");
});
