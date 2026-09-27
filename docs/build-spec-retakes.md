# Miriel — Build Specification: page retakes from the UI

Read `docs/build-spec.md` (v1) and `docs/build-spec-v2.md` first; everything there still applies. v2 leaves each book with a retake list (`out/<book>/_qa.md`, `_retakes.txt`; 145 pages in Vol 1, 13 in Vol 2). Today a retake means copying a new photo into `data/`, rebuilding the PDF by hand, re-running extraction with `--pages-from … --force`, and re-ingesting. This spec turns that into one flow: **pick a flagged page in the UI, upload the new photo, review, accept**, and the system replaces the image, rebuilds that page of the PDF with its OCR layer, re-extracts it, re-indexes it, and refreshes every cached view. Work through the phases in order and **stop at the end of each phase for review**.

## 1. Facts this spec builds on (verify anything marked ⚠)

| | |
|---|---|
| Digitisation pipeline | vFlat Scan on a phone (AI straighten/deblur on the phone) → rename to `page_NNN.jpg` → `img2pdf $(ls -v *.jpg) --pagesize 212mmx276mm --fit fill` → `ocrmypdf -l eng --jobs $(nproc) --optimize 1 --output-type pdfa` → `pdftocio book.pdf < toc.txt` → `exiftool -Author=… -Title=…` |
| PDF page size | 601 × 782 pt on both books (= 212 × 276 mm) |
| PDF structure to preserve | Outline: 92 entries (Vol 1), 82 (Vol 2). Metadata: Title, Author "Future Press". Producer is pikepdf (from ocrmypdf) |
| Image ↔ PDF invariant | Image file n is the photo embedded in PDF page n; `check_offset.py --images all` verifies it by dimensions + perceptual hash. A retake must keep it true |
| Mapping | printed page + `printedToPdfOffset` = PDF page = image number (`config/books.json`) |
| Current retake flags | `pages.quality->>'retake_recommended'` in Postgres; 145 (vol1), 13 (vol2) |
| Caching | page image `max-age=30d, immutable`; thumbnail `max-age=1y, immutable` + file cache under `THUMB_CACHE_DIR`; PDF `max-age=1d` with ETag. A replaced page is invisible behind these unless URLs are versioned |
| Mounts | `./data:/data:ro` (api), `./out:/app/out:ro` (indexer). Nothing in the runtime stack may write source files today |
| Costs | re-extraction ≈ $0.15–0.25 per page (Opus 5.5, effort high); embedding is free-tier |
| ⚠ Tools | `img2pdf`, `ocrmypdf` (tesseract, ghostscript), `qpdf` are not installed on the host or in the node image |

## 2. Hard constraints (in addition to v1 §2 and v2 §2)

- **Per-page, not per-book.** A retake touches one page's image, one PDF page, one `out/<book>/pNNNN.json`, one page's rows. Full-book OCR (hours) is never on the retake path.
- **Nothing is overwritten without a copy.** Every replaced image, PDF and page JSON is kept as a numbered version and a retake can be rolled back from the UI.
- **The PDF keeps its outline, metadata and page count** after every splice; a retake cannot insert or delete pages.
- **The api stays read-only on `data/` and `out/`.** Writes happen in a separate worker with a read-write mount; the api only records jobs and stores uploads in a staging volume.
- **CLI first.** Every step exists as a command (`scripts/retake.py …`) before the UI calls it; the UI is a front end to the same job, so a batch of retakes can be done without the browser.
- **Re-extraction spends money only after an explicit confirm** that shows the estimate, and a per-day budget cap (`RETAKE_DAILY_BUDGET_USD`, default 10) stops the queue.
- The extraction prompt stays unchanged; a retake runs the same prompt as the full run.
- New dependencies: `img2pdf`, `ocrmypdf`, `pikepdf` (Python, worker image only) and the `qpdf` binary. Anything else: ask.

## 3. Phase A — Single-page retake as a command

Goal: `uv run python scripts/retake.py --book vol1 --page 289 --image ~/retakes/page_290.jpg` replaces printed page 289 end to end, and `--rollback` undoes it.

1. **Validate the upload.**
   - JPEG or PNG; apply EXIF orientation; convert PNG to JPEG (quality 92) so the image folder stays uniform.
   - Page identity: OCR the new image (`tesseract` on the footer/header band, same bands as `check_offset.py`) and look for the expected folio. Found = ok; a different folio = hard stop ("this photo is printed page 290"); none found = warning, operator decides (map pages have no folio).
   - Aspect ratio within 15 % of the PDF page (0.769); outside = warning (usually a crop or two pages in frame).
