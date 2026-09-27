"""Check an art book's structure and folio rule before labelling (the art-book counterpart of check_offset.py).

  uv run python scripts/art_check.py --book art1                      # structure + footer contact sheet
  uv run python scripts/art_check.py --book art1 --every 5 --out <dir>
  uv run python scripts/art_check.py --book art1 --record "pages 2,60,120,180,215-220"

Structure (automatic): page count matches the config, one full-page JPEG per page, the exported spread files
(scripts/art_export.py) exist and match the PDF, every page after the cover has the spread size.

Folios (by eye): the PDFs have no text layer, so the script writes footer contact sheets (every Nth spread and
the last 5) with the folios the config predicts printed next to the page corners. Confirm them, then --record
writes `folioVerified` into config/books.json. Chapter openers and full-bleed art carry no folio; skip those.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from art_export import ExportError, page_jpeg  # noqa: E402
from pages import ARTBOOKS, CONFIG_PATH, ROOT, ArtBook  # noqa: E402

FOOTER = (0.945, 0.99)      # vertical band of the folio line, as fractions of the spread height
CORNER = 0.24               # width of each corner crop, as a fraction of the spread width
ROWS_PER_SHEET = 12


def check_structure(book: ArtBook) -> list[str]:
    problems: list[str] = []
    doc = pymupdf.open(book.pdf)
    if doc.page_count != book.page_count:
        problems.append(f"PDF has {doc.page_count} pages, config pageCount is {book.page_count}")
    sizes = collections.Counter()
    for i in range(doc.page_count):
        r = doc[i].rect
        sizes[(round(r.width), round(r.height))] += 1
        try:
            data = page_jpeg(doc, i)
        except ExportError as e:
            problems.append(str(e))
            continue
        f = book.image_path(i + 1)
        if not f.exists():
            problems.append(f"missing spread file {f.name} (run scripts/art_export.py --book {book.key})")
        elif f.read_bytes() != data:
            problems.append(f"{f.name} differs from PDF page {i + 1} (re-run scripts/art_export.py)")
    spread_sizes = collections.Counter({s: n for s, n in sizes.items()})
    main_size, _ = spread_sizes.most_common(1)[0]
    odd = [i + 1 for i in range(book.spread_pdf_page - 1, doc.page_count)
           if (round(doc[i].rect.width), round(doc[i].rect.height)) != main_size]
    if odd:
        problems.append(f"pages with a size other than {main_size[0]}x{main_size[1]} after the first spread: {odd[:20]}")
    print(f"{book.key}: {doc.page_count} pages, sizes {dict(sizes)}")
    return problems


def footer_sheets(book: ArtBook, pages: list[int], out_dir: Path) -> list[Path]:
    font = ImageFont.load_default(size=26)
    rows: list[Image.Image] = []
    for p in pages:
        with Image.open(book.image_path(p)) as im:
            w, h = im.size
            band = (int(h * FOOTER[0]), int(h * FOOTER[1]))
            cw = int(w * CORNER)
            left = im.crop((0, band[0], cw, band[1]))
            right = im.crop((w - cw, band[0], w, band[1]))
        folios = book.folios(p)
        label = f"pdf {p}: expect {folios[0]} | {folios[1]}" if folios else f"pdf {p}: no folio (cover)"
        row = Image.new("RGB", (left.width + right.width + 420, left.height + 8), "white")
        row.paste(left, (0, 4))
        row.paste(right, (left.width + 20, 4))
        ImageDraw.Draw(row).text((left.width + right.width + 40, row.height // 2 - 14), label, fill="red", font=font)
        rows.append(row)
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets: list[Path] = []
    for k in range(0, len(rows), ROWS_PER_SHEET):
        chunk = rows[k:k + ROWS_PER_SHEET]
        sheet = Image.new("RGB", (max(r.width for r in chunk), sum(r.height for r in chunk)), "white")
        y = 0
        for r in chunk:
            sheet.paste(r, (0, y))
            y += r.height
        path = out_dir / f"{book.key}_folios_{k // ROWS_PER_SHEET + 1}.jpg"
        sheet.save(path, quality=85)
        sheets.append(path)
    return sheets


def record(book: ArtBook, note: str) -> None:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    raw[book.key]["folioVerified"] = f"{dt.date.today().isoformat()}, {note}"
    CONFIG_PATH.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"recorded folioVerified for {book.key} in {CONFIG_PATH.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(ARTBOOKS))
    ap.add_argument("--every", type=int, default=10, help="sample every Nth spread for the contact sheet (default 10)")
    ap.add_argument("--out", type=Path, default=ROOT / "test-pages" / "art-check", help="folder for the contact sheets")
    ap.add_argument("--record", metavar="NOTE", help="write folioVerified = '<today>, NOTE' after checking the sheets by eye")
    args = ap.parse_args()
    book = ARTBOOKS[args.book]

    problems = check_structure(book)
    for msg in problems:
        print(f"  PROBLEM: {msg}")
    if problems:
        sys.exit(1)
    if args.record:
        record(book, args.record)
        return
    first = book.spread_pdf_page
    sample = sorted(set(range(first, book.page_count + 1, args.every)) | set(range(book.page_count - 4, book.page_count + 1)))
    for s in footer_sheets(book, sample, args.out):
        print(f"  contact sheet: {s}")
    print("structure ok; check the folios on the sheets, then run with --record \"<pages checked>\"")


if __name__ == "__main__":
    main()
