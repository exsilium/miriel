import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDocuments, documentTitle } from "./documents.js";
import { INLINE_MARKER_RE, InlineCitationParser, labelResolver } from "./inline.js";
import type { RetrievalResult } from "../retrieval/types.js";
import type { AnswerEvent } from "./types.js";

const retrieval: RetrievalResult = {
  query: "q",
  routeQuestion: true,
  anchors: { entities: [], pages: [], ownPages: [] },
  chunks: [
    { book: "vol1", page: 73, chunk_idx: 1, text: "chunk on 73", heading_path: "Weeping Peninsula > Map labels", score: 1, why: ["vector"], ranks: {}, context_kind: "chunk" },
    { book: "vol1", page: 159, chunk_idx: 3, text: "chunk on 159", heading_path: "Altus Plateau > 27 Dominula, Windmill Village  ⚔ +13/+5", score: 0.5, why: ["vector"], ranks: {}, context_kind: "chunk" },
  ],
  pages: [{ context_kind: "page", book: "vol1", page: 73, chapter: null, region: "Weeping Peninsula", markdown: "full page 73", tokens: 3 }],
  stats: { embeddingTokens: 0, rerankTokens: 0, reranked: false, vectorHits: 0, lexicalHits: 0, timingsMs: {} },
};

test("buildDocuments puts full pages first and drops chunks of pages already included", () => {
  const docs = buildDocuments(retrieval, { vol1: "Vol 1" });
  assert.deepEqual(docs.map((d) => [d.kind, d.context.page, d.context.chunk_idx]), [["page", 73, null], ["chunk", 159, 3]]);
  assert.equal(docs[0]!.title, "Vol 1 — p. 73 — Weeping Peninsula");
  assert.equal(docs[1]!.title, "Vol 1 — p. 159 — Altus Plateau > 27 Dominula, Windmill Village  ⚔ +13/+5");
  assert.equal(docs[0]!.text, "full page 73");
});

test("documentTitle truncates long sections and falls back to the book id as label", () => {
  const long = "x".repeat(200);
  const t = documentTitle("vol1", 5, long);
  assert.ok(t.length <= 120);
  assert.ok(t.startsWith("vol1 — p. 5 — "));
  assert.ok(t.endsWith("…"));
});

test("inline marker regex accepts the documented forms", () => {
  const forms = ["[Vol 1, p. 214]", "[Vol 1, p.214]", "[Vol 1, p 214]", '[Vol 1, p. 214: "exact words"]', "[Vol 1, p. 214 | “curly quotes”]"];
  for (const f of forms) {
    INLINE_MARKER_RE.lastIndex = 0;
    assert.ok(INLINE_MARKER_RE.test(f), f);
  }
  INLINE_MARKER_RE.lastIndex = 0;
  assert.ok(!INLINE_MARKER_RE.test("[Golden Rune [3]]"));
});

function collect(parser: InlineCitationParser, deltas: string[]): AnswerEvent[] {
  const out: AnswerEvent[] = [];
  for (const d of deltas) out.push(...parser.push(d));
  out.push(...parser.flush());
  return out;
}

test("InlineCitationParser turns markers into citation events even when split across deltas", () => {
  const parser = new InlineCitationParser(labelResolver({ vol1: "Vol 1" }));
  const events = collect(parser, ["The Giant Rat Ashes are in the shack [Vol 1", ", p. 159: \"Inside the shack", " by the windmill\"]. Next sentence."]);
  const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
  assert.equal(text, "The Giant Rat Ashes are in the shack . Next sentence.");
  const cites = events.filter((e) => e.type === "citation");
  assert.equal(cites.length, 1);
  const c = (cites[0] as Extract<AnswerEvent, { type: "citation" }>).citation;
  assert.equal(c.book, "vol1");
  assert.equal(c.page, 159);
  assert.equal(c.quote, "Inside the shack by the windmill");
  // the citation event is emitted right after the text it supports
  assert.equal(events[0]!.type, "text");
  assert.equal(events[1]!.type, "citation");
});

test("InlineCitationParser leaves unknown book labels and ordinary brackets in the text", () => {
  const parser = new InlineCitationParser(labelResolver({ vol1: "Vol 1" }));
  const events = collect(parser, ["Drops Golden Rune [3] and more [Vol 9, p. 4]. done"]);
  const text = events.map((e) => (e.type === "text" ? e.text : "")).join("");
  assert.equal(text, "Drops Golden Rune [3] and more [Vol 9, p. 4]. done");
  assert.equal(events.filter((e) => e.type === "citation").length, 0);
});

test("InlineCitationParser does not hold text back forever after a stray bracket", () => {
  const parser = new InlineCitationParser(labelResolver({ vol1: "Vol 1" }));
  const long = "[" + "a".repeat(500);
  const events = parser.push(long);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { text: string }).text, long);
});

test("labelResolver ignores case and spacing", () => {
  const r = labelResolver({ vol1: "Vol 1" });
  assert.equal(r("Vol 1"), "vol1");
  assert.equal(r("vol1"), "vol1");
  assert.equal(r("VOL. 1"), "vol1");
  assert.equal(r("Vol 2"), undefined);
});
