import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName } from "./normalize.js";

test("normalizeName deletes apostrophes and spaces other punctuation", () => {
  assert.equal(normalizeName("Oridys's Rise"), "oridyss rise");
  assert.equal(normalizeName("Lenne’s Rise"), "lennes rise");
  assert.equal(normalizeName("Roots of the Haligtree–Floor 3"), "roots of the haligtree floor 3");
  assert.equal(normalizeName("Demi-Human Forest Ruins"), "demi human forest ruins");
  assert.equal(normalizeName("Dominula, Windmill Village"), "dominula windmill village");
  assert.equal(normalizeName("  Golden Rune [3] "), "golden rune 3");
  assert.equal(normalizeName("Highway Lookout Tower (Altus Plateau)"), "highway lookout tower altus plateau");
});

test("normalizeName is idempotent", () => {
  for (const s of ["Meteorite Staff", "Night's Cavalry (Flail)", "Castle Morne Rampart"]) {
    assert.equal(normalizeName(normalizeName(s)), normalizeName(s));
  }
});
