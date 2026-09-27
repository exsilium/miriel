# Retakes

How to replace bad page photos: export the list, re-shoot in vFlat, upload, review, accept, check. The
system then replaces the photo, rebuilds that page of the PDF with its OCR layer, re-extracts and re-indexes
the page, and every browser sees the new page without a hard refresh. Every step can be undone.

Where things stand: the extraction flagged **145 pages of Vol 1**, **13 of Vol 2** and **24 of Vol 3** (`retake_recommended`). Many
map flags are spread artefacts: labels cut at the gutter continue on the facing page, and a new photo will not change them
(15 of the 24 in Vol 3; see `docs/adding-a-book.md` §6).
A retake costs about **$0.12–0.18 per page** (median $0.14, re-extraction with the same model as the full run);
checking a photo and rolling back cost nothing.

## 0. One-time setup

1. In `.env`: `RETAKE_ENABLED=true`. Optional: `RETAKE_DAILY_BUDGET_USD` (default 10; jobs beyond it wait until
   the next day) and `RETAKE_TOKEN=<something>` for scripts (`x-retake-token` header; admin rights).
   Uploading and everything else in the UI needs a login (README, "Create your admin account"). Anyone with an
   account can upload photos. A user's checked photo goes to **Submit for approval**, and an admin approves
   (**Approve and process**, the step that costs credit) or declines it with a note. Admins' own photos run
   straight away. Admins see the waiting photos at the top of `/retakes` and as a green ✓ N next to **Retakes**
   in the top bar (docs/build-spec-retakes.md §11).
2. `npm run up`. This applies the retake migrations and starts the `retake-worker` next to the api.
3. `npm run index` once, so every page has a photo version (needed for cache-safe URLs; nothing is
   re-embedded).
4. Open `http://<host>:3000/retakes` on the PC and on the phone (same LAN). The top bar shows **Retakes** with
   the number of pages that still need a photo.

## 1. Export the list

`/retakes` → pick the book → **Download list**: printed page numbers with their issues, one per line.
`out/<book>/_retakes.txt` has the same pages (it is refreshed after every retake).

What the extraction complained about (pages per issue; a page can have several):

| issue | Vol 1 | Vol 2 | Vol 3 |
| --- | ---: | ---: | ---: |
| low_resolution | 98 | 9 | 2 |
| blur | 97 | 9 | 1 |
| crop_cut_off | 69 | 3 | 18 |
| page_curl | 58 | 4 | 16 |
| color_cast | 35 | 1 | 2 |
| shadow | 26 | 4 | 6 |
| skew | 21 | 3 | 6 |
| two_pages_in_frame | 15 | – | 5 |
| glare | 14 | 1 | 4 |
| fingers_or_obstruction | – | 1 | – |

Group by issue in the queue (**Group by issue**) to shoot all pages with the same problem in one go.

## 2. Shoot in vFlat

The pipeline takes vFlat's output as it is: no deskew, contrast or sharpening on the server. Get it right on
the phone.

**Sharpness matters more than pixels.** The current photos are about 1.7k × 2.2k px (median 3.7 MP in
Vol 1, 4.2 MP in Vol 2), and the flagged pages are barely smaller than the good ones (3.6 vs 3.7 MP). The
"low_resolution" and "blur" pages are soft, not small: focus, motion and compression.

- **Blur / low resolution** (most pages): good even light, phone steady (elbows on the table, or vFlat's
  auto-shoot / timer rather than tapping the shutter), let it focus before the shot. Use the app's highest
  image-quality / resolution setting if it has one, and export JPEG, not a PDF. Zoom into the smallest table
  text on the phone before moving on: if you cannot read it, the model cannot either.
- **crop_cut_off**: the whole page with a small margin on every side; no part of the page outside the frame.
- **page_curl**: hold the page flat near the gutter (a weight or a hand at the edge, outside the text) and
  keep vFlat's curve flattening on.
- **two_pages_in_frame**: one page per photo; for these pages do not use a two-page / book mode.
- **shadow / glare / color_cast**: diffuse daylight or two lamps from the sides, flash off, tilt slightly if a
  glossy page reflects; keep the colour setting (no black-and-white filter: the page photos are shown in the app).
- **skew**: phone parallel to the page. vFlat straightens small angles; the check below tolerates them.
- **fingers_or_obstruction**: keep fingers off the text; vFlat's finger removal helps at the edges only.

**File names.** The fastest and safest: name each photo `page_NNN.jpg` where NNN is the *image number* =
printed page + 1 for all three books (so printed page 289 is `page_290.jpg`). The book's own image names
(`Elden Ring Vol 1 - The Lands Between - 290.jpg`) work too. Photos with other names are matched by their
printed folio confirmed by photo similarity, or by photo similarity alone (maps have no folio); anything
unclear is left for you to assign.

