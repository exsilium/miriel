import { test } from "node:test";
import assert from "node:assert/strict";
import { artBooks, BooksConfigSchema, guideBooks, spreadFolios, spreadForFolio, type ArtBookConfig } from "./config.js";

const art: ArtBookConfig = {
  kind: "artbook",
  title: "Art",
  label: "Art 1",
  pdf: "a.pdf",
  imageDir: "a",
  imagePattern: "a - {n}.jpg",
  pageCount: 220,
  spread: { pdfPage: 2, leftFolio: 2 },
  contents: "a.contents.json",
};

test("spreadFolios maps PDF pages to the printed folios of a spread", () => {
  assert.deepEqual(spreadFolios(art, 1), []); // cover
  assert.deepEqual(spreadFolios(art, 2), [2, 3]);
  assert.deepEqual(spreadFolios(art, 60), [118, 119]);
  assert.deepEqual(spreadFolios(art, 220), [438, 439]);
  assert.deepEqual(spreadFolios(art, 221), []);
});

test("spreadForFolio finds the spread of either folio", () => {
  assert.equal(spreadForFolio(art, 118), 60);
  assert.equal(spreadForFolio(art, 119), 60);
  assert.equal(spreadForFolio(art, 1), null);
  assert.equal(spreadForFolio(art, 440), null);
});

test("books config accepts guides without kind and art books with kind", () => {
  const cfg = BooksConfigSchema.parse({
    vol1: {
      title: "Vol 1",
      label: "Vol 1",
      sourceBook: "Vol 1",
      pdf: "v.pdf",
      imageDir: "v",
      imagePattern: "v - {n}.jpg",
      printedToPdfOffset: 1,
      pageCount: 513,
    },
    art1: art,
  });
  assert.deepEqual(Object.keys(guideBooks(cfg)), ["vol1"]);
  assert.deepEqual(Object.keys(artBooks(cfg)), ["art1"]);
  assert.throws(() => BooksConfigSchema.parse({ art1: { ...art, spread: undefined } }));
});
