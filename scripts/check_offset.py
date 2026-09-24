"""Verify a book's printed-page -> PDF page -> image-file mapping.

Two independent checks, both against config/books.json:

1. **Folio check.** For each sampled PRINTED page p, open PDF page p + printedToPdfOffset (1-based), pull the
   page numbers out of the footer/header of its text layer and compare them with p. Only finding the expected
   folio on a NEIGHBOURING pdf page counts as a contradiction (footers also hold chapter numbers etc.).
2. **Image check.** For each sampled page, compare the photo embedded in the PDF page with the image file the
   pattern resolves to (dimensions + a small perceptual hash). The PDF is the curated sequence; a stray
   duplicate or page-turn photo in the image folder shifts every later file and would pair the wrong image
   with a page's OCR text. `--images all` checks every page (about a minute per book).

Exit non-zero when any sampled page contradicts the offset, when no folio could be confirmed, or when any
image disagrees with its PDF page. The image check prints which neighbouring file does match, so the fix
(move the stray file(s) to `_extra/` and renumber) is obvious.

Usage:
  uv run python scripts/check_offset.py --book vol2                       # default sample: 8 spread pages + the last 3
  uv run python scripts/check_offset.py --book vol2 --pages 11,200,250,500,520
  uv run python scripts/check_offset.py --book vol2 --images all           # every page's image vs the PDF
  uv run python scripts/check_offset.py --book vol2 --pages 11,200 --record   # on success, write offsetVerified into config/books.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import re
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, CONFIG_PATH, Book  # noqa: E402

_INT = re.compile(r"(?<![\d.,])(\d{1,4})(?![\d.,%])")
FOOTER_BAND = 0.08   # fraction of the page height from the bottom edge
HEADER_BAND = 0.06   # fraction from the top edge, used only when the footer holds no number
HASH_TOLERANCE = 6   # of 64 bits


def page_numbers_in(page: pymupdf.Page) -> list[int]:
    """Page-number candidates: integers in text blocks that sit in the footer band (else the header band).

    Folios in these guides are printed in the footer next to the running title ("CHAPTER 2 · WORLD GUIDE 159"),
    so body text, tables and map markers are excluded by position rather than by pattern."""
    h = page.rect.height
    blocks = page.get_text("blocks")
    footer = [b[4] for b in blocks if b[1] >= h * (1 - FOOTER_BAND)]
    header = [b[4] for b in blocks if b[3] <= h * HEADER_BAND]
    found: list[int] = []
    for band in (footer, header):
        for txt in band:
            found.extend(int(m.group(1)) for m in _INT.finditer(txt))
        if found:
            break
    seen: set[int] = set()
    return [n for n in found if not (n in seen or seen.add(n))]


def default_sample(book: Book) -> list[int]:
    first, last = max(book.first_printed, 1), book.last_printed
    spread = {round(first + (last - first) * k / 9) for k in range(1, 9)}
    tail = {last - 2, last - 1, last}
    return sorted(p for p in spread | tail if first <= p <= last)


def parse_pages(spec: str) -> list[int]:
    return sorted({int(x) for x in spec.split(",") if x.strip()})


# ----------------------------------------------------------------------------- folio check

def check_folios(book: Book, doc: pymupdf.Document, pages: list[int]) -> tuple[list[int], list[int], list[int]]:
    """Returns (confirmed, mismatched, inconclusive) printed pages."""
    confirmed, mismatched, inconclusive = [], [], []
    print(f"book={book.key}  offset={book.offset}  pdf={book.pdf.name} ({len(doc)} pages)  images={book.image_dir.name}/")
    print(f"{'printed':>7} {'pdf_page':>8} {'text-layer numbers':<24} {'verdict':<15} image")
    for p in pages:
        try:
            idx = book.pdf_index(p)
        except ValueError as e:
            print(f"{p:>7} {'-':>8} {'':<24} {'OUT OF RANGE':<15} {e}")
            mismatched.append(p)
            continue
        nums = page_numbers_in(doc[idx])
        img = book.image_path(p)
        img_note = img.name + ("" if img.exists() else "  (MISSING)")
        if p in nums:
            verdict, bucket = "ok", confirmed
        else:
            elsewhere = [d for d in (-2, -1, 1, 2) if 0 <= idx + d < len(doc) and p in page_numbers_in(doc[idx + d])]
            if elsewhere:
                d = elsewhere[0]
                verdict, bucket = f"MISMATCH (folio {p} is on pdf page {idx + 1 + d}: offset should be {book.offset + d})", mismatched
            else:
                verdict, bucket = ("no folio" if not nums else "folio not found"), inconclusive
        bucket.append(p)
        shown = ",".join(map(str, nums[:6])) + ("…" if len(nums) > 6 else "") if nums else "-"
        print(f"{p:>7} {idx + 1:>8} {shown:<24} {verdict:<15} {img_note}")
    return confirmed, mismatched, inconclusive


# ----------------------------------------------------------------------------- image check

def signature(im: Image.Image) -> str:
    g = ImageOps.grayscale(im)
    g.thumbnail((64, 64))
    g = g.resize((8, 8))
    px = list(g.get_flattened_data()) if hasattr(g, "get_flattened_data") else list(g.getdata())  # Pillow 12 vs older
    mean = sum(px) / len(px)
    return "".join("1" if v > mean else "0" for v in px)


def distance(a: str, b: str) -> int:
    return sum(x != y for x, y in zip(a, b))


def pdf_photo(doc: pymupdf.Document, idx: int) -> tuple[tuple[int, int], str] | None:
    imgs = doc[idx].get_images()
    if not imgs:
        return None
    info = doc.extract_image(imgs[0][0])
    im = Image.open(io.BytesIO(info["image"]))
    im.draft("L", (160, 160))
    return (info["width"], info["height"]), signature(im)


def file_photo(path: Path) -> tuple[tuple[int, int], str] | None:
    if not path.exists():
        return None
    im = Image.open(path)
    size = im.size
    im.draft("L", (160, 160))
    return size, signature(im)


def check_images(book: Book, doc: pymupdf.Document, pdf_pages: list[int]) -> list[int]:
    """Compare the PDF's embedded photo with the image file for each 1-based pdf page. Returns mismatching pdf pages."""
    bad: list[int] = []
    cache: dict[int, tuple[tuple[int, int], str] | None] = {}

    def file_sig(n: int) -> tuple[tuple[int, int], str] | None:
        if n not in cache:
            cache[n] = file_photo(book.image_dir / book.image_pattern.replace("{n}", str(n)))
        return cache[n]

    for n in pdf_pages:
        pdf = pdf_photo(doc, n - 1)
        if pdf is None:
            continue
        f = file_sig(n)
        ok = f is not None and f[0] == pdf[0] and distance(f[1], pdf[1]) <= HASH_TOLERANCE
        if ok:
            continue
        bad.append(n)
        # which neighbouring file does match?
        hint = "no matching file within ±4"
        for d in (1, -1, 2, -2, 3, -3, 4, -4):
            g = file_sig(n + d)
            if g and g[0] == pdf[0] and distance(g[1], pdf[1]) <= HASH_TOLERANCE:
                hint = f"pdf page {n} matches image file {n + d} (shift {d:+})"
                break
        why = "missing" if f is None else (f"size {f[0][0]}x{f[0][1]} vs pdf {pdf[0][0]}x{pdf[0][1]}" if f[0] != pdf[0] else f"hash distance {distance(f[1], pdf[1])}")
        print(f"  IMAGE MISMATCH pdf page {n} (printed {book.printed_from_index(n - 1)}): file {n} {why}; {hint}")
    return bad


