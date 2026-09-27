# Miriel — Build Specification v2: full books, multiple volumes

Read `docs/build-spec.md` (v1) first; everything there still applies. v1 delivered the pipeline end to end but only six fixture pages of Vol 1 are extracted and indexed. v2 makes the system useful: extract and index all of Vol 1 and Vol 2, make the app multi-book, and make adding Vol 3 a configuration change plus two commands. Work through the phases in order and **stop at the end of each phase for review**.

## 1. Facts established so far (verify anything marked ⚠ before relying on it)

| | Vol 1 — The Lands Between | Vol 2 — Shards of the Shattering | Vol 3 |
|---|---|---|---|
| PDF | `Elden Ring Vol 1 - The Lands Between.pdf`, 513 pages, 254 MB | `Elden Ring Vol 2 - Shards of the Shattering.pdf`, 530 pages, 311 MB | not yet scanned |
| Page images | `Elden Ring Vol 1 - The Lands Between/`, 513 files `… - N.jpg` | `Elden Ring Vol 2 - Shards Of The Shattering/` (note capital **O**f), 532 files `… - N.jpg` (renamed to `Shards of the Shattering` on 2026-09-26 to match the PDF; `config/books.json` is current) | |
| OCR text layer | 491 of 513 pages have > 50 chars | 523 of 530 pages have > 50 chars | |
| Mapping | verified on all pages: printed p = PDF page p+1 = image p+1, offset **1** | ⚠ sampled at two points only (image 12 = printed 11, image 201 = printed 200): offset **1**. The two surplus images are back-matter; check the last 30 pages before extraction. | must be verified with the offset script (Phase A) |
| `{{BOOK}}` / `sourceBook` | `Vol 1 - The Lands Between` | `Vol 2 - Shards of the Shattering` (match the PDF's spelling, not the folder's) | |
| Extracted | 6 fixture pages (33, 73, 159, 289, 316, 501) | none | |

Fixture run numbers (6 pages, `claude-opus-5`, effort high): 8.5k input + 5.9k output tokens per page, 56 s per page, **4 of 6 pages flagged `retake_recommended`**, OCR agreement medium/low on every page.

Cost and time estimates for a full run (rounded):

| Model | Per page | Vol 1 (513) | Vol 2 (530) | Wall clock at `--workers 4` |
|---|---|---|---|---|
| `claude-opus-5` (used for the fixture) | $0.19 | ≈ $100 | ≈ $100 | ≈ 2 h per volume |
| `claude-sonnet-5` | $0.08 | ≈ $40 | ≈ $40 | ≈ 1.5 h per volume |

Embedding all chunks (≈ 6 chunks and 1.6k tokens per page) costs nothing: Voyage's free tier covers 200 M tokens.

## 2. Hard constraints (in addition to v1 §2)

- The extraction prompt `prompts/page-extraction-prompt.md` stays as is unless a Vol 2 fixture review shows a concrete failure; propose the change and wait for approval. The operator table above the `---` (source file paths) may be updated.
- One source of truth for book configuration: `config/books.json`. The Python runner must read it too; `scripts/pages.py` must stop carrying its own `Book` definitions.
- Nothing may assume a book id, a page count, an offset, or a file-name pattern. Adding a book = one JSON entry + files in place.
- Extraction is resumable and idempotent: re-running never redoes a page that has valid output unless `--force` or the page is listed for a retake.
- Every long run prints progress and a cost summary, and can be killed and restarted without loss.
- Keep dependencies small. One new runtime dependency is pre-approved: `sharp` in the api for thumbnails (Phase C). Anything else: ask.

## 3. Phase A — Multi-book foundation

Goal: the code paths that know about "vol1" become config-driven, and the source files move into a place Compose can mount generically.

