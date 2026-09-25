"""Replace the photo of a book page end to end: image, PDF page (with OCR layer), extraction, index, thumbnail.

Runs in the Docker `retake` image (ocrmypdf, tesseract, ghostscript, qpdf, pikepdf and the indexer); on the host
use the npm wrapper, which builds the image and mounts ./data, ./out and the photo inbox (RETAKE_INBOX, default
./retakes; relative --image / --dir paths resolve against it):

  npm run retake -- --book vol1 --page 289 --image page_290.jpg      # one page (printed page 289 = image 290)
  npm run retake -- --book vol1 --dir .                              # every photo in the inbox, one PDF write
  npm run retake -- --book vol1 --page 289 --image x.jpg --dry-run   # validate, build and verify; write nothing
  npm run retake -- --book vol1 --rollback --page 289                # undo the latest retake of the page (no model call)
  npm run retake -- --book vol1 --history [--page 289]               # versions of the book's pages
  npm run retake -- --book vol1 --resume <id>                        # finish an interrupted retake
  npm run retake -- --book vol1 --abandon <id>                       # drop one that has not touched the PDF yet

Steps (docs/build-spec-retakes.md §3). Nothing is written before the confirm, which shows the folio check, warnings
and the extraction estimate against RETAKE_DAILY_BUDGET_USD (default 10). Then:
  stage      normalised photos (EXIF orientation applied, PNG -> JPEG q92) into DATA_DIR/_versions/work/<id>/
  build      img2pdf at the book page's own size, fit fill -> ocrmypdf -l eng --optimize 1 --output-type pdfa
  splice     pikepdf: the book's page object keeps its identity (so the outline still resolves), only its content
             and resources are replaced; written to a temp file next to the PDF and verified (page count, outline,
             document info + XMP byte-identical, every other page's content unchanged, photo == image file,
             folio, text layer)
  commit_pdf old PDF -> DATA_DIR/_versions/<pdf>.v<k>.pdf (last 3 kept), each replaced page saved on its own as
             DATA_DIR/_versions/pages/<book>/pNNNN.v<j>.pdf, temp file renamed over the book PDF
  commit_images  old photo -> <imageDir>/_versions/<name>.v<j>.jpg, new photo in place, <imageDir>/_versions/log.jsonl
  history    out/<book>/pNNNN.json -> out/<book>/_history/pNNNN.v<j>.json
  extract    extract.py --force (same model, effort and prompt as the full run), tagged with the retake id
  ingest     indexer ingest --book <id> --pages ...
  thumbs     delete the page's cached thumbnail
  qa         re-generate out/<book>/_qa.md and _retakes.txt (scripts/qa_report.py), so the report and the queue agree
Version j is per page: the state a retake replaced is kept as vj, and rollback of that retake restores vj (the
saved PDF page puts back the exact old text layer). A rollback archives what it replaces too, so it can be undone.

Each retake keeps a journal (DATA_DIR/_versions/retakes/<book>/<id>.json) of completed stages and holds a per-book
lock until it is done; a killed run is finished with --resume, which skips completed stages and pages.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_offset import (  # noqa: E402
    FOOTER_BAND, HASH_TOLERANCE, HEADER_BAND, _INT, distance, file_photo, page_numbers_in, pdf_photo, signature,
)
from pages import BOOKS, ROOT, Book, data_dir  # noqa: E402

ASPECT_TOLERANCE = 0.15       # relative deviation from the PDF page's width/height
FOLIO_NEIGHBOURHOOD = 5       # a folio this close to the expected one means "photo of another page"
# Perceptual-hash distance (of 64 bits, check_offset.signature) between a new photo and a page's current photo.
# Measured on Vol 1: simulated re-shoots of the same page (rotation up to 2.5 deg, 6 % crop, +-20 % contrast)
# stay at 1-12; different pages are 15 and more (neighbours 18+). Up to this value the photo "looks like" the page.
SAME_PAGE_MAX_DISTANCE = 14
PHOTO_MATCH_MARGIN = 6        # identifying by photo alone: the best page must beat the runner-up by this much
PDF_VERSIONS_KEPT = 3
DEFAULT_PAGE_ESTIMATE_USD = 0.20
EXTRACT_WORKERS = 4
RETAKE_STAGES = ["stage", "build", "splice", "commit_pdf", "commit_images", "history", "extract", "ingest", "thumbs", "qa"]
ROLLBACK_STAGES = ["stage", "splice", "commit_pdf", "commit_images", "history", "ingest", "thumbs", "qa"]
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png"}


def say(msg: str = "") -> None:
    print(msg, flush=True)


EMIT_PREFIX = "::retake:: "
_emit = False


def emit(event: str, **data) -> None:
    """Machine-readable progress for the retake worker (--json): one prefixed JSON line per event."""
    if _emit:
        print(EMIT_PREFIX + json.dumps({"event": event, **data}, ensure_ascii=False, default=str), flush=True)


def now() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def copy_atomic(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.copyfile(src, tmp)
    tmp.replace(dst)


def require_tools() -> None:
    missing = [t for t in ("tesseract", "gs", "qpdf") if not shutil.which(t)]
    for mod in ("pikepdf", "img2pdf", "ocrmypdf"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        sys.exit(f"missing tools: {', '.join(missing)}. retake.py runs in the Docker `retake` image:\n"
                 f"  npm run retake -- {' '.join(sys.argv[1:])}")


# ----------------------------------------------------------------------------- where things live

class Store:
    """File layout of versions, journals and work directories for one book."""

    def __init__(self, book: Book):
        self.book = book
        self.root = data_dir() / "_versions"
        self.out_dir = ROOT / "out" / book.key

    # book level
    @property
    def lock(self) -> Path:
        return self.root / f"{self.book.key}.lock"

    @property
    def journal_dir(self) -> Path:
        return self.root / "retakes" / self.book.key

    def journal(self, txn_id: str) -> Path:
        return self.journal_dir / f"{txn_id}.json"

    def work(self, txn_id: str) -> Path:
        return self.root / "work" / txn_id

    @property
    def book_log(self) -> Path:
        return self.root / "log.jsonl"

    def pdf_version(self, k: int) -> Path:
        return self.root / f"{self.book.pdf.stem}.v{k}.pdf"

    def pdf_versions(self) -> list[tuple[int, Path]]:
        rx = re.compile(re.escape(self.book.pdf.stem) + r"\.v(\d+)\.pdf$")
        found = [(int(m.group(1)), p) for p in self.root.glob("*.pdf") if (m := rx.match(p.name))] if self.root.exists() else []
        return sorted(found)

    # page level (printed page numbers; image files are named by image number)
    def image(self, printed: int) -> Path:
        return self.book.image_path(printed)

    @property
    def image_versions_dir(self) -> Path:
        return self.book.image_dir / "_versions"

    @property
    def image_log(self) -> Path:
        return self.image_versions_dir / "log.jsonl"

    def image_version(self, printed: int, j: int) -> Path:
        img = self.image(printed)
        return self.image_versions_dir / f"{img.stem}.v{j}{img.suffix}"

    def page_pdf_version(self, printed: int, j: int) -> Path:
        return self.root / "pages" / self.book.key / f"p{printed:04d}.v{j}.pdf"

    def page_json(self, printed: int) -> Path:
        return self.out_dir / f"p{printed:04d}.json"

    def json_version(self, printed: int, j: int) -> Path:
        return self.out_dir / "_history" / f"p{printed:04d}.v{j}.json"

    def next_page_version(self, printed: int) -> int:
        img = self.image(printed)
        pats = [(self.image_versions_dir, re.escape(img.stem) + r"\.v(\d+)" + re.escape(img.suffix) + "$"),
                (self.root / "pages" / self.book.key, rf"p{printed:04d}\.v(\d+)\.pdf$"),
                (self.out_dir / "_history", rf"p{printed:04d}\.v(\d+)\.json$")]
        used = [0]
        for d, pat in pats:
            if d.exists():
                rx = re.compile(pat)
                used += [int(m.group(1)) for p in d.iterdir() if (m := rx.match(p.name))]
        return max(used) + 1

    def journals(self) -> list[dict]:
        if not self.journal_dir.exists():
            return []
        return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(self.journal_dir.glob("*.json"))]


def acquire_lock(store: Store, txn_id: str) -> None:
    store.lock.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(store.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        holder = store.lock.read_text(encoding="utf-8").strip()
        if holder == txn_id:
            return
        sys.exit(f"{store.book.key} is locked by retake {holder}: finish it with --resume {holder} "
                 f"(or --abandon {holder} if it has not replaced the PDF yet)")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(txn_id)


def release_lock(store: Store, txn_id: str) -> None:
    if store.lock.exists() and store.lock.read_text(encoding="utf-8").strip() == txn_id:
        store.lock.unlink()


# ----------------------------------------------------------------------------- page summaries

def summary(path: Path) -> dict | None:
    """The quality fields compared before/after a retake."""
    if not path.exists():
        return None
    obj = json.loads(path.read_text(encoding="utf-8"))
    q = obj["quality"]
    return {"image_quality": q["image_quality"], "retake_recommended": q["retake_recommended"],
            "ocr_agreement": q["ocr_agreement"], "quality_issues": q.get("quality_issues") or [],
            "entities": len(obj["entities"]), "markdown_chars": len(obj["markdown"])}


def page_estimate_usd(store: Store) -> float:
    costs = [r["cost_usd"] for r in read_jsonl(store.out_dir / "_runlog.jsonl")
             if r.get("status") == "ok" and isinstance(r.get("cost_usd"), (int, float))]
    return round(statistics.median(costs[-300:]), 3) if costs else DEFAULT_PAGE_ESTIMATE_USD


def spent_today(exclude: str | None = None) -> float:
    today = dt.datetime.now().astimezone().date().isoformat()
    root = data_dir() / "_versions" / "retakes"
    total = 0.0
    for p in root.glob("*/*.json") if root.exists() else []:
        j = json.loads(p.read_text(encoding="utf-8"))
        if j["id"] != exclude and j["created"][:10] == today:
            total += j.get("cost_usd") or 0.0
    return total


def budget() -> float:
    return float(os.environ.get("RETAKE_DAILY_BUDGET_USD") or 10)


# ----------------------------------------------------------------------------- validation

def resolve_input(raw: str) -> Path:
    p = Path(raw).expanduser()
    inbox = os.environ.get("RETAKE_INBOX")
    if not p.is_absolute() and inbox:
        p = Path(inbox) / p
    return p


def image_number_from_name(book: Book, name: str) -> int | None:
    """Image number (printed + offset) from a vFlat/renamed file name: the book's imagePattern or page_NNN."""
    stem_pat = re.escape(Path(book.image_pattern).stem).replace(r"\{n\}", r"0*(\d+)")
    for rx in (rf"(?i)^{stem_pat}\.(?:jpe?g|png)$", r"(?i)^page[_\- ]?0*(\d+)\.(?:jpe?g|png)$"):
        if m := re.match(rx, name):
            return int(m.group(1))
    return None