def image_inventory(book: Book) -> None:
    pat = re.escape(book.image_pattern).replace(r"\{n\}", r"(\d+)")
    rx = re.compile("^" + pat + "$")
    numbers = sorted(int(m.group(1)) for f in book.image_dir.iterdir() if (m := rx.match(f.name)))
    if not numbers:
        print(f"WARNING: no files in {book.image_dir} match imagePattern {book.image_pattern!r}", file=sys.stderr)
        return
    missing = sorted(set(range(1, book.page_count + 1)) - set(numbers))
    surplus = [n for n in numbers if n > book.page_count]
    print(f"\nimages: {len(numbers)} files numbered {numbers[0]}..{numbers[-1]}; pageCount={book.page_count}; "
          f"missing={missing[:10] if missing else 'none'}; surplus (beyond the PDF)={surplus if surplus else 'none'}")
    if len(numbers) != book.page_count:
        print("  WARNING: image count differs from the PDF page count; run with --images all to find where they diverge")


def record(book: Book, confirmed: list[int], images_checked: str) -> None:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    raw[book.key]["offsetVerified"] = f"{dt.date.today().isoformat()}, pages {','.join(map(str, confirmed))}; images {images_checked}"
    CONFIG_PATH.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    print(f"recorded offsetVerified for {book.key} in {CONFIG_PATH.relative_to(CONFIG_PATH.parent.parent)}")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--pages", help="printed pages to sample, comma-separated (default: 8 spread + last 3)")
    ap.add_argument("--images", default="sample", choices=["sample", "all", "none"],
                    help="image-vs-PDF check on the sampled pages (default), on every page, or skipped")
    ap.add_argument("--record", action="store_true", help="on success, write offsetVerified into config/books.json")
    args = ap.parse_args()
    book = BOOKS[args.book]
    for p in (book.pdf, book.image_dir):
        if not p.exists():
            sys.exit(f"missing source: {p} (is DATA_DIR right?)")
    doc = pymupdf.open(book.pdf)
    if len(doc) != book.page_count:
        print(f"WARNING: config pageCount={book.page_count} but the PDF has {len(doc)} pages", file=sys.stderr)
    pages = parse_pages(args.pages) if args.pages else default_sample(book)

    confirmed, mismatched, inconclusive = check_folios(book, doc, pages)
    image_inventory(book)

    bad_images: list[int] = []
    if args.images != "none":
        pdf_pages = list(range(1, len(doc) + 1)) if args.images == "all" else sorted({p + book.offset for p in pages if 1 <= p + book.offset <= len(doc)})
        print(f"\nimage check on {len(pdf_pages)} pdf page(s):")
        bad_images = check_images(book, doc, pdf_pages)
        if not bad_images:
            print("  every checked image file matches the photo embedded in its PDF page")

    print(f"\n{len(confirmed)} confirmed, {len(mismatched)} mismatched, {len(inconclusive)} inconclusive (folio not in the footer/header text layer)")
    if mismatched:
        sys.exit(f"offset {book.offset} is WRONG for {book.key}: printed pages {mismatched} disagree")
    if not confirmed:
        sys.exit("no sampled page could be confirmed; sample pages whose footer page number is in the text layer")
    if bad_images:
        sys.exit(f"{len(bad_images)} image file(s) do not match their PDF page: pdf pages {bad_images[:12]}{'…' if len(bad_images) > 12 else ''}")
    print(f"offset {book.offset} holds for {book.key} on pages {confirmed}")
    if args.record:
        record(book, confirmed, "all" if args.images == "all" else ("sample" if args.images == "sample" else "unchecked"))


if __name__ == "__main__":
    main()
