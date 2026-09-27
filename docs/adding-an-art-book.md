# Adding an art book

How to bring another ELDEN RING OFFICIAL ART BOOK volume into Miriel (docs/build-spec-artbooks.md). No code
changes: one JSON entry, a contents file, and the commands below. Run everything from the repo root; the Python
scripts also run in Docker with `npm run py -- scripts/…`.

**Art Book Vol 3 went in this way on 2026-09-27** (`art3`, 163 PDF pages = cover + 162 spreads, pp. 2–325):
export 20 s, folio check clean, fixture of 8 spreads $0.48, full run 155 spreads in 10 min 43 s at
`--workers 4`, 0 failed, **$10.08 in all ($0.062/spread)**; 696 artworks, 98 % of names verified, 3 spreads of
overrides; ingest 163 spreads (art1/art2 and the guides unchanged), then `npm run up` so the api image sees the
new config entry.

## 1. Put the PDF in `data/`

`data/<Book Title>.pdf`. Art book PDFs have no text layer: the page images *are* the book. There is no photo
folder to supply, since step 3 writes it.

## 2. Config entry

`config/books.json`:

```json
"art3": {
  "kind": "artbook",
  "title": "Elden Ring Official Art Book Vol 3",
  "label": "Art 3",
  "pdf": "<Book Title>.pdf",
  "imageDir": "<Book Title>",
  "imagePattern": "<Book Title> - {n}.jpg",
  "pageCount": <PDF page count>,
  "spread": { "pdfPage": 2, "leftFolio": 2 },
  "contents": "<Book Title>.contents.json"
}
```

`{n}` is the PDF page. `spread` anchors the folio rule: PDF page p ≥ `pdfPage` shows folios
`leftFolio + 2·(p − pdfPage)` and the next one. All three volumes so far use `{pdfPage: 2, leftFolio: 2}`
(PDF page 60 = pp. 118–119); check this in step 4 before relying on it.

## 3. Export the spreads

```
uv run python scripts/art_export.py --book art3          # writes data/<imageDir>/
uv run python scripts/art_export.py --book art3 --check  # compares only
```

A PDF page with a single full-page JPEG is copied out byte for byte (Vol 1, Vol 2). A page tiled from
several JPEGs side by side (Vol 3: one quality-100 JPEG per printed page) is stitched and saved once with the
first tile's quantization tables and subsampling (mean error < 0.25/255). The output is deterministic, so
`--check` still compares by hash (the host and the Docker retake image produced identical files for Vol 3). Anything else (overlapping images, a non-JPEG
stream) stops the export: ask before adding another route.

## 4. Check structure and folios

```
uv run python scripts/art_check.py --book art3 --out <scratch dir>
```

This checks the page count, sizes and exported files, then writes footer contact sheets for every 10th spread
plus the last 5, with the expected folios in red. Compare them by eye; back matter and full-bleed art carry no
folio. Then record the check:

```
uv run python scripts/art_check.py --book art3 --record "footer folios checked on pdf 12-160 every 10th (22-319); pdf 161-163 back matter without folios"
```

## 5. Contents file

Write `data/<Book Title>.contents.json` from the contents spread (PDF page 2) by hand, once. It is a list of
`{from, to, chapter, section, section_ja, region}` by printed folio: one entry per chapter (`section: null`),
per section and per sub-section; readers take the narrowest entry covering a folio. Use English chapter titles
as printed and the **guides' spelling** for section names: grep `out/vol*/p*.json` for each candidate. Where a
Japanese heading is ambiguous, look at the spread itself (Vol 3: 病捨て村 = Bonny Village, from the painting).
Set `region` only when you are sure of it; it only feeds the search text. The file is book-derived: it stays
out of git with the rest of `data/`.

## 6. Fixture, then the full run

Pick about 8 varied spreads: contents, a chapter opener, a captioned location, a boss, a character sheet, a
weapon grid, an icon page. First a dry run (boxes only, no API call; box images in out/<id>/_boxes/, delete
them afterwards), then the paid labels:

```
uv run python scripts/art_label.py --book art3 2 3 19 60 87 121 142 156 --dry-run
uv run python scripts/art_label.py --book art3 --workers 4 2 3 19 60 87 121 142 156
```

The fixture labels land in out/<id>/ and count towards the full run, which skips them. The cost line projects
the whole book. Start the full run as a detached process (a shell background job dies after 10 minutes):

```powershell
Start-Process uv -ArgumentList "run","python","scripts/art_label.py","--book","art3","--workers","4","1-163" `
  -RedirectStandardOutput out/art3/_run.log -RedirectStandardError out/art3/_run.err -WindowStyle Hidden
```

Python buffers the redirected stdout until it exits, so watch the count of `out/<id>/s*.json` for progress.

## 7. QA and overrides

```
uv run python scripts/art_qa.py --book art3      # out/<id>/_qa.md
```

Go through "Unverified names": grep the guides for each. A different spelling or word order ("Blood Fiend"
→ Bloodfiend, "Ymir, High Priest" → Count Ymir) becomes an override in `out/<id>/_overrides.json` (format in
`scripts/art_overrides.py`); a name the guides never print (DLC pots, cookbooks) can stay as it is. Re-run the QA
after editing.

Known limit: on icon pages with a black background, the segmenter misses dim icons (Vol 3: about 40 items on
pp. 302–315; the model lists them in its notes, which the QA section "Possible segmentation misses" shows).
Box splits and merges stay with the segmenter, since overrides cannot add boxes.

## 8. Index and serve

```
npm run index        # ingest --all: the new book's spreads and artworks, everything else unchanged
npm run up           # rebuild: the api image carries config/books.json
```

Checks: `GET /api/books` lists the book with `kind: "artbook"` and its `spread`;
`GET /api/artworks?entity=<a boss of the book>` finds it; `npm run art -- "What does <boss> look like?"` shows
the new book in the strip; a question with no depicted subject shows none; the viewer opens
`?book=art3&page=<folio>` at its spread.