2. **Version and replace the image.** Move the current file to `data/<imageDir>/_versions/<name>.v<k>.jpg` (k = next free), write the new file under the configured pattern name. Record `{book, page, version, sha256, source filename, at}` in `data/<imageDir>/_versions/log.jsonl`.
3. **Build the replacement PDF page**, reproducing the original pipeline for one page:

   ```
   img2pdf <new>.jpg --pagesize 212mmx276mm --fit fill -o page_raw.pdf
   ocrmypdf -l eng --optimize 1 --output-type pdfa page_raw.pdf page.pdf
   ```

   The page size comes from the existing PDF page (read it, do not hard-code 212 × 276), so a future book with another trim size works.
4. **Splice into the book PDF** with pikepdf (it keeps the document catalogue of the original, which is where the outline lives):
   - open the book PDF, replace page n with page 1 of `page.pdf`, keep the original page object's position so outline destinations still resolve; if the outline references the old page object, re-point those entries at the new one;
   - copy document info and XMP metadata unchanged;
   - write to a temp file, then verify before swapping in: page count unchanged, outline entry count unchanged and every entry resolving to the same page index as before, `check_offset.py --book <id> --pages <p> --images sample` passes for the page, and the new page's text layer is non-empty unless the photo has no text;
   - move the old PDF to `data/_versions/<pdf name>.v<k>.pdf` (keep the last 3 versions, older ones deleted with a log line), swap the new one in.
   - ⚠ PDF/A: a splice with pikepdf may drop PDF/A conformance. Check with `verapdf` or ocrmypdf's own validation once; if it breaks, document it and decide (see §8). The app does not need PDF/A; the Books app on a phone does not either.
5. **Re-extract** the page: `extract.py --book <id> <p> --force`, after copying the current `out/<book>/pNNNN.json` to `out/<book>/_history/pNNNN.v<k>.json`. The OCR text now comes from the new PDF page.
6. **Re-index** the page: `indexer ingest --book <id> --pages <p>` (hash-based; only this page changes).
7. **Invalidate caches**: delete the page's thumbnail from `THUMB_CACHE_DIR`; bump the page's image version and the book's PDF revision (Phase C serves them in URLs).
8. **Report**: before/after `image_quality`, `retake_recommended`, `ocr_agreement`, entity count and markdown length, cost. If the page is still flagged, it stays in the retake queue.
9. **Rollback**: `--rollback --page <p>` restores the previous image version, re-splices the PDF page from it (steps 3–4), restores the previous JSON from `_history/`, re-ingests. Rollback costs nothing (no model call).
10. **Batch**: `--dir ~/retakes --book vol1` takes a folder of vFlat output. The page for each file comes from the filename (`page_NNN.jpg` = image number, i.e. the numbering of step 2 of the digitisation pipeline) or, when the name carries no number, from the folio OCR. One PDF splice for the whole batch (open, replace all pages, verify, write once), then one extraction run with `--workers 4` and one ingest.

**Stop for review.** I will retake three real pages from `_retakes.txt` (one text page, one map, one table) with the command, check the PDF in a PDF reader and on the phone (outline and title intact), and roll one back.

## 4. Phase B — Job queue and worker

Goal: the api can request a retake without write access; a worker does the work and reports progress.

1. **Migration `0004`**: table `retake_jobs (id, book_id, page, status, stage, upload_path, image_sha256, folio_check, estimate_usd, cost_usd, before jsonb, after jsonb, error, created_at, updated_at, batch_id)`. Status: `uploaded → validated → confirmed → running → done | failed | rolled_back`. Stage names match Phase A's steps.
2. **Worker service** `retake-worker` in Compose: Python image with uv, `ocrmypdf` (+ tesseract-ocr-eng, ghostscript), `img2pdf`, `pikepdf`, `qpdf`, and the Node indexer (it calls `node packages/indexer/dist/cli.js ingest`). Mounts: `./data:/data` and `./out:/app/out` **read-write**, `uploads:/uploads`, `thumbs:/cache/thumbs`. Polls `retake_jobs` with `SELECT … FOR UPDATE SKIP LOCKED`, one job at a time per book (PDF splices of one book must serialise).
3. **Stages are idempotent.** A worker killed mid-job (the host reboots, as happened during the Vol 2 run) resumes the job from its last completed stage; the PDF swap is the only step that must be atomic, and it is (write temp, verify, rename).
4. **Progress**: the worker writes `stage` and a one-line message per step; the api exposes `GET /api/retakes/:id` and `GET /api/retakes/:id/events` (SSE, same helper as chat).
5. **Budget**: before `running`, the worker sums `cost_usd` for the day; over `RETAKE_DAILY_BUDGET_USD` the job waits in `confirmed` with a message.

**Stop for review.**

## 5. Phase C — Cache-safe serving

