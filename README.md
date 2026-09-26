# Miriel

Chat with digitized Elden Ring strategy guides. Every claim in an answer carries a page citation; clicking it opens that page of the original PDF next to the chat, with the cited text highlighted.

## What you need

- **Docker** with Compose v2 (Docker Desktop on Windows/macOS, Docker Engine + the compose plugin on Linux). Everything runs in containers: the app, the database, OCR/PDF tools, the extraction scripts.
- **git** to get the code.
- Optional: **Node 22** for the `npm run …` shortcuts below. Each shortcut is one `docker compose` command, shown next to it, so you can run those directly instead.
- API keys in `.env`: `ANTHROPIC_API_KEY` (answers, and page extraction when adding a book) and `VOYAGE_API_KEY` (embeddings; a separate account: https://dashboard.voyageai.com).

## What lives where

| path | what | in git? | cost to recreate |
| --- | --- | --- | --- |
| `config/books.json` | the book list: file names, page offset, page count | yes | – |
| `data/` | per book: the OCR'd PDF and a folder with one photo per PDF page; `data/_versions/` and `<imageDir>/_versions/` hold retake history | no | the digitisation itself (photos, OCR); keep a backup |
| `out/<book>/` | extraction output, one `pNNNN.json` per page, plus QA report and run log | no | **expensive**: about $60–105 and 1¼–2 h per book (model calls; Vol 1 $78, Vol 2 $104, Vol 3 $61) |
| database (volume `dbdata`) | chunks, embeddings, entities: built from `out/` | no | minutes: `npm run index`, or restore a dump (below) |
| `.env` | API keys and settings | no | copy it, or fill in from `.env.example` |
| volumes `thumbs`, `uploads` | thumbnail cache; retake photos waiting to be processed | no | regenerated on demand / empty when no retake is pending |

`data/` for the three configured books:

```
data/
  Elden Ring Vol 1 - The Lands Between.pdf
  Elden Ring Vol 1 - The Lands Between/          Elden Ring Vol 1 - The Lands Between - 1.jpg … - 513.jpg
  Elden Ring Vol 2 - Shards of the Shattering.pdf
  Elden Ring Vol 2 - Shards of the Shattering/   Elden Ring Vol 2 - Shards of the Shattering - 1.jpg … - 530.jpg
  Elden Ring Vol 3 - Shadow of the Erdtree.pdf
  Elden Ring Vol 3 - Shadow of the Erdtree/      Elden Ring Vol 3 - Shadow of the Erdtree - 1.jpg … - 418.jpg
```

The names come from `pdf`, `imageDir` and `imagePattern` in `config/books.json`; the image folder and files use the PDF's spelling and case (Vol 2 and Vol 3 were exported as "… Of The …" and renamed, see `_rename-log.json` in the folder) (`{n}` = PDF page number = printed page + `printedToPdfOffset`). Photo n must be the photo embedded in PDF page n. How the PDFs were made (vFlat → img2pdf → ocrmypdf → outline → metadata) is described in `docs/build-spec-retakes.md` §1.

## Fresh install (a new machine, starting from the source files)

1. `git clone <repo> miriel && cd miriel`
2. `cp .env.example .env` and fill in the two API keys.
3. Put the PDFs and photo folders into `data/` as above. A book that is not in `config/books.json` yet: add it first, see `docs/adding-a-book.md`.
4. Check each book's page mapping (folio in the text layer, and every photo against the PDF):
   `npm run py -- scripts/check_offset.py --book vol1 --images all`
5. **If you have `out/` from somewhere, copy it in and skip this step.** Otherwise extract every page (the expensive step; a fixture run first is described in `docs/adding-a-book.md`):
   ```
   docker compose --profile retake run -d --name extract-vol1 --entrypoint python retake scripts/extract.py --book vol1 --workers 4 1-512
   docker logs -f extract-vol1        # follow; the run survives closing the terminal; docker rm extract-vol1 afterwards
   npm run py -- scripts/qa_report.py --book vol1
   ```
   The run is resumable: start the same command again and it skips pages that already have valid output.
6. `npm run up` (`docker compose up --build -d`): builds the images, creates the database, applies migrations, starts the app at http://localhost:3000 (on the LAN: `http://<this machine>:3000`).
7. `npm run index` (`docker compose --profile index run --rm indexer`): chunks and embeds every book from `out/` into the database. A few minutes for the three books.

## Moving an existing stack to another machine (no re-extraction, no re-embedding)

Everything expensive is in files: `data/`, `out/` and a database dump. Copy those; nothing has to be computed again.

**On the old machine** (from the repo root, stack running):

```
docker compose exec db pg_dump -U miriel -Fc -f /tmp/miriel.dump miriel
docker compose cp db:/tmp/miriel.dump ./miriel.dump
```

Then copy to the new machine: `data/` (≈ 2.4 GB for the three books, plus up to 3 old PDF versions per book once retakes were done), `out/` (≈ 25 MB), `.env` (holds your keys: copy it securely) and `miriel.dump` (≈ 50 MB; it contains book text, keep it out of git: `*.dump` is ignored). The dump is written inside the container and copied out with `docker compose cp` on purpose: redirecting `pg_dump` output with `>` in Windows PowerShell corrupts the binary file.

**On the new machine:**

```
git clone <repo> miriel && cd miriel
# put data/, out/, .env and miriel.dump into the repo root
docker compose up -d db                        # empty database only; wait until `docker compose ps` shows it healthy
docker compose cp ./miriel.dump db:/tmp/miriel.dump
docker compose exec db pg_restore -U miriel -d miriel --no-owner /tmp/miriel.dump
npm run up                                     # migrations find everything applied; the app starts with all books
```

Restore into the **empty** database: before anything else starts on the new machine. `npm run up`, `index`, `py` and `retake` all run the migrations first, which create empty tables. If one of them already ran there, `npm run reset` first. Retake jobs and their history come along; the thumbnail cache rebuilds itself.

**Without a dump**: copy `data/`, `out/`, `.env`, then `npm run up` and `npm run index`. Same result; the embeddings are recomputed (a few minutes of Voyage API calls, no model calls).

**Linux hosts:** the containers that write `data/` and `out/` (retakes, extraction) run as uid 1000. If your user has another uid: `sudo chown -R 1000:1000 data out` (Docker Desktop on Windows/macOS needs nothing).

After the move, a quick check: `npm run py -- scripts/check_offset.py --book vol1 --images all`, then ask a question in the app and click a citation.

## Everyday commands

| npm | without npm | what |
| --- | --- | --- |
| `npm run up` | `docker compose up --build -d` | build and start the stack (app at :3000) |
| `npm run down` | `docker compose down` | stop; all data stays |
| `npm run reset` | `docker compose down -v` | clean slate: drops the database, thumbnail cache and pending uploads (then `npm run index`) |
| `npm run index` | `docker compose --profile index run --rm indexer` | (re)index every book from `out/`; unchanged pages are skipped |
| `npm run logs` | `docker compose logs -f api web` | follow the app logs |
| `npm run py -- scripts/<x>.py …` | `docker compose --profile retake run --rm --build --entrypoint python retake scripts/<x>.py …` | any Python script (extract, check_offset, qa_report, …) in the tools image |
| `npm run retake -- …` | `docker compose --profile retake run --rm --build retake …` | page retakes from the command line (`docs/retakes.md`) |
| `npm run rebuild-pdf -- --book <id>` | `… --entrypoint python retake scripts/rebuild_pdf.py --book <id>` | full PDF rebuild from the photos (hours) |

## Develop

```
npm install
docker compose up -d db
npm run migrate
npm run indexer -- ingest --all         # or: ingest --book vol1
npm run dev                 # api (8080, hot reload) + web (5173, proxies /api)
npm test
```

Harnesses: `npm run retrieve -- "<query>"`, `npm run answer -- [--inline] "<question>"`. The Python scripts also run on the host with uv (`uv run python scripts/…`); the OCR/PDF tools for retakes only exist in the Docker image.
To add a book, follow `docs/adding-a-book.md`; to replace bad page photos, `docs/retakes.md`. See `CLAUDE.md` for the layout, `docs/build-spec.md` for the design, `docs/retrieval.md` for how a query flows.