1. **Data directory.** Move the PDFs and image directories into `./data/` (gitignored; `.dockerignore` already excludes them by pattern, extend it for `data/`). `config/books.json` paths are already relative to `DATA_DIR`. Compose mounts `./data:/data:ro` into `api` instead of the two hard-coded Vol 1 mounts. Local dev sets `DATA_DIR=./data` in `.env.example`. **Decision for the user:** moving the files vs. keeping them at the repo root and mounting the root read-only (rejected by default: the root contains `.env`).
2. **Config.** Add the Vol 2 entry:

   ```json
   "vol2": {
     "title": "Elden Ring Vol 2 - Shards of the Shattering",
     "label": "Vol 2",
     "sourceBook": "Vol 2 - Shards of the Shattering",
     "pdf": "Elden Ring Vol 2 - Shards of the Shattering.pdf",
     "imageDir": "Elden Ring Vol 2 - Shards Of The Shattering",
     "imagePattern": "Elden Ring Vol 2 - Shards Of The Shattering - {n}.jpg",
     "printedToPdfOffset": 1,
     "pageCount": 530
   }
   ```

   `pageCount` is the PDF page count (the viewer navigates the PDF); surplus images are ignored.
3. **Offset verification script** `scripts/check_offset.py --book vol2 [--pages 11,200,250,500,520]`: for each page, extract bare page numbers from the PDF text layer of PDF page `printed + offset` and print them next to the expected printed number; also print the image file it would use so the operator can open it. Exit non-zero when any sampled page disagrees. Run it for both volumes and record the result in the config as a comment field `"offsetVerified": "2026-09-23, pages 11,200,…"`.
4. **Python reads `config/books.json`.** `scripts/pages.py` loads the JSON (no new dependency; stdlib `json`) and exposes the same `Book` dataclass; `extract.py --book` choices come from the config. Fixture definitions (`FIXTURE_PAGES`) become per-book: `test-pages/<book>/manifest.json`, `build_fixture.py --book vol2 --pages …`.
5. **Indexer** `ingest --book <id>` already reads the config; add `ingest --all` to loop over every configured book. `books` rows are upserted per book.
6. **API**: `GET /api/books` already returns all books. `POST /api/chat` `bookIds` stays optional; when omitted, retrieval spans all books (already the case). Verify `retrieve` never mixes `page` numbers across books without the `book` key (it uses `book:page` keys; keep it that way).
7. **Web**: a book selector in the top bar (dropdown of `/api/books`), scope toggle in the composer "Search: this book | all books" (default: all). Citation pills already carry the book label; clicking a pill from another book must switch the viewer's book (the `goTo(book, page)` path exists; test it). Deep link `?book=vol2&page=200` must work.
8. Update `CLAUDE.md` (paths, `DATA_DIR`, `--all`), `README.md`, `.env.example`.

**Stop for review.** I will check the moved files, the Vol 2 offset output, and the book switcher.

## 4. Phase B — Extraction at scale (Vol 1)

Goal: `out/vol1/` holds 513 valid page files, with a QA report and a retake list.

1. **Runner hardening** in `scripts/extract.py` (keep the current CLI shape):
   - default behaviour skips pages whose output exists and validates (`--force` to redo); `--pages-from <file>` reads a page list (for retakes);
   - `--workers N` with a shared token bucket: on a 429 all workers back off, not just one;
   - progress line per page (`[123/513] p137 ok 48s 8.1k/5.7k tok retake=no`) and a final summary: pages ok / failed / skipped, tokens, estimated cost from a small model-price table, wall time;
   - a failed page after all retries writes `out/<book>/_failed/pNNN.txt` with the raw model text and error, and the run continues;
   - `_runlog.jsonl` gains `run_id`, `prompt_sha256`, `effort`, `cost_usd`.
