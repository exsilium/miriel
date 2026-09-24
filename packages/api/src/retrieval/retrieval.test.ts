import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLexicalQuery, extractCandidates, isRouteQuestion } from "./candidates.js";
import { anchorBoost, rrfFuse, selectWithinBudget } from "./fuse.js";
import { dropWidespreadTrigram, nearestPages, routeSpan, selectSpans } from "./resolve.js";

test("extractCandidates yields n-grams without leading/trailing stopwords plus the whole query", () => {
  const c = extractCandidates("How do I get from Lenne's Rise to the Meteorite Staff?");
  const norms = c.map((x) => x.norm);
  assert.ok(norms.includes("lennes rise"));
  assert.ok(norms.includes("meteorite staff"));
  assert.ok(norms.includes("lennes"));
  assert.ok(!norms.includes("the meteorite staff"));
  assert.ok(!norms.includes("rise to"));
  assert.ok(!norms.includes("how"));
  const whole = c.find((x) => x.whole);
  assert.ok(whole && whole.fuzzy);
});

test("capitalised n-grams allow connectives and are fuzzy; lowercase single words are exact-only", () => {
  const c = extractCandidates("where is the Academy of Raya Lucaria and moonveil");
  const academy = c.find((x) => x.norm === "academy of raya lucaria");
  assert.ok(academy && academy.capitalised && academy.fuzzy);
  const moonveil = c.find((x) => x.norm === "moonveil");
  assert.ok(moonveil && !moonveil.capitalised && !moonveil.fuzzy);
  const two = c.find((x) => x.norm === "raya lucaria");
  assert.ok(two && two.fuzzy, "multi-word lowercase-or-capitalised n-grams are fuzzy");
});

test("a name may start with a capitalised stopword", () => {
  const c = extractCandidates("the way to The Four Belfries");
  assert.ok(c.some((x) => x.norm === "the four belfries"));
});

test("selectSpans keeps the longest span among equals", () => {
  const kinds = new Map<string, "exact" | "trigram" | "prior">([["rise", "exact"], ["lennes rise", "exact"], ["staff", "exact"]]);
  const kept = selectSpans(
    [
      { norm: "rise", start: 10, end: 14 },
      { norm: "lennes rise", start: 3, end: 14 },
      { norm: "staff", start: 30, end: 35 },
    ],
    kinds,
  );
  assert.deepEqual(kept.map((k) => k.norm).sort(), ["lennes rise", "staff"]);
});

test("selectSpans prefers an exact span over a trigram span that contains it", () => {
  const kinds = new Map<string, "exact" | "trigram" | "prior">([["godskin apostle", "exact"], ["godskin apostle drop", "trigram"]]);
  const kept = selectSpans(
    [
      { norm: "godskin apostle", start: 15, end: 30 },
      { norm: "godskin apostle drop", start: 15, end: 35 },
    ],
    kinds,
  );
  assert.deepEqual(kept.map((k) => k.norm), ["godskin apostle"]);
});

test("route detection", () => {
  assert.ok(isRouteQuestion("How do I get from Lenne's Rise to the Meteorite Staff?"));
  assert.ok(isRouteQuestion("what is the path to Castle Morne"));
  assert.ok(isRouteQuestion("how do I get to Oridys's Rise"));
  assert.ok(!isRouteQuestion("What are the requirements to use Moonveil?"));
  assert.ok(!isRouteQuestion("Where is the Meteorite Staff?"));
  assert.ok(!isRouteQuestion("Where is the Giant Rat Ashes and how do I get it?"));
});

test("buildLexicalQuery ORs the content words and drops possessive s", () => {
  assert.equal(buildLexicalQuery("Where is the Giant Rat Ashes and how do I get it?"), "Giant or Rat or Ashes");
  assert.equal(buildLexicalQuery("bosses in Miquella's Haligtree"), "bosses or Miquella or Haligtree");
  assert.equal(buildLexicalQuery("the of"), "the of", "falls back to the raw text when nothing is left");
});