def normalise(src: Path) -> tuple[bytes, Image.Image, str]:
    """JPEG bytes for the image folder: a JPEG without rotation is kept byte for byte; otherwise EXIF orientation
    is applied and the result encoded as JPEG quality 92."""
    im = Image.open(src)
    fmt = im.format
    if fmt not in ("JPEG", "MPO", "PNG"):
        raise ValueError(f"{src.name}: {fmt} is not JPEG or PNG")
    orientation = im.getexif().get(0x0112, 1)
    if fmt == "JPEG" and orientation == 1:
        im.load()
        return src.read_bytes(), im, "JPEG kept as is"
    icc = im.info.get("icc_profile")
    out = ImageOps.exif_transpose(im).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=92, **({"icc_profile": icc} if icc else {}))
    why = [f"{fmt} -> JPEG q92"] + ([f"EXIF orientation {orientation} applied"] if orientation != 1 else [])
    return buf.getvalue(), out, ", ".join(why)


def folio_numbers(im: Image.Image) -> list[int]:
    """Integers tesseract reads in the footer band of the photo (else the header band), as check_offset.py does
    on the text layer."""
    w, h = im.size
    for box in ((0, int(h * (1 - FOOTER_BAND)), w, h), (0, 0, w, int(h * HEADER_BAND))):
        band = im.crop(box).convert("L")
        if band.width < 2400:
            band = band.resize((band.width * 2, band.height * 2), Image.LANCZOS)
        buf = io.BytesIO()
        band.save(buf, "PNG")
        r = subprocess.run(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11"], input=buf.getvalue(),
                           capture_output=True, check=True)
        nums = [int(m.group(1)) for m in _INT.finditer(r.stdout.decode("utf-8", "replace"))]
        if nums:
            return list(dict.fromkeys(nums))
    return []


