import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverrides, artworkSearchText, LabelFileSchema, type LabelFile } from "./art-ingest.js";

const label: LabelFile = LabelFileSchema.parse({
  book: "art2",
  pdf_page: 166,
  folios: [330, 331],
  contents: [{ chapter: "Inventory", section: "Tools", section_ja: "道具", region: null }],
  artworks: [
    { boxes: [1], bbox: [0, 0, 0.1, 0.1], kind: "item", caption_ja: "血の指", names: [{ name: "Bloody Finger", source: "caption", verified: true, entity: "Bloody Finger", match: "exact" }], description: "A finger.", confidence: "high" },
    { boxes: [2], bbox: [0.1, 0, 0.2, 0.1], kind: "item", caption_ja: "血指の幻影", names: [{ name: "Phantom Bloody Finger", source: "caption", verified: false, entity: null, match: "none" }], description: "A phantom finger.", confidence: "high" },
    { boxes: [3], bbox: [0.2, 0, 0.3, 0.1], kind: "item", caption_ja: null, names: [], description: "Noise.", confidence: "low" },
  ],
  not_art: [],
  section_heading_ja: null,
  notes: null,
  segmentation: { mode: "segmented", background: "#000000", boxes: [] }, // extra fields are ignored
});

test("applyOverrides replaces fields, drops artworks and leaves overridden names unverified for the guide check", () => {
  const out = applyOverrides(label, {
    artworks: { "2": { names: [{ name: "Bloody Finger", source: "caption" }] }, "3": { drop: true } },
  });
  assert.equal(out.artworks.length, 2);
  assert.deepEqual(out.artworks[1]!.names, [{ name: "Bloody Finger", source: "caption" }]);
  assert.equal(out.artworks[1]!.names[0]!.verified, undefined);
  assert.equal(label.artworks.length, 3, "the input label is not modified");
  assert.throws(() => applyOverrides(label, { artworks: { "9": { kind: "item" } } }), /does not exist/);
});

test("artworkSearchText joins names, kind, place and description", () => {
  assert.equal(artworkSearchText(label.artworks[0]!, "Tools", null), "Bloody Finger. item. Tools. A finger.");
  assert.equal(artworkSearchText(label.artworks[2]!, "Stormveil Castle", "Limgrave"), "item. Stormveil Castle, Limgrave. Noise.");
});