test("rrfFuse sums 1/(k+rank) and records why and ranks", () => {
  const fused = rrfFuse(
    [
      { why: "vector", items: [{ key: "a", item: "a" }, { key: "b", item: "b" }] },
      { why: "lexical", items: [{ key: "b", item: "b" }, { key: "c", item: "c" }] },
    ],
    60,
  );
  assert.equal(fused[0]!.key, "b");
  assert.ok(Math.abs(fused[0]!.score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(fused[0]!.why, ["vector", "lexical"]);
  assert.deepEqual(fused[0]!.ranks, { vector: 2, lexical: 1 });
  assert.equal(fused.length, 3);
});

test("anchorBoost multiplies by 2 on own pages, 1.5 on other anchor pages, and re-sorts", () => {
  const fused = rrfFuse([{ why: "vector", items: [
    { key: "x", item: { book: "vol1", page: 1 } },
    { key: "y", item: { book: "vol1", page: 2 } },
    { key: "z", item: { book: "vol1", page: 3 } },
  ] }], 60);
  const boosted = anchorBoost(fused, [{ book: "vol1", page: 2 }, { book: "vol1", page: 3 }], [{ book: "vol1", page: 3 }], { anchor: 1.5, own: 2 });
  assert.equal(boosted[0]!.key, "z");
  assert.ok(Math.abs(boosted[0]!.score - 2 / 63) < 1e-12);
  assert.equal(boosted[1]!.key, "y");
  assert.ok(Math.abs(boosted[1]!.score - 1.5 / 62) < 1e-12);
  assert.deepEqual(boosted[1]!.why, ["vector", "anchor"]);
  assert.deepEqual(boosted[2]!.why, ["vector"]);
});

test("selectWithinBudget keeps priority order and skips what does not fit", () => {
  const picked = selectWithinBudget([{ id: 1, tokens: 500 }, { id: 2, tokens: 700 }, { id: 3, tokens: 400 }], 1000);
  assert.deepEqual(picked.map((p) => p.id), [1, 3]);
});

test("nearestPages keeps the cap closest to each book's reference pages, per book", () => {
  const cands = [10, 11, 50, 90, 91, 200].map((page) => ({ book: "vol1", page }));
  cands.push(...[300, 12, 40, 5].map((page) => ({ book: "vol2", page })));
  const near = nearestPages(cands, [{ book: "vol1", page: 12 }], 3);
  assert.deepEqual(near, [
    { book: "vol1", page: 11 },
    { book: "vol1", page: 10 },
    { book: "vol1", page: 50 },
    // vol2 has no reference page: its own cap, in page order
    { book: "vol2", page: 5 },
    { book: "vol2", page: 12 },
    { book: "vol2", page: 40 },
  ]);
  assert.deepEqual(nearestPages(cands, [], 0), []);
});

test("dropWidespreadTrigram removes fuzzy matches on names spread over many pages but keeps exact ones", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ match: "trigram" as const, name_norm: "golden rune", book_id: "vol1", page: i })),
    { match: "trigram" as const, name_norm: "golden order seal", book_id: "vol1", page: 7 },
    { match: "exact" as const, name_norm: "golden rune", book_id: "vol1", page: 9 },
  ];
  const kept = dropWidespreadTrigram(rows, 3);
  assert.deepEqual(kept.map((r) => r.name_norm + ":" + r.match), ["golden order seal:trigram", "golden rune:exact"]);
  assert.equal(dropWidespreadTrigram(rows, 5).length, rows.length);
});

test("routeSpan fills the pages between the closest endpoint pages in one book, within the max span", () => {
  const a = [{ book: "vol1", page: 48 }, { book: "vol1", page: 123 }, { book: "vol1", page: 328 }];
  const b = [{ book: "vol1", page: 129 }, { book: "vol2", page: 130 }];
  assert.deepEqual(routeSpan([a, b], 24).map((p) => p.page), [124, 125, 126, 127, 128]);
  assert.deepEqual(routeSpan([a, b], 3), []);
  assert.deepEqual(routeSpan([a], 24), []);
});
