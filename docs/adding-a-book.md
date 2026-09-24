# Adding a book

How to bring a new volume (Vol 3, or any other scanned guide) into Miriel. No code changes: one JSON
entry, the files in place, and the commands below. Run everything from the repo root.

Rehearsed on 2026-09-24 with a temporary `vol3` entry pointing at the Vol 2 files: offset check, 3 pages
extracted, ingest, API and citation check, reset. **About 2 minutes wall time, $0.55.** A full book is
dominated by extraction: about 1 h 45 min and $80–105 for 500+ pages at `--workers 4`.

## 1. Put the files in `data/`

```
data/<Book Title>.pdf          # the OCR'd PDF (text layer from ocrmypdf)
data/<Image Folder>/           # one photo per PDF page, numbered 1..N in PDF order
```

The image folder must hold exactly one photo per PDF page, in the same order. Stray shots (duplicates,
page-turn blur) shift every later file; step 3 detects them.

## 2. Add the config entry

`config/books.json`:

```json
"vol3": {
  "title": "Elden Ring Vol 3 - …",
  "label": "Vol 3",
  "sourceBook": "Vol 3 - …",
  "pdf": "<Book Title>.pdf",
  "imageDir": "<Image Folder>",
  "imagePattern": "<Image Folder> - {n}.jpg",
  "printedToPdfOffset": 1,
  "pageCount": <PDF page count>
}
```

- The id (`vol3`) is lowercase letters, digits, `-` or `_`. It names `out/<id>/` and appears in URLs.
- `label` is what citation pills show ("Vol 3 · p. 214").
- `sourceBook` is the `{{BOOK}}` value in the extraction prompt and the `book` field of every page file;
  match the PDF's spelling.
- `imagePattern` must contain `{n}` = printed page + offset.
- `pageCount` is the PDF's page count, not the number of image files.
- Add a row to the operator table in `prompts/page-extraction-prompt.md` (above the `---`; the model
  never sees it).

## 3. Verify the page mapping

```
uv run python scripts/check_offset.py --book vol3 --images all
```

It reads the printed page numbers from the footer of the PDF's text layer and checks them against
`printedToPdfOffset`, then matches every image file against the photo embedded in its PDF page. It exits
non-zero and names the fix when:

- a folio shows up on a neighbouring PDF page ("offset should be 2"): change `printedToPdfOffset`;
- an image does not match its PDF page ("pdf page 209 matches image file 211 (shift +2)"): find the stray
  files where the shift starts, move them to `<Image Folder>/_extra/`, renumber the rest, and re-run.

When it passes, record it: add `--record` (writes `offsetVerified` into the config).

## 4. Fixture: test the prompt on a few pages

Pick one page of each type the book has (dense text, map, item table, boss stat block, lore, one weak
scan). Record them in the prompt's "Test run" table, then:

```
uv run python scripts/build_fixture.py --book vol3 --pages 200,11,60,280,343,507
uv run python scripts/extract.py --book vol3 --fixture --dry-run      # sizes, OCR length, no API call
uv run python scripts/extract.py --book vol3 --fixture --workers 3
```

Review the outputs in `out/vol3/` against the photos with the prompt's four checks (names as printed,
map labels vs legend, entity names verbatim in markdown, retake flag vs your eye). If a page type comes
out wrong, propose a prompt change and re-run the fixture; do not edit the JSON by hand.

## 5. Full extraction

Long runs must survive the session: start them as a detached process and watch the log.

```
uv run python scripts/extract.py --book vol3 --workers 4 1-<last printed page> > out/vol3/_run.log 2> out/vol3/_run.err
```

- Pages with valid output are skipped, so the same command resumes after a crash or reboot.
- A page that fails every retry leaves `out/vol3/_failed/pNNNN.txt`. If the API's output content filter
  blocked it, transcribe it in parts:
  `uv run python scripts/extract_split.py --book vol3 --page <n> [--parts "top=0,0,1,0.56;…"]`.
- The final summary prints tokens, cost and wall time; `out/vol3/_runlog.jsonl` has every attempt.

## 6. QA report and retake list

```
uv run python scripts/qa_report.py --book vol3
```

Writes `out/vol3/_qa.md` (coverage, consistency problems, distributions, retakes grouped by reason,
20-page spot-check sample with image paths) and `out/vol3/_retakes.txt`. After a re-shoot:

```
uv run python scripts/extract.py --book vol3 --pages-from out/vol3/_retakes.txt --force
```

## 7. Ingest

```
docker compose up -d db
node packages/indexer/dist/cli.js migrate
node packages/indexer/dist/cli.js ingest --book vol3        # or: ingest --all
```

Compose alternative: `npm run index` (runs `ingest --all` in a container). Ingest is incremental: pages
whose file hash is unchanged are skipped, so re-running after a retake touches only the changed pages.
A book without `out/<id>/` yet is still registered, so it can be browsed in the viewer before extraction.

## 8. Check it in the app

```
curl -s http://localhost:3000/api/books                      # the new book, with pageCount and offset
npm run answer -- --book vol3 "<a question the book answers>"  # citations read "Vol 3 · p. N"
```

In the browser (http://localhost:3000): pick the book in the top-bar selector, open
`?book=vol3&page=<n>`, ask a question with the search scope on "all books", and click a Vol 3 citation
pill: the viewer switches to Vol 3 at that page and highlights the quote.

## Removing a book

```
node packages/indexer/dist/cli.js reset --book vol3          # deletes the books row; pages, chunks, entities cascade
```

Then remove the entry from `config/books.json`, delete `out/vol3/`, and clear its thumbnails
(`docker compose exec api rm -rf /cache/thumbs/vol3`; locally `<tmpdir>/miriel-thumbs/vol3`). The API
stops listing the book immediately; its PDF and image routes return 404.
