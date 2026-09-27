import { test } from "node:test";
import assert from "node:assert/strict";
import type { Artwork } from "./art.js";
import { APPEARANCE_RE, ART_LIMIT, matchTier, rankArt, singular, titledForm } from "./art-match.js";

let nextId = 1;
function art(names: [string, "caption" | "visual", string | null][], confidence: Artwork["confidence"] = "high", page = 10, book = "art2"): Artwork {
  return {
    id: nextId++, book, pdfPage: page, artIdx: 1, folios: [page * 2 - 2, page * 2 - 1], bbox: [0, 0, 1, 1], kind: "boss",
    captionJa: null, confidence, description: "d", section: null, imageVersion: null,
    names: names.map(([name, source, entity]) => ({ name, source, verified: entity !== null, entity, match: entity ? "exact" : "none" })),
  };
}

test("matchTier: captions first, visual names by confidence, low-confidence guesses never", () => {
  assert.equal(matchTier(art([["Godrick the Grafted", "caption", "Godrick the Grafted"]]), "godrick the grafted")?.tier, 0);
  assert.equal(matchTier(art([["Godrick the Grafted", "visual", "Godrick the Grafted"]], "high"), "godrick the grafted")?.tier, 1);
  assert.equal(matchTier(art([["Godrick the Grafted", "visual", "Godrick the Grafted"]], "medium"), "godrick the grafted")?.tier, 2);
  assert.equal(matchTier(art([["Godrick the Grafted", "visual", "Godrick the Grafted"]], "low"), "godrick the grafted"), null);
  // matched through the guide spelling the name was verified to
  assert.equal(matchTier(art([["Queen Marika the Eternal", "caption", "Queen Marika"]]), "queen marika")?.exact, true);
  // plural of the last word
  assert.equal(matchTier(art([["Crucible Knight", "caption", "Crucible Knight"]]), "crucible knights")?.exact, true);
});

test("titled forms count for persons only", () => {
  const blade = art([["Malenia, Blade of Miquella", "caption", "Malenia, Blade of Miquella"]]);
  assert.equal(matchTier(blade, "malenia", true)?.exact, false);
  assert.equal(matchTier(blade, "malenia", false), null);
  assert.equal(titledForm("Starscourge Radahn", "radahn"), true);
  assert.equal(titledForm("Radahn Soldier", "radahn"), false);
  assert.equal(titledForm("Radagon of the Golden Order", "radagon"), true);
  assert.equal(titledForm("Godrick the Grafted", "godrick"), true);
  assert.equal(singular("crucible knights"), "crucible knight");
  assert.equal(singular("glass"), "glass");
});

test("rankArt orders by tier, caps per subject and in total, and adds text hits only above the threshold", () => {
  const a = art([["Malenia, Blade of Miquella", "caption", "Malenia, Blade of Miquella"]], "high", 13);
  const b = art([["Malenia, Blade of Miquella", "visual", "Malenia, Blade of Miquella"]], "medium", 14);
  const c = art([["Malenia, Blade of Miquella", "caption", "Malenia, Blade of Miquella"]], "high", 186);
  const d = art([["Malenia, Blade of Miquella", "caption", "Malenia, Blade of Miquella"]], "high", 13); // same spread as a
  const out = rankArt([{ nameNorm: "malenia blade of miquella" }], [b, a, c, d]);
  assert.deepEqual(out.map((x) => x.id), [a.id, c.id], "tier 0 before tier 2, two per subject, one per spread");

  const weak = { ...art([["Melina", "caption", "Melina"]], "high", 187, "art1"), similarity: 0.515 };
  const strong = { ...art([["Malenia, Goddess of Rot", "caption", null]], "high", 15), similarity: 0.62 };
  const withHits = rankArt([{ nameNorm: "malenia blade of miquella" }], [a], [weak, strong]);
  assert.deepEqual(withHits.map((x) => [x.id, x.source]), [[a.id, "caption"], [strong.id, "search"]]);

  const many = Array.from({ length: 10 }, (_, i) => art([["Radahn", "caption", "Radahn"]], "high", 30 + i));
  const subjects = Array.from({ length: 5 }, (_, i) => ({ nameNorm: i === 0 ? "radahn" : "x" + i }));
  assert.ok(rankArt(subjects, many).length <= ART_LIMIT);
});

test("appearance questions switch the text search on", () => {
  assert.ok(APPEARANCE_RE.test("What does Malenia look like?"));
  assert.ok(APPEARANCE_RE.test("Show me the Academy of Raya Lucaria"));
  assert.ok(!APPEARANCE_RE.test("Where is the Meteorite Staff and how do I get it?"));
});