def static_numbers(book: Book, doc: pymupdf.Document, printed: int) -> set[int]:
    """Numbers in the current page's footer/header that are not its folio (chapter numbers etc.)."""
    return set(page_numbers_in(doc[book.pdf_index(printed)])) - {printed}


def check_folio(book: Book, doc: pymupdf.Document, printed: int, nums: list[int]) -> tuple[str, str]:
    """(ok | mismatch | none | unclear, message)."""
    if printed in nums:
        return "ok", f"folio {printed} found"
    candidates = [n for n in nums if n not in static_numbers(book, doc, printed)]
    near = [n for n in candidates if 0 < abs(n - printed) <= FOLIO_NEIGHBOURHOOD and book.first_printed <= n <= book.last_printed]
    if near:
        return "mismatch", f"this photo looks like printed page {near[0]}, not {printed}"
    if not nums:
        return "none", "no folio found in the footer/header (normal for maps and full-page art)"
    return "unclear", f"folio {printed} not found (numbers read: {', '.join(map(str, nums[:8]))})"


def current_signature(book: Book, printed: int) -> str | None:
    f = file_photo(book.image_path(printed))
    return f[1] if f else None


def photo_distance(book: Book, printed: int, sig: str) -> int | None:
    """Hash distance between a new photo and the page's current photo (None: no current photo)."""
    cur = current_signature(book, printed)
    return None if cur is None else distance(sig, cur)


def identify_page(book: Book, doc: pymupdf.Document, nums: list[int], sig: str) -> tuple[int | None, str, str]:
    """(printed page, how, note) for a photo whose file name carries no page number.

    1. Folio: a number read in the footer/header band that is also that page's folio in the current PDF AND whose
       current photo looks like the new one (a stray number in a map's footer once matched the wrong page).
    2. Photo: no usable folio (maps, faint print): the page whose current photo is clearly the closest.
    """
    hits = []
    for n in dict.fromkeys(nums):
        if book.first_printed <= n <= book.last_printed and n in page_numbers_in(doc[book.pdf_index(n)]):
            d = photo_distance(book, n, sig)
            if d is not None and d <= SAME_PAGE_MAX_DISTANCE:
                hits.append((d, n))
    if len(hits) == 1 or (len(hits) > 1 and sorted(hits)[1][0] - sorted(hits)[0][0] >= PHOTO_MATCH_MARGIN):
        d, n = sorted(hits)[0]
        return n, "folio", f"folio {n}, photo distance {d}/64 to the current page"
    scores = []
    for n in range(book.first_printed, book.last_printed + 1):
        d = photo_distance(book, n, sig)
        if d is not None:
            scores.append((d, n))
    scores.sort()
    if scores and scores[0][0] <= SAME_PAGE_MAX_DISTANCE and (len(scores) == 1 or scores[1][0] - scores[0][0] >= PHOTO_MATCH_MARGIN):
        d, n = scores[0]
        runner = f", next best p{scores[1][1]} at {scores[1][0]}" if len(scores) > 1 else ""
        return n, "photo", f"matched by photo: distance {d}/64 to the current p{n}{runner}"
    best = ", ".join(f"p{n} ({d})" for d, n in scores[:3])
    return None, "", f"numbers read: {nums[:8] or 'none'}; closest current photos: {best or 'none'}"


def validate_photo(book: Book, doc: pymupdf.Document, src: Path, printed: int | None, how: str,
                   skip_folio: bool) -> dict:
    """One upload -> plan item with errors (hard stops) and warnings (the operator decides)."""
    item: dict = {"source": str(src), "printed": printed, "match": how, "errors": [], "warnings": [], "notes": []}
    try:
        data, im, note = normalise(src)
    except Exception as e:  # noqa: BLE001 - any unreadable file is a hard stop for that file
        item["errors"].append(f"cannot read image: {e}")
        return item
    item["notes"].append(note)
    item["_bytes"] = data
    item["sha256"] = hashlib.sha256(data).hexdigest()
    item["size"] = list(im.size)

    nums = [] if skip_folio else folio_numbers(im)
    sig = signature(im)
    if printed is None:
        printed, how, note = identify_page(book, doc, nums, sig)
        if printed is None:
            item["errors"].append("no page number in the file name and neither the folio nor the photo identifies a page "
                                  f"({note}); set the page by hand or rename it page_NNN.jpg (NNN = image number)")
            return item
        item["printed"], item["match"] = printed, how
        item["notes"].append(note)
    try:
        idx = book.pdf_index(printed)
    except ValueError as e:
        item["errors"].append(str(e))
        return item
    item["image_no"] = idx + 1

    if skip_folio:
        item["folio"] = "skipped (--skip-folio-check)"
        item["warnings"].append("folio check skipped")
    else:
        status, msg = check_folio(book, doc, printed, nums)
        item["folio"] = msg
        if status == "mismatch":
            item["errors"].append(msg)
        elif status != "ok":
            item["warnings"].append(msg)

    rect = doc[idx].rect
    want, have = rect.width / rect.height, im.size[0] / im.size[1]
    if abs(have / want - 1) > ASPECT_TOLERANCE:
        item["warnings"].append(f"aspect {have:.3f} vs page {want:.3f} (off by {abs(have / want - 1):.0%}: a crop or two pages in frame?)")
    current = book.image_path(printed)
    if current.exists() and sha256_file(current) == item["sha256"]:
        item["warnings"].append("identical to the current photo")
    elif item["match"] in ("--page", "filename") and not item["errors"]:
        d = photo_distance(book, printed, sig)
        if d is not None and d > SAME_PAGE_MAX_DISTANCE:
            other, _, note = identify_page(book, doc, nums, sig)
            if other is not None and other != printed:
                # folio and/or photo clearly say another page: same hard stop as a neighbouring folio
                item["errors"].append(f"this photo looks like printed page {other}, not {printed} ({note})")
            else:
                item["warnings"].append(f"does not look like the current photo of page {printed} (distance {d}/64, same page "
                                        f"is usually <= {SAME_PAGE_MAX_DISTANCE}): is it the right page?")
    return item


# ----------------------------------------------------------------------------- PDF build, splice, verify

