import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, markItem, normaliseQuote, quoteCandidates } from "./highlight.js";

const items = [
  "The West Windmill Pasture is located by the northern",
  "cliffs of Altus Plateau. When approaching from the east",
  "you can find a Battlemage standing on a rock, facing west",
  "towards this location. Inside the shack by the windmill are",
  "group of rats, and the Giant Rat Ashes.",
];

test("normaliseQuote lowercases and strips punctuation", () => {
  assert.equal(normaliseQuote("  Lenne's Rise — “quoted”, p. 214! "), "lenne s rise quoted p 214");
});

test("findQuote locates an exact sentence across item boundaries", () => {
  const ranges = findQuote(items, "Inside the shack by the windmill are group of rats, and the Giant Rat Ashes.");
  assert.ok(ranges);
  assert.deepEqual(ranges.map((r) => r.item), [3, 4]);
  assert.equal(items[3]!.slice(ranges[0]!.start, ranges[0]!.end), "Inside the shack by the windmill are");
  assert.equal(items[4]!.slice(ranges[1]!.start, ranges[1]!.end), "group of rats, and the Giant Rat Ashes");
});

test("findQuote tolerates case, whitespace and punctuation differences", () => {
  const ranges = findQuote(items, "battlemage   standing on a ROCK—facing west");
  assert.ok(ranges);
  assert.equal(ranges.length, 1);
  assert.equal(items[2]!.slice(ranges[0]!.start, ranges[0]!.end), "Battlemage standing on a rock, facing west");
});

test("findQuote falls back to a leading fragment when the tail differs (OCR error)", () => {
  const ranges = findQuote(items, "The West Windmill Pasture is located by the northern cliffs of Altvs Plateav and beyond");
  assert.ok(ranges, "head fragment should match");
  assert.equal(ranges[0]!.item, 0);
  assert.equal(ranges[0]!.start, 0);
});

test("findQuote returns null when nothing matches", () => {
  assert.equal(findQuote(items, "Meteorite Staff at Street of Sages Ruins"), null);
  assert.equal(findQuote([], "anything"), null);
});

test("quoteCandidates orders longest first and skips tiny fragments", () => {
  const c = quoteCandidates("one two three four five six seven eight nine ten eleven twelve");
  assert.equal(c[0], "one two three four five six seven eight nine ten eleven twelve");
  assert.ok(c.length >= 3);
  for (const s of c) assert.ok(s.length >= 12);
});

test("markItem escapes HTML and wraps the range", () => {
  assert.equal(markItem("a <b> c", { item: 0, start: 2, end: 5 }), "a &lt;b&gt; c".replace("&lt;b&gt;", "<mark>&lt;b&gt;</mark>"));
  assert.equal(markItem("plain", undefined), "plain");
});