Goal: after a retake every client sees the new page without a hard refresh, while unchanged pages keep their immutable caching.

1. **Versioned URLs.** `GET /api/books` returns `pdfRevision` (sha256 prefix of the current PDF, computed at startup and after each job). Page responses and citations carry `imageVersion` per page: a sha256 prefix of the page photo, stored in a new `pages.image_sha256` column (filled by `ingest` for every page, updated by the worker on each retake). It is separate from `pages.source_hash`, which hashes the extraction JSON. The web client appends `?v=` to PDF, image and thumbnail URLs; the api ignores the parameter for lookup but it makes each version a new cache entry, so `immutable` stays correct.
2. **Thumbnail cache key** includes the image version (`p289.<v>.jpg`), so a stale file can never be served; the worker also deletes the old one.
3. **pdf.js**: when `pdfRevision` changes (on the next `/api/books` poll, or on a retake-done SSE event), the viewer reloads the document at the same page. Range requests against a changed PDF with the old ETag must not mix bytes from two versions: the versioned URL guarantees it.
4. **Highlights and citations** keep working after a retake: stored citations point at book + page, and quotes are re-found in the new text layer by the existing fuzzy matcher; a quote that no longer matches flashes the border (current behaviour).

**Stop for review.**

## 6. Phase D — Retake UI

Goal: the whole flow in the browser, on desktop and on the phone the photos are taken with.

