"""Verify a book's printedToPdfOffset against the PDF text layer.

For each sampled PRINTED page p, open PDF page p + offset (1-based), pull the bare page numbers out of its
text layer and compare them with p. Also print the image file the mapping would use so the operator can
open it and check the printed number by eye. Exit non-zero when any sampled page contradicts the offset,
or when no sampled page could be confirmed at all (e.g. only image-only map pages were sampled).

Usage:
  uv run python scripts/check_offset.py --book vol2                       # default sample: 8 spread pages + the last 3
  uv run python scripts/check_offset.py --book vol2 --pages 11,200,250,500,520
  uv run python scripts/check_offset.py --book vol2 --pages 11,200 --record   # on success, write offsetVerified into config/books.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, CONFIG_PATH, Book  # noqa: E402

_INT = re.compile(r"(?<![\d.,])(\d{1,4})(?![\d.,%])")
FOOTER_BAND = 0.08   # fraction of the page height from the bottom edge
HEADER_BAND = 0.06   # fraction from the top edge, used only when the footer holds no number


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


def check(book: Book, pages: list[int]) -> tuple[list[int], list[int], list[int]]:
    """Returns (confirmed, mismatched, inconclusive) printed pages."""
    doc = pymupdf.open(book.pdf)
    if len(doc) != book.page_count:
        print(f"WARNING: config pageCount={book.page_count} but the PDF has {len(doc)} pages", file=sys.stderr)
    confirmed, mismatched, inconclusive = [], [], []
    print(f"book={book.key}  offset={book.offset}  pdf={book.pdf.name} ({len(doc)} pages)  images={book.image_dir.name}/")
    print(f"{'printed':>7} {'pdf_page':>8} {'text-layer numbers':<24} {'verdict':<12} image")
    for p in pages:
        try:
            idx = book.pdf_index(p)
        except ValueError as e:
            print(f"{p:>7} {'-':>8} {'':<24} {'OUT OF RANGE':<12} {e}")
            mismatched.append(p)
            continue
        nums = page_numbers_in(doc[idx])
        img = book.image_path(p)
        img_note = img.name + ("" if img.exists() else "  (MISSING)")
        if p in nums:
            verdict, bucket = "ok", confirmed
        else:
            # The footer may hold other numbers (chapter, volume, index entries), so only finding the expected
            # folio on a NEIGHBOURING pdf page proves the offset wrong; otherwise the page is inconclusive.
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
          f"missing={missing[:10] if missing else 'none'}; surplus (beyond the PDF, ignored)={surplus if surplus else 'none'}")


def record(book: Book, confirmed: list[int]) -> None:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    raw[book.key]["offsetVerified"] = f"{dt.date.today().isoformat()}, pages {','.join(map(str, confirmed))}"
    CONFIG_PATH.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
    print(f"recorded offsetVerified for {book.key} in {CONFIG_PATH.relative_to(CONFIG_PATH.parent.parent)}")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--pages", help="printed pages to sample, comma-separated (default: 8 spread + last 3)")
    ap.add_argument("--record", action="store_true", help="on success, write offsetVerified into config/books.json")
    args = ap.parse_args()
    book = BOOKS[args.book]
    for p in (book.pdf, book.image_dir):
        if not p.exists():
            sys.exit(f"missing source: {p} (is DATA_DIR right?)")
    pages = parse_pages(args.pages) if args.pages else default_sample(book)

    confirmed, mismatched, inconclusive = check(book, pages)
    image_inventory(book)
    print(f"\n{len(confirmed)} confirmed, {len(mismatched)} mismatched, {len(inconclusive)} inconclusive (folio not in the footer/header text layer)")
    if mismatched:
        sys.exit(f"offset {book.offset} is WRONG for {book.key}: printed pages {mismatched} disagree")
    if not confirmed:
        sys.exit("no sampled page could be confirmed; sample pages whose footer page number is in the text layer")
    print(f"offset {book.offset} holds for {book.key} on pages {confirmed}")
    if args.record:
        record(book, confirmed)


if __name__ == "__main__":
    main()