def build_pages(book: Book, doc: pymupdf.Document, items: list[dict], work: Path) -> Path:
    """Reproduce the digitisation pipeline for the staged photos: img2pdf (book page size, fit fill), then one
    ocrmypdf run over all of them. Returns a PDF whose page i belongs to items[i]."""
    import img2pdf
    import pikepdf

    raw = pikepdf.new()
    for it in items:
        rect = doc[book.pdf_index(it["printed"])].rect
        layout = img2pdf.get_layout_fun((rect.width, rect.height), None, None, img2pdf.FitMode.fill, False)
        one = pikepdf.open(io.BytesIO(img2pdf.convert(str(work / it["staged"]), layout_fun=layout)))
        raw.pages.extend(one.pages)
    raw_path, out = work / "raw.pdf", work / "pages.pdf"
    raw.save(raw_path)
    cmd = [sys.executable, "-m", "ocrmypdf", "-l", "eng", "--optimize", "1", "--output-type", "pdfa",
           "--jobs", str(os.cpu_count() or 1), "--quiet", str(raw_path), str(out)]
    say(f"  ocrmypdf over {len(items)} page(s)")
    subprocess.run(cmd, check=True)
    with pikepdf.open(out) as check:
        if len(check.pages) != len(items):
            raise RuntimeError(f"ocrmypdf produced {len(check.pages)} pages for {len(items)} photos")
    return out


def splice(book: Book, sources: list[tuple[int, Path, int]], tmp: Path, work: Path) -> None:
    """Replace the content of the book's pages in place. sources: (printed, pdf, page index in it). The page objects
    stay where they are, so outline destinations keep resolving; the replaced pages are saved on their own first
    (work/old_pNNNN.pdf) for rollback."""
    import pikepdf

    with pikepdf.open(book.pdf) as pdf:
        opened: dict[Path, pikepdf.Pdf] = {}
        try:
            for printed, src_path, src_idx in sources:
                idx = book.pdf_index(printed)
                single = pikepdf.new()
                single.pages.append(pdf.pages[idx])
                single.save(work / f"old_p{printed:04d}.pdf")
                src = opened.setdefault(src_path, pikepdf.open(src_path))
                page = pdf.pages[idx].obj
                keep = page.objgen
                foreign = pdf.copy_foreign(src.pages[src_idx].obj)
                for k in [k for k in page.keys() if k not in ("/Type", "/Parent")]:
                    del page[k]
                for k, v in foreign.items():
                    if k not in ("/Type", "/Parent"):
                        page[k] = v
                assert pdf.pages[idx].obj.objgen == keep
            # fix_metadata_version=False keeps the XMP packet byte-identical (pikepdf would re-serialise it)
            pdf.save(tmp, fix_metadata_version=False)
        finally:
            for s in opened.values():
                s.close()


def verify(book: Book, old: Path, new: Path, items: list[dict], work: Path) -> list[str]:
    """Checks before the swap; returns errors (empty = ok). Fills it['text_chars'] = [old, new]."""
    a, b = pymupdf.open(old), pymupdf.open(new)
    errors: list[str] = []
    try:
        if len(a) != len(b):
            return [f"page count {len(b)} != {len(a)}"]
        if a.get_toc() != b.get_toc():
            errors.append(f"outline differs ({len(a.get_toc())} -> {len(b.get_toc())} entries or targets changed)")
        if a.metadata != b.metadata:
            errors.append("document info changed")
        if a.get_xml_metadata() != b.get_xml_metadata():
            errors.append("XMP metadata changed")
        replaced = {book.pdf_index(it["printed"]) for it in items}

        def content(doc: pymupdf.Document, i: int) -> bytes:
            return b"".join(doc.xref_stream_raw(x) or b"" for x in doc[i].get_contents())

        changed = [i + 1 for i in range(len(a)) if i not in replaced and content(a, i) != content(b, i)]
        if changed:
            errors.append(f"pages not being replaced changed: pdf pages {changed[:10]}")
        for it in items:
            p, idx = it["printed"], book.pdf_index(it["printed"])
            photo, f = pdf_photo(b, idx), file_photo(work / it["staged"])
            if photo is None or f is None or photo[0] != f[0] or distance(photo[1], f[1]) > HASH_TOLERANCE:
                errors.append(f"p{p}: photo in the new PDF page does not match the staged image")
            nums = page_numbers_in(b[idx])
            if p not in nums:
                elsewhere = [idx + 1 + d for d in (-2, -1, 1, 2) if 0 <= idx + d < len(b) and p in page_numbers_in(b[idx + d])]
                if elsewhere:
                    errors.append(f"p{p}: folio {p} is on pdf page {elsewhere[0]} of the new PDF, not {idx + 1}")
            old_chars, new_chars = len(a[idx].get_text().strip()), len(b[idx].get_text().strip())
            it["text_chars"] = [old_chars, new_chars]
            if new_chars == 0 and old_chars > 50:
                errors.append(f"p{p}: new text layer is empty (was {old_chars} chars)")
    finally:
        a.close()
        b.close()
    return errors


# ----------------------------------------------------------------------------- the job