1. **Retake queue** (new route `/retakes`, link in the top bar with a count badge): pages with `retake_recommended = true`, per book, sortable by page and grouped by `quality_issues`, each row showing the current thumbnail, `image_quality`, `retake_reason`, `affected_areas`. Filters: book, issue, status (flagged / in progress / done / still flagged). A "mark as accepted" action clears a flag without a retake (for pages the operator judges fine), stored as an override in `retake_jobs`, not by editing the JSON.
2. **Page detail**: current photo large, with `affected_areas` as text; upload control (file picker; on a phone, `accept="image/*" capture="environment"` opens the camera, but vFlat's processing is better, so the picker is the default); after upload, side-by-side old / new with the folio check result, aspect warning and the cost estimate; buttons **Accept and process** and **Discard**.
3. **Batch upload**: drop a folder or many files; each is matched to a page (filename, then folio OCR), shown in a table with its match confidence; unmatched or conflicting files need a manual page number; one confirm for the batch with the total estimate.
4. **Progress**: stage list per job via SSE; on done, the before/after quality summary and a link that opens the page in the viewer; on failure, the error and a retry button.
5. **History and rollback** per page: versions with date, source filename and quality verdict; **Roll back** re-queues a rollback job.
6. From the viewer, a page's toolbar gets **Retake this page**, which opens the page detail (useful when the operator notices a bad page while reading).
7. Access: LAN-only as before; the retake routes are off unless `RETAKE_ENABLED=true`, and when `RETAKE_TOKEN` is set the upload and confirm calls require it (a single shared token, not accounts; authentication stays a non-goal).

**Stop for review.**

## 7. Phase E — Session workflow and docs

1. `docs/retakes.md`: the operator runbook. Export the retake list (`/retakes` → "Download list" or `_retakes.txt`) → shoot in vFlat using the list → transfer → batch upload → review → accept → spot-check in the viewer. Include the vFlat settings that fix the common issues from the QA report (low resolution and blur dominate Vol 1).
2. Re-generate `out/<book>/_qa.md` after each batch (the worker runs `qa_report.py` at the end of a batch) so the report and the queue agree.
3. A **full rebuild** command for when a large share of a book was re-shot: `scripts/rebuild_pdf.py --book <id>` runs the original five-step pipeline over the current image folder (img2pdf → ocrmypdf → restore the outline from the current PDF, or from `data/<book>.toc.txt` if present → copy metadata), verifies with `check_offset.py --images all`, and swaps it in as a new version. It is never triggered from the UI automatically; the UI suggests it when more than 20 % of a book's pages were replaced since the last full build.

**Stop for review.**

## 8. Open decisions (recommendation first)

- **PDF update strategy**: splice single pages with pikepdf (recommended; seconds per page, outline and metadata preserved) vs. always re-run the full pipeline (identical to the original process, but hours of OCR per retake).
- **PDF/A**: accept losing PDF/A conformance on spliced files if pikepdf breaks it (recommended; nothing in the app or the phone reader needs it) vs. re-run `ocrmypdf --output-type pdfa --skip-text` over the spliced PDF to restore it (minutes per book, re-validates everything).
- **Where uploads land before acceptance**: a named `uploads` volume the api writes and the worker reads (recommended; `data/` stays read-only for the api) vs. a staging folder inside `data/` (simpler, but gives the api write access to source files).
- **Page identification in batches**: filename number first, folio OCR as check (recommended; vFlat numbering is reliable after the rename step) vs. folio OCR only (works for arbitrary filenames, fails on map pages without a folio).
- **Image preprocessing on the server**: none beyond orientation and format (recommended; vFlat already straightens and deblurs, and a second pass can hurt text) vs. an optional deskew/contrast step.
- **Re-extraction model**: the same model and effort as the full run (recommended; one book should not mix extraction styles) vs. a cheaper model for retakes.
- **Old versions**: keep every image version and the last 3 PDF versions (recommended; images are small, PDFs are 250–310 MB) vs. keep everything.

## 9. Acceptance checks (run before declaring done)

1. Retake one flagged page of each book from the UI: the new photo appears in the viewer, the thumbnail strip and the page image mode without a hard refresh, on desktop and on the phone.
2. The spliced PDF opens in a desktop reader and the phone's Books app with the same title, author, page count and outline as before; outline entries still jump to the right pages.
3. `check_offset.py --book <id> --images all` passes after the retake.
4. The page's `out/<book>/pNNNN.json` is new, the old one is in `_history/`, `indexer ingest --all` reports every other page unchanged, and a question citing the page highlights text from the new text layer.
5. A batch of 10 pages completes with one PDF write and one extraction run; the reported cost matches `_runlog.jsonl`.
6. Kill the worker mid-batch; restart it; the batch finishes without redoing completed pages and without a corrupt PDF.
7. Roll back one retake: image, PDF page, JSON and index return to the previous version; no model call is made.
8. A photo of the wrong page is rejected by the folio check before anything is written.
9. With `RETAKE_ENABLED` unset, the retake routes return 404 and the UI hides the queue.

## 10. Non-goals

- Taking or processing photos in the app (vFlat stays the capture tool).
- Inserting, deleting or reordering pages; a missing page is a new-book-version problem, not a retake.
- Editing extraction output by hand (v2 §10 still applies).
- Re-OCR of pages that were not re-shot (v2 §10); the "re-OCR candidates" in the QA report stay informational.
- User accounts. (Since superseded: accounts came with docs/build-spec-checklist.md, see §11.)

## 11. Addendum (2026-09-27): retakes by users, approved by an admin

Source: docs/build-spec-checklist.md §3 decision 13 (Phase C there). With user accounts (that spec's Phase B), a
user who is not an admin can upload retake photos. An admin approves the re-extraction, because that is the
step that costs model credit and replaces the book PDF.

- **States** (migration 0009): `validated -> submitted -> confirmed` for a user's photo, and
  `submitted -> declined` when an admin says no (with an optional note shown to the uploader). An admin's own
  photos, and anything done with RETAKE_TOKEN, go `validated -> confirmed` as before. The worker is unchanged:
  it validates `uploaded` and runs `confirmed` jobs. Its "same page pending" checks count `submitted` too. A
  declined job does not count for the page's queue status (the page stays where it was).
- **Columns:** `uploaded_by`, `submitted_at`, `decided_by`, `decided_at`, `decision_note` (users FK, `ON DELETE
  SET NULL`). Jobs in the api carry `uploadedBy` / `decidedBy` as `{id, username}`.
- **Rights:**

  | Action | user | admin or token |
  |---|---|---|
  | View queue, history, photos | yes | yes |
  | Upload (single, batch), set a page by hand | yes (own jobs) | yes |
  | Submit a validated job or batch (`/submit`) | own jobs | not needed |
  | Withdraw / discard | own jobs, until confirmed | any job (as before) |
  | Confirm = approve, decline (`/decline {note}`) | no | yes |
  | Retry, roll back, mark accepted | no | yes |

- **Guard:** with accounts every retake POST needs a logged-in user (with a real password) or the RETAKE_TOKEN,
  which has admin rights and is meant for scripts. Without accounts (tests), only the token guards, as before.
  Before this addendum, a stack without RETAKE_TOKEN let anyone who could reach it upload and confirm.
- **Limits:** a user has at most 50 open photos (uploaded, validated or submitted); admins have no limit. The
  daily budget (RETAKE_DAILY_BUDGET_USD) still applies after approval.
- **UI:**
  - A user sees "Submit for approval" where an admin sees "Accept and process", then "Waiting for an admin's
    approval" with Withdraw, and after a decline the reason with Discard / another photo.
  - Admins get "Waiting for approval (N)" at the top of the queue, one row per batch or single photo linking to
    the batch or page view; a green ✓ N next to Retakes in the top bar; and Approve / Decline in the page and
    batch views.
  - Visitors who are not logged in see a "Log in" prompt instead of the upload controls. The token field only
    shows on a stack without accounts.

