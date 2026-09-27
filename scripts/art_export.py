"""Write the page images of an art book to DATA_DIR/<imageDir>/, byte for byte from the PDF.

Art book PDFs (docs/build-spec-artbooks.md) carry exactly one JPEG per page covering the whole page. That stream
is the page image: it is copied out unchanged (no decode, no re-encode), so a spread file is identical to what
the PDF shows and can always be rebuilt from the PDF. File n is PDF page n (`imagePattern`, {n} = PDF page).

  uv run python scripts/art_export.py --book art1            # every page; files that already match are skipped
  uv run python scripts/art_export.py --book art1 --check    # compare only, write nothing

Fails loudly when a page does not have exactly one image, the image is not a plain JPEG stream, or it does not
cover the page (such a PDF needs another export route; ask before adding one).
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import ARTBOOKS, ArtBook  # noqa: E402


class ExportError(Exception):
    pass


def page_jpeg(doc: pymupdf.Document, index: int) -> bytes:
    """The raw JPEG stream of the single full-page image on page `index` (0-based)."""
    page = doc[index]
    images = page.get_images(full=True)
    if len(images) != 1:
        raise ExportError(f"PDF page {index + 1}: {len(images)} images, expected 1")
    xref, _smask, width, height, _bpc, _cs, _alt, _name, filt = images[0][:9]
    if filt != "DCTDecode":
        raise ExportError(f"PDF page {index + 1}: image filter {filt!r}, expected DCTDecode")
    rects = page.get_image_rects(xref)
    pr = page.rect
    if len(rects) != 1 or any(abs(a - b) > 1.5 for a, b in zip(rects[0], pr)):
        raise ExportError(f"PDF page {index + 1}: image at {rects} does not cover the page {pr}")
    data = doc.xref_stream_raw(xref)
    if not data.startswith(b"\xff\xd8"):
        raise ExportError(f"PDF page {index + 1}: image stream is not a JPEG ({data[:4]!r})")
    return data


def export(book: ArtBook, check_only: bool) -> int:
    doc = pymupdf.open(book.pdf)
    if doc.page_count != book.page_count:
        raise ExportError(f"{book.pdf.name} has {doc.page_count} pages, config says {book.page_count}")
    if not check_only:
        book.image_dir.mkdir(parents=True, exist_ok=True)
    written = same = differ = 0
    for i in range(doc.page_count):
        data = page_jpeg(doc, i)
        target = book.image_path(i + 1)
        if target.exists() and hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(data).digest():
            same += 1
            continue
        if check_only:
            differ += 1
            print(f"  {'differs' if target.exists() else 'missing'}: {target.name}")
            continue
        tmp = target.with_suffix(".jpg.tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
        written += 1
    print(f"{book.key}: {doc.page_count} pages; {same} file(s) already match"
          + (f", {differ} missing or different" if check_only else f", {written} written") + f"  ->  {book.image_dir}")
    return 1 if differ else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(ARTBOOKS), help="art book id from config/books.json")
    ap.add_argument("--check", action="store_true", help="compare the image folder with the PDF; write nothing")
    args = ap.parse_args()
    try:
        sys.exit(export(ARTBOOKS[args.book], args.check))
    except ExportError as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