class Job:
    """A retake or rollback of one or more pages of one book, driven stage by stage from its journal."""

    def __init__(self, store: Store, j: dict):
        self.store, self.book, self.j = store, store.book, j

    @property
    def id(self) -> str:
        return self.j["id"]

    @property
    def work(self) -> Path:
        return self.store.work(self.id)

    @property
    def tmp_pdf(self) -> Path:
        return self.book.pdf.with_name(self.book.pdf.name + f".{self.id}.tmp")

    def save(self) -> None:
        self.j["updated"] = now()
        write_json(self.store.journal(self.id), self.j)

    def run(self) -> None:
        stages = RETAKE_STAGES if self.j["kind"] == "retake" else ROLLBACK_STAGES
        try:
            for st in stages:
                if st in self.j["stages"]:
                    continue
                say(f"[{self.id}] {st}")
                emit("stage", stage=st, state="start")
                getattr(self, "do_" + st)()
                self.j["stages"][st] = now()
                self.save()
                emit("stage", stage=st, state="done")
        except BaseException as e:
            self.j["status"], self.j["error"] = "failed", f"{type(e).__name__}: {e}"
            self.save()
            emit("result", txn=self.id, kind=self.j["kind"], status="failed", stage=st, error=self.j["error"],
                 pdf_committed="commit_pdf" in self.j["stages"])
            say(f"\n[{self.id}] FAILED in stage {st}: {e}")
            if "commit_pdf" in self.j["stages"]:
                say(f"the book PDF was already replaced; finish with --resume {self.id} (rollback afterwards if needed)")
            else:
                say(f"nothing in the book was changed; --resume {self.id} retries, --abandon {self.id} drops it")
            raise SystemExit(1)
        self.j["status"] = "done"
        self.save()
        shutil.rmtree(self.work, ignore_errors=True)
        release_lock(self.store, self.id)
        self.report()
        self.emit_result()

    def emit_result(self) -> None:
        costs = self.extracted_ok() if self.j["kind"] == "retake" else {}
        emit("result", txn=self.id, kind=self.j["kind"], status="done", cost_usd=self.j.get("cost_usd") or 0.0,
             rolled_back_txn=self.j.get("rolled_back_txn"),
             pages=[{"printed": it["printed"], "before": it.get("before"), "after": it.get("after"),
                     "text_chars": it.get("text_chars"), "cost_usd": costs.get(it["printed"], 0.0)} for it in self.j["pages"]])

    # --- stages
    def do_stage(self) -> None:
        self.work.mkdir(parents=True, exist_ok=True)
        for it in self.j["pages"]:
            dst = self.work / it["staged"]
            if self.j["kind"] == "retake":
                data, _, _ = normalise(Path(it["source"]))
                if hashlib.sha256(data).hexdigest() != it["sha256"]:
                    raise RuntimeError(f"{it['source']} changed since it was validated")
                dst.write_bytes(data)
            else:
                copy_atomic(self.store.image_version(it["printed"], it["restore_version"]), dst)

    def do_build(self) -> None:
        with pymupdf.open(self.book.pdf) as doc:
            build_pages(self.book, doc, self.j["pages"], self.work)

    def do_splice(self) -> None:
        self.j["pdf"] = {"old_sha256": sha256_file(self.book.pdf)}
        if self.j["kind"] == "retake":
            sources = [(it["printed"], self.work / "pages.pdf", i) for i, it in enumerate(self.j["pages"])]
        else:
            sources = [(it["printed"], self.store.page_pdf_version(it["printed"], it["restore_version"]), 0)
                       for it in self.j["pages"]]
        say(f"  splicing {len(sources)} page(s) into {self.book.pdf.name}")
        splice(self.book, sources, self.tmp_pdf, self.work)
        errors = verify(self.book, self.book.pdf, self.tmp_pdf, self.j["pages"], self.work)
        if errors:
            self.tmp_pdf.unlink(missing_ok=True)
            raise RuntimeError("verification failed: " + "; ".join(errors))
        for it in self.j["pages"]:
            say(f"  p{it['printed']}: verified; text layer {it['text_chars'][0]} -> {it['text_chars'][1]} chars")
        self.j["pdf"]["new_sha256"] = sha256_file(self.tmp_pdf)

    def do_commit_pdf(self) -> None:
        pdf, meta = self.book.pdf, self.j["pdf"]
        current = sha256_file(pdf)
        if current != meta["new_sha256"]:
            if current != meta["old_sha256"]:
                raise RuntimeError(f"{pdf.name} changed since the splice; --abandon {self.id} and start again")
            if not self.tmp_pdf.exists() or sha256_file(self.tmp_pdf) != meta["new_sha256"]:
                raise RuntimeError("spliced temp file is missing; --abandon and start again")
            if "version" not in meta:
                meta["version"] = (self.store.pdf_versions()[-1][0] + 1) if self.store.pdf_versions() else 1
                self.save()
            vfile = self.store.pdf_version(meta["version"])
            if not vfile.exists() or sha256_file(vfile) != meta["old_sha256"]:
                say(f"  keeping the current PDF as _versions/{vfile.name}")
                copy_atomic(pdf, vfile)
            for it in self.j["pages"]:
                saved = self.work / f"old_p{it['printed']:04d}.pdf"
                dst = self.store.page_pdf_version(it["printed"], it["version"])
                if saved.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    saved.replace(dst)
                elif not dst.exists():
                    raise RuntimeError(f"saved page {saved.name} missing")
            os.replace(self.tmp_pdf, pdf)
            say(f"  {pdf.name} replaced ({meta['old_sha256'][:12]} -> {meta['new_sha256'][:12]})")
        for k, old in self.store.pdf_versions()[:-PDF_VERSIONS_KEPT]:
            old.unlink()
            append_jsonl(self.store.book_log, {"at": now(), "book": self.book.key, "event": "pdf_version_deleted",
                                               "file": old.name, "keep": PDF_VERSIONS_KEPT, "txn": self.id})
            say(f"  deleted old PDF version {old.name} (keeping the last {PDF_VERSIONS_KEPT})")
        append_jsonl(self.store.book_log, {"at": now(), "book": self.book.key, "event": "pdf_replaced", "txn": self.id,
                                           "kind": self.j["kind"], "pages": [it["printed"] for it in self.j["pages"]],
                                           "version_file": self.store.pdf_version(meta["version"]).name,
                                           "old_sha256": meta["old_sha256"], "new_sha256": meta["new_sha256"]})

    def do_commit_images(self) -> None:
        for it in self.j["pages"]:
            if it.get("image_done"):
                continue
            p, target = it["printed"], self.store.image(it["printed"])
            archive = self.store.image_version(p, it["version"])
            if not (target.exists() and sha256_file(target) == it["sha256"]):
                if target.exists():
                    if archive.exists():
                        raise RuntimeError(f"{archive.name} exists and {target.name} is neither old nor new")
                    archive.parent.mkdir(parents=True, exist_ok=True)
                    target.replace(archive)
                copy_atomic(self.work / it["staged"], target)
            elif not archive.exists():
                # the new photo is byte-identical to the current one (not a resume: that has the archive already);
                # keep the version anyway so every logged version can be restored
                copy_atomic(target, archive)
            rec = {"at": now(), "book": self.book.key, "page": p, "image_no": it["image_no"], "action": self.j["kind"],
                   "version": it["version"], "archived": archive.name, "sha256": it["sha256"],
                   "previous_sha256": it.get("previous_sha256"), "source": Path(it["source"]).name, "txn": self.id}
            if self.j["kind"] == "rollback":
                rec["restored"] = it["restore_version"]
            append_jsonl(self.store.image_log, rec)
            it["image_done"] = True
            self.save()
            say(f"  p{p}: {target.name} replaced, previous kept as _versions/{archive.name}")

    def do_history(self) -> None:
        for it in self.j["pages"]:
            p, cur = it["printed"], self.store.page_json(it["printed"])
            hist = self.store.json_version(p, it["version"])
            if cur.exists() and not hist.exists() and not it.get("json_archived"):
                copy_atomic(cur, hist)
            it["json_archived"] = True
            if self.j["kind"] == "rollback":
                restore = self.store.json_version(p, it["restore_version"])
                if restore.exists():
                    copy_atomic(restore, cur)
                    say(f"  p{p}: {cur.name} restored from _history/{restore.name}")
            self.save()

    def extracted_ok(self) -> dict[int, float]:
        """Pages extracted under this retake's run id -> cost."""
        done: dict[int, float] = {}
        for r in read_jsonl(self.store.out_dir / "_runlog.jsonl"):
            if r.get("run_id") == self.id and r.get("status") == "ok":
                done[r["page"]] = r.get("cost_usd") or 0.0
        return done

    def do_extract(self) -> None:
        todo = [it["printed"] for it in self.j["pages"] if it["printed"] not in self.extracted_ok()]
        if todo:
            left = self.j["estimate_usd"] / len(self.j["pages"]) * len(todo)
            spent = spent_today(exclude=self.id) + (self.j.get("cost_usd") or 0.0)
            if spent + left > budget():
                raise RuntimeError(f"daily budget: ${spent:.2f} spent today + ${left:.2f} > RETAKE_DAILY_BUDGET_USD={budget():g}")
            cmd = [sys.executable, str(ROOT / "scripts" / "extract.py"), "--book", self.book.key, "--force",
                   "--workers", str(min(EXTRACT_WORKERS, len(todo))), "--run-id", self.id, *map(str, todo)]
            subprocess.run(cmd)
        done = self.extracted_ok()
        self.j["cost_usd"] = round(sum(done.values()), 4)
        missing = [it["printed"] for it in self.j["pages"] if it["printed"] not in done]
        if missing:
            raise RuntimeError(f"extraction failed for pages {missing} (see out/{self.book.key}/_failed/)")

    def do_ingest(self) -> None:
        pages = ",".join(str(it["printed"]) for it in self.j["pages"])
        cmd = ["node", str(ROOT / "packages" / "indexer" / "dist" / "cli.js"), "ingest", "--book", self.book.key, "--pages", pages]
        r = subprocess.run(cmd, cwd=ROOT)
        if r.returncode != 0:
            raise RuntimeError(f"indexer ingest exited {r.returncode}")

    def do_qa(self) -> None:
        # a stale report is not worth failing a finished retake for: warn and carry on
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "qa_report.py"), "--book", self.book.key],
                           cwd=ROOT, capture_output=True, text=True)
        wrote = [line for line in r.stdout.splitlines() if line.startswith("wrote ")]
        say("  " + (wrote[-1] if wrote else "QA report updated") if r.returncode == 0
            else f"  warning: qa_report.py exited {r.returncode}: {(r.stderr or r.stdout).strip()[-300:]}")

    def do_thumbs(self) -> None:
        root = Path(os.environ.get("THUMB_CACHE_DIR") or Path(tempfile.gettempdir()) / "miriel-thumbs")
        # the api keys thumbnails by photo version (pN.<version>.jpg; pN.jpg before migration 0005)
        dropped = 0
        for it in self.j["pages"]:
            folder = root / self.book.key
            for f in [folder / f"p{it['printed']}.jpg", *folder.glob(f"p{it['printed']}.*.jpg")] if folder.exists() else []:
                if f.exists():
                    f.unlink()
                    dropped += 1
        say(f"  {dropped} cached thumbnail(s) dropped from {root}")

    # --- report
    def report(self) -> None:
        say(f"\n{self.j['kind']} {self.id} done ({self.book.key})")
        say(f"{'page':>5}  {'quality':<17} {'retake':<11} {'ocr':<13} {'entities':<10} {'md chars':<13} text layer")
        still = []
        for it in self.j["pages"]:
            before, after = it.get("before") or {}, summary(self.store.page_json(it["printed"])) or {}
            it["after"] = after

            def ba(key: str) -> str:
                return f"{before.get(key, '-')}->{after.get(key, '-')}"
            if after.get("retake_recommended"):
                still.append(it["printed"])
            tc = it.get("text_chars") or ["-", "-"]
            say(f"{it['printed']:>5}  {ba('image_quality'):<17} {ba('retake_recommended'):<11} {ba('ocr_agreement'):<13} "
                f"{ba('entities'):<10} {ba('markdown_chars'):<13} {tc[0]}->{tc[1]}")
        self.save()
        if self.j["kind"] == "retake":
            say(f"cost: ${self.j.get('cost_usd') or 0:.3f} (estimate was ${self.j['estimate_usd']:.2f}); "
                f"today's retake spend ${spent_today():.2f} of ${budget():g}")
        if still:
            say(f"still flagged retake_recommended (stay in the retake queue): {still}")