## 3. Transfer

Copy the photos to the PC into one folder per book (any folder for the web upload; `./retakes/` for the
command line).

## 4. Upload and check

**Web (usual).** `/retakes` → **Batch upload** → pick the book → **Choose photos**, **Choose a folder** or drop
the files. Each photo is checked in 1–5 seconds, before anything changes:

- *Matched by*: file name (certain), folio + photo, photo similarity, or set by hand.
- *Check*: the folio found (or why not), the aspect ratio, and whether the photo looks like the page it
  replaces. **A photo of another page is refused** ("this photo looks like printed page 290, not 289").
  Warnings (no folio on a map, a crop that changes the aspect) are for you to judge.
- A photo that could not be placed shows a page field: type the printed page and **Set**; it is checked again.
  Two photos for the same page block the confirm until you discard one.

**Accept and process N pages** starts one retake for the batch (one PDF write, one extraction run, one
re-index) and shows the total estimate first. Budget: jobs over `RETAKE_DAILY_BUDGET_USD` wait with a message.

For a single page: open it in the queue (or **Retake this page** in the viewer) → **Choose photo** (or **Use
camera** on the phone; vFlat's processing is better) → old and new side by side → **Accept and process**.

**Command line (same checks, same versions).** Put the photos in `./retakes/`, then:

```
npm run retake -- --book vol1 --dir .              # the whole folder, one PDF write
npm run retake -- --book vol1 --page 289 --image page_290.jpg
npm run retake -- --book vol1 --dir . --dry-run    # check and build only, write nothing
```

## 5. Review

Each finished page shows before/after: image quality, retake recommended, OCR agreement, entities, markdown
length, and the cost.

- **Still flagged**: the new photo was not good enough; the page stays in the queue for another try.
- **Worse than before**: **Roll back the latest retake** on the page (or `npm run retake -- --book vol1
  --rollback --page 289`). The previous photo, PDF page and extraction come back exactly; no model call.
  Rolling back again goes one retake further back; the rolled-back version is kept too.
- **Fine as it is** (the flag is overcautious): **Mark accepted** takes the page out of the queue without a
  retake; **Undo accept** puts it back. The extraction JSON is not edited.

## 6. Spot-check in the viewer

**Open the page in the viewer** jumps there with the new PDF loaded. Check the page render, **Page image**
(the new photo), and ask a question that cites the page: its highlight comes from the new text layer.

## After a session

- `out/<book>/_qa.md` and `_retakes.txt` are regenerated after every retake and rollback, so the report and
  the queue agree.
- When more than 20 % of a book's pages were replaced since the last full build, the queue suggests a **full
  rebuild**: the original pipeline over the whole image folder, for one consistent OCR text layer. It takes
  hours (OCR of every page); start it from a terminal:

  ```
  npm run rebuild-pdf -- --book vol1 --dry-run   # build and verify only
  npm run rebuild-pdf -- --book vol1 --yes       # build, verify, swap in (old PDF kept as a version)
  ```

  It holds the book's retake lock (retakes wait), keeps the outline (from `data/<pdf name>.toc.txt` if
  present, else from the current PDF) and the title/author, and verifies every photo against its image file
  before the swap. If it is interrupted after OCR, the next run reuses the OCR result. Extraction output is
  not touched.

## Where the versions are

| what | where |
| --- | --- |
| previous photos | `data/<imageDir>/_versions/<name>.v<k>.jpg`, log in `log.jsonl` next to them |
| previous PDFs (last 3) | `data/_versions/<pdf name>.v<k>.pdf`, log in `data/_versions/log.jsonl` |
| replaced PDF pages | `data/_versions/pages/<book>/pNNNN.v<k>.pdf` (what rollback splices back) |
| previous extractions | `out/<book>/_history/pNNNN.v<k>.json` |
| retake journals | `data/_versions/retakes/<book>/<id>.json` |

`npm run retake -- --book vol1 --history [--page 289]` lists a book's retakes and rollbacks.

## Troubleshooting

| symptom | what to do |
| --- | --- |
| a job waits with "daily budget" | raise `RETAKE_DAILY_BUDGET_USD` in `.env` and `npm run up`, or wait for the next day |
| a job waits with "locked by retake …" | a command-line retake or rebuild is running; if none is, finish it: `npm run retake -- --book vol1 --resume <id>` (or `--abandon <id>` if it never replaced the PDF) |
| a job failed | **Retry** resumes from the last completed stage. If the PDF was already replaced it can only be finished (Retry), then rolled back |
| the worker was restarted mid-job | nothing to do: the job resumes from its journal |
| no Retakes link in the app | the api runs without `RETAKE_ENABLED=true` |
| progress and errors | `docker compose logs -f retake-worker` |
