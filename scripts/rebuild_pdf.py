"""Rebuild a book PDF from its current image folder: the original digitisation pipeline over every page.

For when a large share of a book was re-shot (the retake UI suggests it past 20 % of the pages since the last
full build); never started automatically. Runs in the Docker `retake` image:

  npm run rebuild-pdf -- --book vol1              # asks once, then builds, verifies and swaps in (hours of OCR)
  npm run rebuild-pdf -- --book vol1 --dry-run    # build and verify only; the book PDF is not touched
  npm run rebuild-pdf -- --book vol1 --yes        # no question (detached / scripted runs)

Steps (docs/build-spec-retakes.md §7.3):
  1. img2pdf over the image folder in page order (1..pageCount), at the current PDF's page size, fit fill
  2. ocrmypdf -l eng --optimize 1 --output-type pdfa --jobs <cpus>        (the long step)
  3. outline from DATA_DIR/<pdf stem>.toc.txt if present (pdftocio format: `"Title" <pdf page>`, 4 spaces per
     level), else from the current PDF; Title/Author/Subject/Keywords copied from the current PDF, XMP kept in
     step with them (so the rebuilt file does not carry the old pdf:Author PDF/A defect)
  4. verify the temp file: page count, outline entries and targets, metadata, every photo vs its image file and
     a folio sample (check_offset.py's checks), text layer present on about as many pages as before
  5. swap in: the current PDF becomes DATA_DIR/_versions/<pdf>.v<k>.pdf (last 3 kept), the rebuild takes its
     place, `pdf_rebuilt` is logged in DATA_DIR/_versions/log.jsonl (the UI counts replaced pages from there)

Holds the book's retake lock for the whole run, so retakes (CLI or worker) wait. The OCR result is kept in
DATA_DIR/_versions/work/rebuild-<book>/ until the swap: a run killed after OCR reuses it (same images).
Extraction output is not touched: it was made from the same photos; the viewer picks up the new revision.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_offset import check_folios, check_images, default_sample, page_numbers_in  # noqa: E402
from pages import BOOKS, Book  # noqa: E402
from retake import (  # noqa: E402
    PDF_VERSIONS_KEPT, Store, acquire_lock, append_jsonl, copy_atomic, now, refuse_if_unfinished, release_lock,
    require_tools, say, sha256_file,
)

TOC_LINE = re.compile(r'^(\s*)"(.*)"\s+(-?\d+)(?:\s.*)?$')
META_KEYS = ("/Title", "/Author", "/Subject", "/Keywords")
TEXT_PAGES_TOLERANCE = 0.02   # the rebuild may have up to 2 % fewer pages with a text layer than the current PDF


def read_toc_file(path: Path) -> list[list]:
    """pdftocio's text format -> [[level, title, pdf page]] (the shape pymupdf's get_toc() returns)."""
    toc = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        m = TOC_LINE.match(line)
        if not m:
            sys.exit(f"{path.name}:{n}: not a `\"Title\" page` line: {line!r}")
        toc.append([len(m.group(1).expandtabs(4)) // 4 + 1, m.group(2).replace('\\"', '"'), int(m.group(3))])
    return toc


def images_fingerprint(files: list[Path]) -> str:
    """Cheap identity of the image folder state (names, sizes, mtimes) for reusing an OCR result."""
    h = hashlib.sha256()
    for f in files:
        st = f.stat()
        h.update(f"{f.name}:{st.st_size}:{int(st.st_mtime)}\n".encode())
    return h.hexdigest()


def set_outline(pdf, toc: list[list]) -> None:
    import pikepdf

    with pdf.open_outline() as outline:
        outline.root.clear()
        stack: list[tuple[int, list]] = [(0, outline.root)]
        for level, title, page in toc:
            item = pikepdf.OutlineItem(title, page - 1) if page >= 1 else pikepdf.OutlineItem(title)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack[-1][1].append(item)
            stack.append((level, item.children))


def build(book: Book, store: Store, work: Path, toc: list[list], old_meta: dict, jobs: int) -> Path:
    import img2pdf
    import pikepdf

    files = [book.image_path(p) for p in range(book.first_printed, book.last_printed + 1)]
    missing = [f.name for f in files if not f.exists()]
    if missing:
        sys.exit(f"{len(missing)} image file(s) missing, e.g. {missing[:5]}; the image folder must hold one photo per page")
    work.mkdir(parents=True, exist_ok=True)
    state_file = work / "state.json"
    state = json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
    fingerprint = images_fingerprint(files)
    raw, ocr = work / "raw.pdf", work / "ocr.pdf"

    with pymupdf.open(book.pdf) as cur:
        rect = cur[0].rect
    if state.get("fingerprint") == fingerprint and ocr.exists():
        say(f"reusing the OCR result from {state.get('ocr_done')} (image folder unchanged)")
    else:
        t0 = time.time()
        say(f"1/3 img2pdf: {len(files)} photos at {rect.width:.2f} x {rect.height:.2f} pt, fit fill")
        layout = img2pdf.get_layout_fun((rect.width, rect.height), None, None, img2pdf.FitMode.fill, False)
        with raw.open("wb") as f:
            img2pdf.convert([str(p) for p in files], layout_fun=layout, outputstream=f)
        say(f"    {raw.stat().st_size / 1e6:.0f} MB in {time.time() - t0:.0f}s")
        t0 = time.time()
        say(f"2/3 ocrmypdf -l eng --optimize 1 --output-type pdfa --jobs {jobs} (the long step)")
        ocr.unlink(missing_ok=True)
        subprocess.run([sys.executable, "-m", "ocrmypdf", "-l", "eng", "--optimize", "1", "--output-type", "pdfa",
                        "--jobs", str(jobs), str(raw), str(ocr)], check=True)
        say(f"    done in {(time.time() - t0) / 60:.1f} min")
        state = {"fingerprint": fingerprint, "ocr_done": now()}
        state_file.write_text(json.dumps(state), encoding="utf-8")
        raw.unlink(missing_ok=True)

    say("3/3 outline and metadata")
    tmp = book.pdf.with_name(book.pdf.name + ".rebuild.tmp")
    with pikepdf.open(ocr) as pdf:
        set_outline(pdf, toc)
        for k in META_KEYS:
            if k in old_meta:
                pdf.docinfo[k] = old_meta[k]
        with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
            meta.load_from_docinfo(pdf.docinfo)
        pdf.save(tmp)
    return tmp


def verify(book: Book, tmp: Path, toc: list[list], old_meta: dict, old_text_pages: int, confirmed_before: set[int]) -> list[str]:
    errors: list[str] = []
    with pymupdf.open(tmp) as doc:
        if len(doc) != book.page_count:
            return [f"page count {len(doc)} != {book.page_count}"]
        if doc.get_toc() != toc:
            errors.append(f"outline differs from the source ({len(doc.get_toc())} vs {len(toc)} entries or targets)")
        meta = doc.metadata
        for k in META_KEYS:
            want = old_meta.get(k)
            if want is not None and meta.get(k[1:].lower()) != str(want):
                errors.append(f"{k[1:]} is {meta.get(k[1:].lower())!r}, expected {str(want)!r}")
        text_pages = sum(1 for p in doc if p.get_text().strip())
        if text_pages < old_text_pages * (1 - TEXT_PAGES_TOLERANCE):
            errors.append(f"only {text_pages} pages have a text layer (the current PDF has {old_text_pages})")
        say(f"\nverify: {len(doc)} pages, {len(toc)} outline entries, text layer on {text_pages} pages (was {old_text_pages})")
        bad = check_images(book, doc, list(range(1, len(doc) + 1)))
        if bad:
            errors.append(f"{len(bad)} photo(s) do not match their image file: pdf pages {bad[:10]}")
        # The photo check above already proves the page order; a fresh OCR can read a stray number next to a page
        # the old text layer had no folio for (front matter, maps). Only a folio the current PDF confirms counts.
        _, mismatched, _ = check_folios(book, doc, default_sample(book))
        hard = [p for p in mismatched if p in confirmed_before]
        if hard:
            errors.append(f"folio check contradicts the offset on printed pages {hard} (confirmed in the current PDF)")
        elif mismatched:
            say(f"note: new text layer reads a neighbouring folio on printed pages {mismatched}, which had no folio in the current PDF")
    return errors


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--dry-run", action="store_true", help="build and verify; do not swap the book PDF")
    ap.add_argument("--yes", action="store_true", help="do not ask before starting")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="ocrmypdf worker processes (default: all CPUs)")
    args = ap.parse_args()
    require_tools()
    book = BOOKS[args.book]
    store = Store(book)
    if not book.pdf.exists():
        sys.exit(f"missing {book.pdf}")

    toc_file = book.pdf.with_suffix(".toc.txt")
    with pymupdf.open(book.pdf) as cur:
        if len(cur) != book.page_count:
            sys.exit(f"the current PDF has {len(cur)} pages, config pageCount is {book.page_count}")
        toc = read_toc_file(toc_file) if toc_file.exists() else cur.get_toc()
        old_text_pages = sum(1 for p in cur if p.get_text().strip())
        confirmed_before = {p for p in default_sample(book) if p in page_numbers_in(cur[book.pdf_index(p)])}
    import pikepdf
    with pikepdf.open(book.pdf) as cur_pdf:
        old_meta = {k: str(cur_pdf.docinfo[k]) for k in META_KEYS if k in cur_pdf.docinfo}
    say(f"{book.key}: rebuild {book.pdf.name} from {book.image_dir.name}/ ({book.page_count} pages); outline from "
        f"{toc_file.name if toc_file.exists() else 'the current PDF'} ({len(toc)} entries); metadata {sorted(k[1:] for k in old_meta)}")
    if not args.yes:
        if not sys.stdin.isatty():
            sys.exit("not a terminal: pass --yes")
        if input("OCR of the whole book takes a long time (the original run took hours). Start? [y/N] ").strip().lower() not in ("y", "yes"):
            sys.exit("cancelled")

    refuse_if_unfinished(store)
    lock_id = "rebuild-" + time.strftime("%Y%m%d-%H%M%S")
    acquire_lock(store, lock_id)
    started = time.time()
    try:
        work = store.root / "work" / f"rebuild-{book.key}"
        tmp = build(book, store, work, toc, old_meta, args.jobs)
        errors = verify(book, tmp, toc, old_meta, old_text_pages, confirmed_before)
        if errors:
            tmp.unlink(missing_ok=True)
            sys.exit("verification FAILED; the book PDF was not changed:\n  " + "\n  ".join(errors))
        say("verification ok")
        if args.dry_run:
            tmp.unlink(missing_ok=True)
            say(f"dry run: nothing swapped (OCR result kept in {work} for the real run)")
            return
        old_sha, new_sha = sha256_file(book.pdf), sha256_file(tmp)
        versions = store.pdf_versions()
        k = versions[-1][0] + 1 if versions else 1
        say(f"keeping the current PDF as _versions/{store.pdf_version(k).name}")
        copy_atomic(book.pdf, store.pdf_version(k))
        os.replace(tmp, book.pdf)
        for _, old in store.pdf_versions()[:-PDF_VERSIONS_KEPT]:
            old.unlink()
            append_jsonl(store.book_log, {"at": now(), "book": book.key, "event": "pdf_version_deleted", "file": old.name,
                                          "keep": PDF_VERSIONS_KEPT, "txn": lock_id})
        append_jsonl(store.book_log, {"at": now(), "book": book.key, "event": "pdf_rebuilt", "txn": lock_id,
                                      "pages": book.page_count, "version_file": store.pdf_version(k).name,
                                      "old_sha256": old_sha, "new_sha256": new_sha, "minutes": round((time.time() - started) / 60, 1)})
        shutil.rmtree(work, ignore_errors=True)
        say(f"{book.pdf.name} rebuilt ({old_sha[:12]} -> {new_sha[:12]}) in {(time.time() - started) / 60:.1f} min")
    finally:
        release_lock(store, lock_id)


if __name__ == "__main__":
    main()