2. **QA report** `scripts/qa_report.py --book vol1` writes `out/vol1/_qa.md`:
   - schema validity per file (reuse `schema.py`);
   - `page` field vs file name, `book` field vs `sourceBook`;
   - `[FIGURE n]` placeholder count vs `figures.length`; `illegible_regions` vs count of `[illegible]` markers;
   - entity names not found verbatim in `markdown` (per page count; the runner already warns);
   - distribution of `page_type`, `image_quality`, `ocr_agreement`; list of `retake_recommended` pages with `retake_reason` grouped by reason;
   - 20 randomly sampled pages (seeded) listed for human spot-check with their image paths.
3. **Model choice.** Run the six fixture pages once more with `claude-sonnet-5` and diff against the Opus output (names verbatim, table cell counts, entity counts). If Sonnet is within tolerance, use it for the full run and save ≈ $60 per volume; otherwise stay on Opus. **Decision for the user** after seeing the diff.
4. **Full run**: `uv run python scripts/extract.py --book vol1 --workers 4 1-513` (omit page 0 / cover if it has no printed number; check `check_offset.py` output for the first printed page). Expect ≈ 2 h. Run it in the background and check `_runlog.jsonl` for the tail.
5. **Review** using `_qa.md`: fix systematic problems (if a page type is consistently mis-transcribed, that is the moment to propose a prompt change), re-run affected pages with `--force`, and hand over the retake list.

**Stop for review.** I will look at the QA report, spot-check the sampled pages, and decide which pages get re-shot. Re-shot pages come back later through `--pages-from retakes.txt --force`.

## 5. Phase C — Ingest at scale and retrieval tuning

Goal: all of Vol 1 indexed, retrieval good on the ten v1 test queries, UI usable with 500+ pages.

1. **Incremental ingest.** Add `pages.source_hash text` (sha256 of the page file) via migration `0003`. `ingest` skips pages whose hash is unchanged unless `--force`; the summary reports `unchanged`. This makes post-retake re-indexing seconds, not minutes.
2. **Ingest run**: `indexer ingest --book vol1`. Expect ≈ 3,000 chunks, ≈ 25,000 entities, one embedding request per 128 chunks. Print the summary; compare with `SELECT count(*)` per table.
3. **Retrieval at scale** (re-check each against `npm run retrieve`):
   - **Region expansion cap.** A route question in Limgrave could add 60+ region pages to `anchors.pages`, diluting the anchor boost. Cap region pages to the 12 nearest (by page distance) to the resolved entities' own pages; keep own pages and one-hop pages uncapped.
   - **Entity resolution noise.** With 25k entities, trigram matching of the whole query will return junk. Require trigram similarity ≥ 0.6 as now, but also require the matched span to be ≥ 2 words or capitalised (already the case), and drop trigram matches whose entity appears on more than 40 pages (generic names like "Golden Rune").
   - **Anchor page count in the UI.** The "Understood as" strip shows entities; keep it. Do not show anchor pages, only "Pages consulted".
   - Re-run the ten review queries from Phase 2 plus the four from v1 §1 and paste results into `docs/retrieval.md` under "Full Vol 1 results".
4. **Thumbnails.** `GET /api/books/:id/pages/:n/thumb` returns a 240 px wide JPEG generated with `sharp` on first request and cached under `THUMB_CACHE_DIR` (default `/cache/thumbs`, a named Docker volume; `os.tmpdir()/miriel-thumbs` locally). Immutable cache headers. The web "Pages consulted" strip uses it.
5. **PDF viewer with 513 pages**: the slot list renders 513 placeholders; confirm scrolling and page tracking stay smooth, otherwise virtualise (render slots only within ±20 pages and keep a spacer). Confirm the first render fetches only ranges (Network tab: no full 254 MB download).
6. **Acceptance for this phase** (the v1 §12 checks 3 and 4 with real content): "Where is the Meteorite Staff?" answers with ≥ 1 citation to the page that actually holds it; "How do I get from Lenne's Rise to the Meteorite Staff?" shows both anchors and yields an ordered waypoint list with a citation per waypoint.

**Stop for review.** I will run my query set against the full book.

## 6. Phase D — Vol 2

