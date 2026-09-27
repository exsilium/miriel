# Miriel — Build Specification: art books

Read `docs/build-spec.md` (v1), `docs/build-spec-v2.md` and `docs/build-spec-retakes.md` first; everything there still applies. The three strategy guides answer questions in text with page citations. This spec adds the **ELDEN RING OFFICIAL ART BOOK** volumes as a picture source: every artwork is cut out, named in English, linked to the guides' entities, and shown next to answers ("Art" strip under a message, click opens the full spread). Work through the phases in order and **stop at the end of each phase for review**.

## 1. Facts this spec builds on (verify anything marked ⚠)

Probe of 2026-09-26 (PyMuPDF, 9 spreads rendered and read):

| | Art Book Vol 1 | Art Book Vol 2 | Vol 3 |
|---|---|---|---|
| PDF | `Elden Ring Art Book Volume 1 Wide.pdf`, 114 MB | `Elden Ring Art Book Volume 2 Wide.pdf`, 81 MB | not yet added |
| PDF pages | 220: page 1 cover (1379 × 1920), 219 spreads (2714 × 1920) | 195: cover + 194 spreads | |
| Content | one DCT (JPEG) image per page, same pixel size as the page; **no text layer, no outline** | same | |
| Folios | PDF page *n* ≥ 2 shows printed pp. 2n−2 (left) and 2n−1 (right); checked at n = 60, 120, 180. ⚠ check the whole book (Phase A) | same; checked at n = 50, 150 | |
| Chapters (contents page, pp. 2–3) | 1 Gallery: Illustrations · 2 Concept Art: The Lands Between (per region and legacy dungeon, pp. 50–361) · 3 Character: Tarnished and Others | ⚠ 4 Adversary: Bosses and Enemies, then weapons, items … (read in Phase A) | |
| Captions | **Japanese**, one `◆` label under or beside an artwork (◆魔術学院レアルカリア = Raya Lucaria Academy, ◆接ぎ木の貴公子 = Grafted Scion); many artworks, whole object sheets and most location paintings have none | same (◆輝石の杖 = Glintstone Staff) | |
| Layouts | full-spread painting across the gutter; one or two large figures; grids up to ~14 pieces, sometimes on a darker panel; chapter openers | same | |
| Background | flat light grey (≈ #d8d8d8) or black around the art | same | |

Consequences:

- No OCR, no photos, no retakes: the embedded JPEG *is* the page image. It can be written out byte for byte, so the existing image, thumbnail and viewer code can serve it.
- Naming always needs a translation step (Japanese caption → official English name), and uncaptioned art needs visual identification. Both come from the model's game knowledge, so every name carries its source and is checked against the guides' entity names.
- The contents page ties every page range to a chapter and region; that is the context for uncaptioned art.

## 2. Hard constraints (in addition to the earlier specs)

- **Config-driven as before.** Art books live in `config/books.json` with `"kind": "artbook"`; nothing in code may assume an art book id, count, file name or folio rule. The third art book goes in with a runbook, no code change.
- **Guide tooling is unaffected.** `extract.py`, `qa_report.py`, `check_offset.py`, `retake.py`, `rebuild_pdf.py` and the retake queue see guides only (the Python loader returns guides unless asked for art books; the retake routes and UI skip art books). The guide extraction prompt and chunk index are unchanged: artworks never enter text retrieval or the answer model's documents.
- **Names are labelled by source.** `caption` (translated from a printed ◆ caption, Japanese kept verbatim), `visual` (identified from the picture), `none`. A name is `verified` only when it matches a guide entity name after `normalizeName`; unverified names are kept, shown lower, and listed in QA.
- **Everything derived is rebuildable.** Spread JPEGs under `data/`, crops only in the thumbnail cache, labels in `out/<art id>/`. Book-derived text (contents file, labels) is never committed.
- **No new dependencies.** Segmentation uses Pillow (already a dependency); crops use sharp (already in the api).
- The labelling model call spends money only in Phase A (fixture) and Phase B (full run, estimate shown first).

## 3. Configuration

```json
"art1": {
  "kind": "artbook",
  "title": "Elden Ring Official Art Book Vol 1",
  "label": "Art 1",
  "pdf": "Elden Ring Art Book Volume 1 Wide.pdf",
  "imageDir": "Elden Ring Art Book Volume 1 Wide",
  "imagePattern": "Elden Ring Art Book Volume 1 Wide - {n}.jpg",
  "pageCount": 220,
  "spread": { "pdfPage": 2, "leftFolio": 2 },
  "contents": "Elden Ring Art Book Volume 1 Wide.contents.json",
  "folioVerified": "…"
}
```

- `{n}` is the **PDF page number** (a spread). `spread` anchors the folio rule: PDF page p ≥ `spread.pdfPage` shows folios `leftFolio + 2·(p − pdfPage)` and the next one; pages before the anchor (the cover) have no folio.
- `sourceBook` and `printedToPdfOffset` are guide-only fields; the zod schema becomes a union on `kind` (`guide` is the default so existing entries do not change).
- `contents` (under DATA_DIR, next to the PDF, like the guides' `<pdf stem>.toc.txt`) lists `{from, to, chapter, section, region}` by printed folio, typed in once from the contents page with the English chapter titles and the English names of the Japanese section headings.
- In the database an art book is a `books` row with `kind = 'artbook'`; its "page" number everywhere in the API (image, thumbnail, artworks) is the PDF page number, and `printed_to_pdf_offset` is 0. The web client maps folios to spreads with the `spread` rule from `GET /api/books`.

## 4. Phase A — Foundation and fixture

Goal: both art books configured and verified, spreads exported, artworks cut out and labelled on an 8-spread fixture, with measured cost.

1. **Config and loaders**: the `kind` union in `packages/shared/src/config.ts` and `scripts/pages.py` (`BOOKS` stays guides only; `ARTBOOKS` holds the art books with `spread`, folio helpers and contents). `ingest --all` skips art books until Phase C.
2. **Export spreads**: `scripts/art_export.py --book art1` writes each page's embedded JPEG to `data/<imageDir>/` byte for byte (no re-encoding), skips files that already match, and fails loudly if a page has more or less than one image or the image does not cover the page.
3. **Verify folios**: `scripts/art_check.py --book art1 [--record]` checks page sizes and one image per page, and writes a contact sheet of the footer strips of every 10th spread plus the last 5 (folio text next to the expected numbers) to the scratch folder; the operator confirms, `--record` writes `folioVerified`.
4. **Contents files** for both books (Vol 2 read from its contents page).
5. **Segment** (`scripts/art_segment.py`, also a library): estimate the background from the spread border; mask pixels that differ from it on a ~⅛ scale copy; close small gaps; connected components; drop components below ~0.5 % of the spread (captions, folios, specks stay out of the boxes); one level of re-segmentation inside a component that is itself a flat panel (object sheets); a spread whose border is not uniform (full-bleed painting) is one box. Boxes are stored as fractions of the spread. `--sheet` draws numbered boxes for review.
6. **Label prompt** `prompts/art-label-prompt.md` (operator notes above `---`, model prompt below, like the guide prompt). Input: the spread image, the same spread with numbered boxes drawn on it, the book title, folios and contents entry. Output per spread (`out/<art id>/s{PDFPAGE:04d}.json`):

   ```json
   {
     "book": "art1", "pdf_page": 60, "folios": [118, 119],
     "artworks": [{
       "boxes": [1],                      // one artwork may span several boxes (merged)
       "kind": "location | character | npc | boss | enemy | creature | weapon | armor | item | spell | architecture | object | scene | other",
       "caption_ja": "魔術学院レアルカリア", // verbatim, null when none is printed
       "names": [{ "name": "Academy of Raya Lucaria", "source": "caption | visual" }],
       "description": "1–2 sentences on what is shown",
       "confidence": "high | medium | low"
     }],
     "not_art": [2],                      // boxes that are text, logos or page furniture
     "section_heading": "杖", "notes": null
   }
   ```

   Rules: every box is either in an artwork or in `not_art`; official English in-game names only (the names printed in the guides where the guides have them); no name rather than a guess; `visual` only when the subject is recognisable, with `confidence`.
7. **Runner** `scripts/art_label.py --book art1 <pdf pages> | --fixture` built on `extract.py`'s machinery (shared rate-limit pause, retries, atomic writes, `_runlog.jsonl`, cost summary; skip valid output unless `--force`).
8. **Name check** (part of the runner and re-runnable offline): each name is matched against every guide entity name in `out/vol*/` (normalised as in `normalizeName`, Python mirror with the same test cases): exact → `verified: true, entity: "<guide spelling>"`; one close match (≥ 0.92 similarity) → `verified: true` with the correction noted; else `verified: false`.
9. **Fixture** (`test-pages/art/`, 8 spreads): Vol 1 118–119 (full-spread location, caption), 238–239 (uncaptioned location), 358–359 (object grid on a panel), a character page, the contents spread; Vol 2 98–99 (boss, caption), 298–299 (four weapons with captions), the chapter 4 opener. Run with `claude-opus-5-5` and `claude-sonnet-5`, compare box handling, names and cost.

**Stop for review**: box sheets for the 8 spreads, the label JSON, the name check, cost per spread for both models and the projected full cost. You pick the model.

## 5. Phase B — Label both books

1. Estimate from the fixture numbers, then run both books (`--workers 4`).
2. `scripts/art_qa.py --book art1` writes `out/<id>/_qa.md`: spreads with boxes neither labelled nor dropped, artworks without a name, unverified names (grouped, with counts), low-confidence visual names, spreads where one box covers most of a multi-art layout (segmentation miss).
3. Fixes: per-spread manual overrides in `out/<id>/_overrides.json` (replace names, kind, caption, description or confidence of an artwork, or drop it; format in `scripts/art_overrides.py`), applied by readers (`art_qa.py`, ingest) and never by the runner, so a re-run never loses them. Box splits and merges stay with the segmenter; a box holding several pieces keeps all their names.

**Stop for review**: `_qa.md` for both books, total cost.

## 6. Phase C — Index, API, browsing

1. **Migration `0007`**: `books.kind` (default `'guide'`), `books.spread jsonb`; table `artworks (id, book_id, pdf_page, art_idx, folios int[], bbox real[4], kind, caption_ja, names jsonb, name_norms text[], entity_norms text[], description, confidence, section, region, embedding vector, tsv, source_hash)`; GIN on `name_norms` and `entity_norms`, HNSW on `embedding`.
2. **Ingest**: `indexer ingest --book art1` (and `--all`) reads the spread files, embeds `names + kind + section + description` (voyage, document input type), hash-based incremental like pages.
3. **API**: `GET /api/books` adds `kind` and `spread`; `GET /api/books/:id/spreads/:n/artworks`; `GET /api/artworks/:id/crop?w=` (sharp extract from the spread JPEG, cached in `THUMB_CACHE_DIR` keyed by artwork id + PDF revision, immutable with `?v=`); `GET /api/artworks?entity=<name>` and `?q=<text>` (hybrid, like chunks). Spread image and thumbnail use the existing page routes with `imageVersion` = PDF revision.
4. **Viewer**: art books in the book selector; one spread per slot at fit-width; toolbar shows "pp. 118–119", the page input takes a printed folio and opens its spread; deep link `?book=art1&page=119` opens that spread; the "Page image" and "Retake" buttons are hidden for art books; the search scope toggle is disabled on an art book (scope stays "all books").

**Stop for review.**

## 7. Phase D — Art next to answers

1. After retrieval, the chat route collects the anchor entities and the entities of the consulted pages (name_norm), finds artworks whose `entity_norms` match, and adds a vector search on the question for questions about appearance ("what does … look like", "show me …"). Ranking: caption-verified > visual-verified high > visual-verified medium; one artwork per subject per spread; at most 6. Unverified names never match by entity, only by the vector search.
2. New SSE event `art` (after `anchors`, before the answer text) with `{id, book, pdfPage, folios, kind, name, source, caption_ja, cropVersion}`; the answer model never sees it.
3. **UI**: an "Art" strip under the message (crops, name, "Art 1 · pp. 118–119"); click opens the art book in the viewer at that spread with the artwork's box outlined briefly (same flash as the quote highlight fallback); a visual name shows a small "identified from the picture" marker.

**Stop for review.**

## 8. Phase E — Runbook and acceptance

1. `docs/adding-an-art-book.md` (config, export, folio check, contents file, fixture, run, QA, ingest), rehearsed with a copy of Vol 2 under another id and reset without a trace.
2. CLAUDE.md, README (moving the stack: spread folders are rebuildable with `art_export.py`), docs/retrieval.md (art matching).
3. Acceptance: questions about ten named bosses, NPCs, locations and weapons each show matching art; a question with no depicted subject shows no strip; deep links to art spreads work on a phone; `ingest --all` twice is a no-op the second time; the guides' retrieval results are unchanged (same top pages on the docs/retrieval.md query set).

## 9. Decisions taken (2026-09-26)

- Names: caption translation and visual identification allowed, labelled by source, verified against guide entities; unverified shown lower.
- Strip shows the cut-out artwork; click opens the full spread.
- Art books are browsable in the viewer; deep links take a printed folio.
- Build with the two art books present; the third follows the runbook.
- Phase D: subjects are the question's anchor entities only (consulted-page entities buried the subject); titled-name, plural and text-search rules and their measured thresholds are in docs/retrieval.md ("Art next to answers").
- Phase A fixture (9 spreads): `claude-opus-5-5`, effort high, chosen for the full run ($0.059/spread; `claude-sonnet-5` thought longer, was not cheaper and hit the output cap on a 42-icon spread). Name check extended with a `prefix` match ("Queen Marika the Eternal" → "Queen Marika").

## 10. Non-goals

- Text retrieval over art books (captions are names, not prose) and citing art books in answers.
- Translating non-caption Japanese text (the contents page and chapter openers are covered by the contents file).
- Retakes, OCR or PDF rebuilds for art books.