# ----------------------------------------------------------------------------- planning

def new_txn_id() -> str:
    return "rt-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]


def refuse_if_unfinished(store: Store) -> None:
    open_jobs = [j["id"] for j in store.journals() if j["status"] in ("running", "failed")]
    if open_jobs:
        sys.exit(f"unfinished retake(s) for {store.book.key}: {open_jobs}; --resume <id> or --abandon <id> first")


def plan_retake(book: Book, uploads: list[tuple[Path, int | None, str, bool]]) -> list[dict]:
    """uploads: (photo, printed page or None, how the page was given, skip the folio check)."""
    items = []
    with pymupdf.open(book.pdf) as doc:
        for src, printed, how, skip_folio in uploads:
            say(f"  checking {src.name} ...")
            it = validate_photo(book, doc, src, printed, how, skip_folio)
            n = image_number_from_name(book, src.name)
            if how == "--page" and n is not None and it.get("image_no") and n != it["image_no"]:
                it["warnings"].append(f"file name says image {n} (printed {n - book.offset}), --page says {it['printed']}")
            items.append(it)
    seen: dict[int, str] = {}
    for it in items:
        p = it.get("printed")
        if p is not None and not it["errors"]:
            if p in seen:
                it["errors"].append(f"printed page {p} is also given by {seen[p]}")
            seen.setdefault(p, Path(it["source"]).name)
    return items