Goal: Vol 2 extracted, indexed, and searchable alongside Vol 1.

1. **Fixture first** (the prompt's "Test run" procedure, for Vol 2): pick one page of each type from Vol 2 and record the printed numbers in the prompt's operator table. Vol 2 is a combat guide and bestiary; expect boss stat blocks (e.g. printed 200, Ancient Dragon Lansseax: resistances table, location/HP/runes, drops), attribute item tables (printed 11), weapon/armor tables, and the same map style as Vol 1. Build `test-pages/vol2/`, run, and review with the four checks from the prompt.
2. If boss stat blocks or the two-column resistance tables come out wrong, propose a prompt change (with before/after on the fixture) and wait.
3. Full run with the same model as Vol 1, `--workers 4`; QA report; retake list.
4. `indexer ingest --book vol2`; verify `/api/books` shows both and a cross-book question ("Which bosses drop Remembrances in Liurnia?") cites both volumes where appropriate.
5. Cross-book UI check: pill from Vol 2 switches the viewer to Vol 2 at the right page and highlights.

**Stop for review.**

## 7. Phase E — Vol 3 readiness

Goal: proving that a new book needs no code. There are no Vol 3 scans yet, so rehearse with a copy.

1. `docs/adding-a-book.md`: the runbook. Files into `data/`, JSON entry, `check_offset.py`, fixture pages, extraction run, QA, ingest, UI check. Every step is a command that exists.
2. **Rehearsal**: add a temporary `vol3` entry pointing at the Vol 2 files with `label: "Vol 3 (rehearsal)"`, run `check_offset.py --book vol3`, extract 3 pages, ingest, confirm the book appears in the UI and citations open it, then `indexer reset --book vol3` and remove the entry. Record in the runbook how long it took.
3. Make sure every place that lists books does so from the database or config, never from a literal: grep for `vol1` outside `config/`, tests and docs, and remove what you find.

**Stop for review.**

## 8. Acceptance checks for v2 (run before declaring done)

1. `docker compose down -v && docker compose up --build -d && docker compose --profile index run --rm indexer ingest --all` completes; counts match the summaries; `/api/books` lists Vol 1 and Vol 2 with correct page counts and offsets.
2. Spot-check 10 random citations per book: the pill opens the right printed page and the highlight lands on the cited sentence (or the border flashes on a page without text layer).
3. The four questions from v1 §1 answer with citations, and the route question yields an ordered list.
4. A Vol 2 boss question ("What are Lansseax's resistances?") answers from the stat block on printed page 200 with the values in a table.
5. Re-running extraction on a completed book does nothing; re-running ingest reports every page as unchanged; both finish in under a minute.
6. Adding the rehearsal `vol3` entry and removing it leaves no trace in the database or UI.
7. The retake list for each book is in `out/<book>/_qa.md`, grouped by reason, ready for a re-shoot session.

## 9. Open decisions (recommendation first)

- **Model for the full runs**: Sonnet 5 if the fixture diff is clean (saves ≈ $120 over both books), else Opus 5.
- **Source file location**: move into `data/` (clean Compose mount, no `.env` exposure) vs. keep at the root.
- **Retakes**: extract everything first and re-shoot afterwards (recommended: the flag is triage, and the prompt says to transcribe anyway) vs. re-shoot flagged pages before indexing.
- **Search scope default**: all books (recommended) vs. the book open in the viewer.
- **Thumbnail generation**: on demand with `sharp` in the api (recommended, one dependency) vs. precomputed by the Python pipeline into `out/<book>/thumbs/` (no Node dependency, but `out/` would then need mounting into `api`).

## 10. Non-goals for v2

- Re-OCR of the PDFs; the text layer is used only for the model's cross-check and for highlighting.
- Editing extraction output by hand; fixes go through the prompt or a re-run.
- Vol 3 extraction itself.
- Authentication, hosting beyond the LAN.
