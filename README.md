# Miriel

Chat with digitized Elden Ring strategy guides. Every claim in an answer carries a page citation; clicking it opens that page of the original PDF next to the chat, with the cited text highlighted.

There is also a quest checklist, u/Stellarwand's NPC-interaction lists for the base game and Shadow of the Erdtree (**Checklist** in the top bar). Each user ticks off steps per character, and each step opens its guide pages or asks the chat how to do it. Accounts are local and made by an admin; see `docs/checklist.md`.

## What you need

- **Docker** with Compose v2 (Docker Desktop on Windows/macOS, Docker Engine + the compose plugin on Linux). Everything runs in containers: the app, the database, OCR/PDF tools, the extraction scripts.
- **git** to get the code.
- Optional: **Node 22** for the `npm run …` shortcuts below. Each shortcut is one `docker compose` command, shown next to it, so you can run those directly instead.
- API keys in `.env`: `ANTHROPIC_API_KEY` (answers, and page extraction when adding a book) and `VOYAGE_API_KEY` (embeddings; a separate account: https://dashboard.voyageai.com).

## What lives where

| path | what | in git? | cost to recreate |
| --- | --- | --- | --- |
| `config/books.json` | the book list: file names, page offset, page count | yes | – |
| `config/checklists.json`, `config/checklists/` | the quest checklists (Markdown lists with item ids) and name aliases | yes | – |
| `data/` | per guide: the OCR'd PDF and a folder with one photo per PDF page; `data/_versions/` and `<imageDir>/_versions/` hold retake history. Per art book: the PDF, its hand-typed `.contents.json` and a folder of spread JPEGs | no | guides: the digitisation itself (photos, OCR); keep a backup. Art books: the PDF and contents file are the source; the spread folder is rebuilt in seconds with `scripts/art_export.py` |
| `out/<book>/` | extraction output, one `pNNN.json` per page, plus QA report and run log | no | **expensive**: about $60–105 and 1¼–2 h per book (model calls; Vol 1 $78, Vol 2 $104, Vol 3 $61) |
| `out/<art book>/` | artwork labels, one `sNNNN.json` per spread, hand corrections in `_overrides.json`, QA report and run log | no | about $10–14 and 10–20 min per art book (Art 1 $11, Art 2 $14, Art 3 $10); `_overrides.json` is hand-made |
| `out/checklists/` | checklist build, page links, overrides, QA report | no | seconds (`docs/checklist.md`), except hand-made `*_overrides.json` |
| database (volume `dbdata`) | chunks, embeddings, entities: built from `out/`; also **user accounts, runs and checklist progress, which exist nowhere else** | no | books: minutes with `npm run index`, or restore a dump (below); accounts and progress: only from a dump |
| `.env` | API keys and settings | no | copy it, or fill in from `.env.example` |
| volumes `thumbs`, `uploads` | thumbnail cache; retake photos waiting to be processed | no | regenerated on demand / empty when no retake is pending |

`data/` for the configured books (three guides, three art books):

```
data/
  Elden Ring Vol 1 - The Lands Between.pdf
  Elden Ring Vol 1 - The Lands Between/          Elden Ring Vol 1 - The Lands Between - 1.jpg … - 513.jpg
  Elden Ring Vol 2 - Shards of the Shattering.pdf
  Elden Ring Vol 2 - Shards of the Shattering/   Elden Ring Vol 2 - Shards of the Shattering - 1.jpg … - 530.jpg
  Elden Ring Vol 3 - Shadow of the Erdtree.pdf
  Elden Ring Vol 3 - Shadow of the Erdtree/      Elden Ring Vol 3 - Shadow of the Erdtree - 1.jpg … - 418.jpg
  Elden Ring Art Book Volume 1 Wide.pdf
  Elden Ring Art Book Volume 1 Wide.contents.json
  Elden Ring Art Book Volume 1 Wide/             Elden Ring Art Book Volume 1 Wide - 1.jpg … - 220.jpg
  Elden Ring Art Book Volume 2 Wide.pdf
  Elden Ring Art Book Volume 2 Wide.contents.json
  Elden Ring Art Book Volume 2 Wide/             Elden Ring Art Book Volume 2 Wide - 1.jpg … - 195.jpg
  Elden Ring Art Book Volume 3 Wide.pdf
  Elden Ring Art Book Volume 3 Wide.contents.json
  Elden Ring Art Book Volume 3 Wide/             Elden Ring Art Book Volume 3 Wide - 1.jpg … - 163.jpg
```

The names come from `pdf`, `imageDir` and `imagePattern` in `config/books.json`; the image folder and files use the PDF's spelling and case (Vol 2 and Vol 3 were exported as "… Of The …" and renamed, see `_rename-log.json` in the folder) (`{n}` = PDF page number = printed page + `printedToPdfOffset`). Photo n must be the photo embedded in PDF page n. How the PDFs were made (vFlat → img2pdf → ocrmypdf → outline → metadata) is described in `docs/build-spec-retakes.md` §1.

Art books (`"kind": "artbook"` in the config) have no text layer and no photos: file n of the image folder is PDF page n (one spread; the cover is file 1), written from the PDF by `scripts/art_export.py` (byte for byte, or stitched when the PDF tiles a spread from two JPEGs, as in Art Book Vol 3). The `.contents.json` next to the PDF maps printed folios to chapters and sections; it is typed in once from the book's contents page (`docs/adding-an-art-book.md` §5) and cannot be regenerated, so back it up with the PDF.

## Fresh install (a new machine, starting from the source files)

1. `git clone <repo> miriel && cd miriel`
2. `cp .env.example .env` and fill in the two API keys.
3. Put the PDFs and photo folders into `data/` as above, and the art books' PDFs and `.contents.json` files. A book that is not in `config/books.json` yet: add it first, see `docs/adding-a-book.md` (guides) or `docs/adding-an-art-book.md` (art books).
4. Check each book's page mapping (folio in the text layer, and every photo against the PDF):
   `npm run py -- scripts/check_offset.py --book vol1 --images all`
   For each art book, write the spread folder and check it: `npm run py -- scripts/art_export.py --book art1`, then `npm run py -- scripts/art_check.py --book art1`.
5. **If you have `out/` from somewhere, copy it in and skip this step.** Otherwise extract every page (the expensive step; a fixture run first is described in `docs/adding-a-book.md`):
   ```
   docker compose --profile retake run -d --name extract-vol1 --entrypoint python retake scripts/extract.py --book vol1 --workers 4 1-512
   docker logs -f extract-vol1        # follow; the run survives closing the terminal; docker rm extract-vol1 afterwards
   npm run py -- scripts/qa_report.py --book vol1
   ```
   The run is resumable: start the same command again and it skips pages that already have valid output.
   Art books without `out/<art id>/`: `npm run py -- scripts/art_label.py --book art1 --workers 4 1-220`, then `npm run py -- scripts/art_qa.py --book art1` (same resumable runner; about 10–20 min per book).
6. `npm run up` (`docker compose up --build -d`): builds the images, creates the database, applies migrations, starts the app at http://localhost:3000 (on the LAN: `http://<this machine>:3000`; another port: `WEB_PORT=8000` in `.env`).
7. `npm run index` (`docker compose --profile index run --rm indexer`): chunks and embeds every guide and art book from `out/` into the database. A few minutes for all six.
8. Create your admin account: `npm run user -- add <name> --admin` (`docker compose --profile index run --rm indexer user add <name> --admin`). It prints a one-time password; log in with it (top right, "Log in") and choose your own. More accounts are made in the app under your name > Users. Reading and chat stay open without a login unless `AUTH_REQUIRED=true` is set in `.env` (do that when the site is reachable from outside your network; with https also `COOKIE_SECURE=true`).

## Backup, restore and moving to another machine (no re-extraction, no re-embedding)

Everything expensive is in files: `data/`, `out/` and the database. One command puts them into a single zip, another puts them back. Both need Docker and Node 22.2+ on the host (nothing to `npm install`) and work the same on Windows, WSL2, macOS and Linux.

```
npm run export                 # -> backups/miriel_YYYYMMDD.zip (a second export the same day: miriel_YYYYMMDD-2.zip)
npm run import                 # restores the newest backups/miriel_*.zip (or the repo root's)
```

**Export** starts the database container if needed (the rest of the stack may keep running), dumps the database (`pg_dump -Fc`, run inside the container), then zips the dump, `data/` and `out/` (all of them: PDFs, photos, retake history in `_versions/`, extraction output and runs), and the retake photos still waiting in the `uploads` volume. About 3.5 GB and half a minute for the current six books; photos and PDFs are stored as they are, text is compressed. `--out <dir>` writes somewhere else (an external drive); `--with-env` adds `.env`. It refuses while a retake is running (its lock file in `data/_versions/`); wait for it to finish. The zip holds book text, user password hashes and, with `--with-env`, your API keys: keep it private (`backups/` and `*.zip` are ignored by git and Docker).

**Import** takes the newest backup, or a path (`npm run import -- D:/miriel_20260927.zip`; `--dir <dir>` searches another folder). Before it changes anything it extracts the whole zip into a staging folder and checks every file (CRC-32 and size). A backup whose database has migrations this checkout does not know is refused (`git pull` first). Then it:

1. stops the stack (`docker compose down`; the volumes stay),
2. moves what it replaces to `backups/pre-import-<time>/` (a dump of the current database, the old `data/` and `out/`, the old pending uploads). Delete that folder when the restore looks right,
3. restores the database into a fresh, empty `miriel` database, so it does not matter whether `npm run up` already ran on the new machine,
4. swaps in `data/` and `out/` and restores the pending uploads,
5. starts the stack again if it was running; otherwise run `npm run up`.

When there is something to replace it asks first (`--yes` skips the question, which scripts need). A missing `.env` is restored from the backup when the backup has one, or else created from `.env.example` (fill in the two API keys). An existing `.env` is never overwritten; a differing copy from the backup goes to `.env.from-backup`. User accounts, runs, checklist progress, retake jobs and their history come along (sessions too, so people stay logged in); the thumbnail cache rebuilds itself.

**Moving to a new machine:** `npm run export -- --with-env` (or copy `.env` securely yourself) on the old one; on the new one `git clone <repo> miriel && cd miriel`, put the zip into `backups/`, then `npm run import` and `npm run up`. Free space needed: about the size of the zip plus the unpacked files (≈ 7 GB now), since the zip is unpacked next to `data/`.

**By hand**, without Node (what the scripts do): `docker compose exec db pg_dump -U miriel -Fc -f /tmp/miriel.dump miriel`, then `docker compose cp db:/tmp/miriel.dump ./miriel.dump`, and copy `data/`, `out/`, `.env` and `miriel.dump` over. The dump is written inside the container and copied out with `docker compose cp` on purpose: redirecting `pg_dump` output with `>` in Windows PowerShell corrupts the binary file. On the new machine, restore into an **empty** database before anything else runs (`npm run up`, `index`, `py`, `retake` and `user` all run the migrations first, which create empty tables; if one of them already ran, `npm run reset` first): `docker compose up -d db`, wait until it is healthy, `docker compose cp ./miriel.dump db:/tmp/miriel.dump`, `docker compose exec db pg_restore -U miriel -d miriel --no-owner /tmp/miriel.dump`, then `npm run up`.

**Without a dump**: copy `data/`, `out/`, `.env`, then `npm run up` and `npm run index`. Same result, except that user accounts and checklist progress live only in the database and have to be created again; the embeddings are recomputed (a few minutes of Voyage API calls, no model calls).

**Linux hosts:** the containers that write `data/` and `out/` (retakes, extraction) run as uid 1000. If your user has another uid: `sudo chown -R 1000:1000 data out` (Docker Desktop on Windows/macOS needs nothing).

After the move, a quick check: `npm run py -- scripts/check_offset.py --book vol1 --images all`, then ask a question in the app and click a citation.

## Everyday commands

| npm | without npm | what |
| --- | --- | --- |
| `npm run up` | `docker compose up --build -d` | build and start the stack (app at :3000, `WEB_PORT`) |
| `npm run down` | `docker compose down` | stop; all data stays |
| `npm run reset` | `docker compose down -v` | clean slate: drops the database (books, user accounts), thumbnail cache and pending uploads (then `npm run index` and `npm run user -- add <name> --admin`) |
| `npm run index` | `docker compose --profile index run --rm indexer` | (re)index every book from `out/`; unchanged pages are skipped |
| `npm run export` | – (Node script, see above) | back up database, `data/`, `out/` and pending uploads to `backups/miriel_YYYYMMDD.zip` |
| `npm run import` | – | restore the newest backup (asks before replacing anything) |
| `npm run logs` | `docker compose logs -f api web` | follow the app logs |
| `npm run user -- add <name> [--admin]` | `docker compose --profile index run --rm indexer user add <name> [--admin]` | create an account (prints a one-time password); also `user list`, `user reset <name>`, `user role <name> admin\|user` for when nobody can log in, and `user del <name>` (deletes the account with its runs and progress; asks first, `--yes` skips) |
| `npm run py -- scripts/<x>.py …` | `docker compose --profile retake run --rm --build --entrypoint python retake scripts/<x>.py …` | any Python script (extract, check_offset, qa_report, …) in the tools image |
| `npm run retake -- …` | `docker compose --profile retake run --rm --build retake …` | page retakes from the command line (`docs/retakes.md`) |
| `npm run py -- scripts/checklist_build.py`, `npm run checklist-pages` | `docker compose run --rm --no-deps -v ./out:/app/out api node packages/api/dist/checklist-pages-cli.js` | rebuild the checklists after editing them (`docs/checklist.md`), then `npm run index` |
| `npm run rebuild-pdf -- --book <id>` | `… --entrypoint python retake scripts/rebuild_pdf.py --book <id>` | full PDF rebuild from the photos (hours) |

## Develop

```
npm install
docker compose up -d db
npm run migrate
npm run indexer -- ingest --all         # or: ingest --book vol1
npm run dev                 # api (8080, hot reload) + web (5173 or WEB_DEV_PORT, proxies /api)
npm test
```

Harnesses: `npm run retrieve -- "<query>"`, `npm run answer -- [--inline] "<question>"`. The Python scripts also run on the host with uv (`uv run python scripts/…`); the OCR/PDF tools for retakes only exist in the Docker image.
To add a book, follow `docs/adding-a-book.md`; to replace bad page photos, `docs/retakes.md`. See `CLAUDE.md` for the layout, `docs/build-spec.md` for the design, `docs/retrieval.md` for how a query flows.