def show_plan(book: Book, items: list[dict]) -> None:
    say(f"\n{'file':<44} {'page':>5} {'img':>5}  {'match':<8} folio / notes")
    for it in items:
        name = Path(it["source"]).name
        say(f"{name[:44]:<44} {it.get('printed') if it.get('printed') is not None else '-':>5} {it.get('image_no', '-'):>5}  "
            f"{it['match']:<8} {it.get('folio', '')}")
        for e in it["errors"]:
            say(f"{'':<44}   ERROR   {e}")
        for w in it["warnings"]:
            say(f"{'':<44}   warning {w}")
        if it.get("before"):
            b = it["before"]
            say(f"{'':<44}   now: {b['image_quality']}, retake={b['retake_recommended']}, issues={','.join(b['quality_issues']) or '-'}")


def confirm(prompt: str, yes: bool) -> None:
    if yes:
        return
    if not sys.stdin.isatty():
        sys.exit("not a terminal: pass --yes to confirm")
    if input(prompt + " [y/N] ").strip().lower() not in ("y", "yes"):
        sys.exit("cancelled; nothing was written")


def start(store: Store, kind: str, items: list[dict], estimate: float, yes: bool, dry_run: bool,
          txn_id: str | None = None, extra: dict | None = None) -> None:
    book = store.book
    txn = txn_id or new_txn_id()
    for it in items:
        it["staged"] = f"p{it['printed']:04d}.jpg"
        it["version"] = store.next_page_version(it["printed"])
        cur = store.image(it["printed"])
        it["previous_sha256"] = sha256_file(cur) if cur.exists() else None
        it.pop("_bytes", None)
    if dry_run:
        dry(store, items)
        return
    confirm(f"{kind} {len(items)} page(s) of {book.key}" + (f"; re-extraction estimate ${estimate:.2f}" if estimate else "") + ".", yes)
    refuse_if_unfinished(store)
    acquire_lock(store, txn)
    j = {"id": txn, "book": book.key, "kind": kind, "created": now(), "status": "running", "stages": {},
         "estimate_usd": estimate, "cost_usd": 0.0, "pages": items, **(extra or {})}
    job = Job(store, j)
    job.save()
    say(f"retake id {txn} (journal {store.journal(txn).relative_to(data_dir())})")
    job.run()


def dry(store: Store, items: list[dict]) -> None:
    """Build, splice and verify in a temp dir; nothing under DATA_DIR or out/ is written."""
    book = store.book
    with tempfile.TemporaryDirectory(prefix="retake-dry-") as d:
        work = Path(d)
        for it in items:
            data, _, _ = normalise(Path(it["source"]))
            (work / it["staged"]).write_bytes(data)
        with pymupdf.open(book.pdf) as doc:
            pages_pdf = build_pages(book, doc, items, work)
        tmp = work / "book.pdf"
        say("  splicing into a temp copy")
        splice(book, [(it["printed"], pages_pdf, i) for i, it in enumerate(items)], tmp, work)
        errors = verify(book, book.pdf, tmp, items, work)
        for it in items:
            say(f"  p{it['printed']}: text layer {it['text_chars'][0]} -> {it['text_chars'][1]} chars")
    if errors:
        sys.exit("dry run: verification FAILED: " + "; ".join(errors))
    say("dry run: build, splice and verification ok; nothing written")


# ----------------------------------------------------------------------------- commands

def upload_for(book: Book, src: Path, printed: int | None, skip_folio: bool) -> tuple[Path, int | None, str, bool]:
    """Page from the caller, else from the file name, else (at validation) from the folio."""
    if printed is not None:
        return src, printed, "--page", skip_folio
    n = image_number_from_name(book, src.name)
    return src, None if n is None else n - book.offset, "filename" if n is not None else "folio", skip_folio


def cmd_retake(store: Store, args: argparse.Namespace) -> None:
    book = store.book
    if args.items:
        spec = json.loads(Path(args.items).read_text(encoding="utf-8"))
        uploads = [upload_for(book, Path(x["image"]), x.get("page"), bool(x.get("skip_folio")) or args.skip_folio_check) for x in spec]
        missing = [str(u[0]) for u in uploads if not u[0].is_file()]
        if missing:
            sys.exit(f"--items: photos not found: {missing}")
    elif args.dir:
        folder = resolve_input(args.dir)
        if not folder.is_dir():
            sys.exit(f"--dir: {folder} is not a directory")
        files = sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES and not p.name.startswith(".")),
                       key=lambda p: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)])
        if not files:
            sys.exit(f"no JPEG/PNG files in {folder}")
        uploads = [upload_for(book, f, None, args.skip_folio_check) for f in files]
    else:
        src = resolve_input(args.image)
        if not src.is_file():
            sys.exit(f"--image: {src} not found" + (" (paths are inside the container; put photos in RETAKE_INBOX)" if os.environ.get("RETAKE_INBOX") else ""))
        uploads = [upload_for(book, src, args.page, args.skip_folio_check)]

    say(f"validating {len(uploads)} photo(s) for {book.key}")
    items = plan_retake(book, uploads)
    for it in items:
        if not it["errors"]:
            it["before"] = summary(store.page_json(it["printed"]))
    show_plan(book, items)
    if args.validate_only:
        per_page = page_estimate_usd(store)
        emit("plan", per_page_usd=per_page, items=[{k: v for k, v in it.items() if not k.startswith("_")} for it in items])
        say(f"\nvalidation only; nothing written (re-extraction ~${per_page:.2f} per page)")
        return
    bad = [it for it in items if it["errors"]]
    if bad:
        if not args.skip_bad or len(bad) == len(items):
            hint = " (--skip-bad processes the rest)" if args.dir and not args.skip_bad else ""
            sys.exit(f"\n{len(bad)} photo(s) rejected; nothing was written{hint}")
        say(f"\nskipping {len(bad)} rejected photo(s)")
        items = [it for it in items if not it["errors"]]
    items.sort(key=lambda it: it["printed"])

    per_page = page_estimate_usd(store)
    estimate = round(per_page * len(items), 2)
    spent = spent_today()
    say(f"\nre-extraction: {len(items)} page(s) x ~${per_page:.2f} = ~${estimate:.2f}; "
        f"spent on retakes today ${spent:.2f} of RETAKE_DAILY_BUDGET_USD=${budget():g}")
    if not args.dry_run and spent + estimate > budget():
        sys.exit("over the daily budget; raise RETAKE_DAILY_BUDGET_USD or wait until tomorrow")
    if any(it["warnings"] for it in items):
        say("warnings above need your OK")
    start(store, "retake", items, estimate, args.yes, args.dry_run, args.txn_id)


def rollback_target(store: Store, printed: int) -> dict:
    """The latest retake of the page that no later rollback has undone."""
    entries = [e for e in read_jsonl(store.image_log) if e.get("book") == store.book.key and e.get("page") == printed]
    undone = {e["restored"] for e in entries if e["action"] == "rollback"}
    live = [e for e in entries if e["action"] == "retake" and e["version"] not in undone]
    if not live:
        sys.exit(f"printed page {printed} of {store.book.key} has no retake to roll back")
    return live[-1]


def cmd_rollback(store: Store, args: argparse.Namespace) -> None:
    p = args.page
    target = rollback_target(store, p)
    v = target["version"]
    image, page_pdf, js = store.image_version(p, v), store.page_pdf_version(p, v), store.json_version(p, v)
    missing = [x.name for x in (image, page_pdf) if not x.exists()]
    if missing:
        sys.exit(f"cannot roll back: version files missing: {missing}")
    cur = store.image(p)
    if cur.exists() and sha256_file(cur) != target["sha256"]:
        say(f"warning: the current photo is not the one retake {target['txn']} installed")
    it = {"source": str(image), "printed": p, "image_no": target["image_no"], "match": "rollback", "errors": [],
          "warnings": [] if js.exists() else [f"no {js.name}: the page JSON stays as it is"], "notes": [],
          "restore_version": v, "sha256": sha256_file(image), "folio": f"restores v{v} (before retake {target['txn']})",
          "before": summary(store.page_json(p))}
    show_plan(store.book, [it])
    start(store, "rollback", [it], 0.0, args.yes, False, args.txn_id, {"rolled_back_txn": target["txn"]})


def cmd_resume(store: Store, txn_id: str) -> None:
    path = store.journal(txn_id)
    if not path.exists():
        sys.exit(f"no retake {txn_id} for {store.book.key}")
    j = json.loads(path.read_text(encoding="utf-8"))
    if j["status"] == "done":
        if _emit:  # the worker lost track of a finished job (killed after the last stage): report it again
            Job(store, j).emit_result()
            return
        sys.exit(f"{txn_id} is already done")
    if j["status"] == "abandoned":
        sys.exit(f"{txn_id} was abandoned")
    acquire_lock(store, txn_id)
    j["status"], j["error"] = "running", None
    say(f"resuming {txn_id}; completed stages: {', '.join(j['stages']) or 'none'}")
    Job(store, j).run()


def cmd_abandon(store: Store, txn_id: str) -> None:
    path = store.journal(txn_id)
    if not path.exists():
        sys.exit(f"no retake {txn_id} for {store.book.key}")
    j = json.loads(path.read_text(encoding="utf-8"))
    if "commit_pdf" in j["stages"]:
        sys.exit(f"{txn_id} already replaced the PDF; finish it with --resume {txn_id} and roll back afterwards")
    job = Job(store, j)
    job.tmp_pdf.unlink(missing_ok=True)
    shutil.rmtree(job.work, ignore_errors=True)
    j["status"] = "abandoned"
    job.save()
    release_lock(store, txn_id)
    say(f"{txn_id} abandoned; the book was not changed")


def cmd_history(store: Store, page: int | None) -> None:
    rows = [e for e in read_jsonl(store.image_log) if e.get("book") == store.book.key and (page is None or e.get("page") == page)]
    if not rows:
        say("no retakes recorded" + (f" for printed page {page}" if page is not None else ""))
    for e in rows:
        extra = f" (restored v{e['restored']})" if e["action"] == "rollback" else ""
        say(f"{e['at']}  p{e['page']:<4} {e['action']:<8}{extra:<15} previous kept as v{e['version']}  "
            f"source={e['source']}  sha={e['sha256'][:12]}  txn={e['txn']}")
    for j in store.journals():
        if j["status"] != "done":
            say(f"journal {j['id']}: {j['kind']} {j['status']} pages={[it['printed'] for it in j['pages']]} "
                f"stages={list(j['stages'])} {j.get('error') or ''}")
    versions = store.pdf_versions()
    if versions:
        say("PDF versions kept: " + ", ".join(p.name for _, p in versions))


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--page", type=int, help="printed page (with --image or --rollback; --history filter)")
    what = ap.add_mutually_exclusive_group(required=True)
    what.add_argument("--image", help="new photo for --page (JPEG or PNG)")
    what.add_argument("--items", metavar="FILE", help="JSON list of {image, page?, skip_folio?}: one retake of several photos (the worker's batch)")
    what.add_argument("--dir", help="folder of photos; page from the file name (imagePattern or page_NNN = image number) or the folio")
    what.add_argument("--rollback", action="store_true", help="undo the latest retake of --page")
    what.add_argument("--resume", metavar="ID", help="continue an interrupted retake")
    what.add_argument("--abandon", metavar="ID", help="drop an unfinished retake that has not replaced the PDF")
    what.add_argument("--history", action="store_true", help="list recorded retakes and rollbacks")
    ap.add_argument("--yes", action="store_true", help="confirm without asking (warnings included)")
    ap.add_argument("--dry-run", action="store_true", help="validate, build, splice into a temp copy and verify; write nothing")
    ap.add_argument("--skip-folio-check", action="store_true", help="do not OCR the photo's folio (e.g. tesseract misreads it)")
    ap.add_argument("--skip-bad", action="store_true", help="with --dir: process the valid photos when some are rejected")
    ap.add_argument("--validate-only", action="store_true", help="check the photo(s) and print the plan; write nothing")
    ap.add_argument("--txn-id", help="use this retake id (the worker assigns it before the run, so a crash can resume)")
    ap.add_argument("--json", action="store_true", help=f"also print machine-readable events ({EMIT_PREFIX.strip()} {{...}} lines)")
    args = ap.parse_args()
    global _emit
    _emit = args.json
    if args.txn_id and not re.fullmatch(r"rt-[A-Za-z0-9-]{4,60}", args.txn_id):
        ap.error("--txn-id must look like rt-<letters, digits, dashes>")

    store = Store(BOOKS[args.book])
    if args.history:
        cmd_history(store, args.page)
        return
    require_tools()
    if not store.book.pdf.exists():
        sys.exit(f"missing {store.book.pdf} (is DATA_DIR right?)")
    if args.rollback and args.page is None:
        ap.error("--page is required with --rollback")
    if args.resume:
        cmd_resume(store, args.resume)
    elif args.abandon:
        cmd_abandon(store, args.abandon)
    elif args.rollback:
        cmd_rollback(store, args)
    else:
        cmd_retake(store, args)


if __name__ == "__main__":
    main()
