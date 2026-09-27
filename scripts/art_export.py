"""Write the page images of an art book to DATA_DIR/<imageDir>/, byte for byte from the PDF.

Art book PDFs (docs/build-spec-artbooks.md) carry one JPEG per page covering the whole page (Vol 1, Vol 2). That
stream is the page image: it is copied out unchanged (no decode, no re-encode), so a spread file is identical to
what the PDF shows and can always be rebuilt from the PDF. File n is PDF page n (`imagePattern`, {n} = PDF page).

Some PDFs (Vol 3) tile a spread from several JPEGs side by side, one per printed page. Those are decoded, pasted
edge to edge at their native size and saved as one JPEG with the first tile's quantization tables and chroma
subsampling (deterministic, so re-runs and --check compare by hash on the same Pillow build).

  uv run python scripts/art_export.py --book art1            # every page; files that already match are skipped
  uv run python scripts/art_export.py --book art1 --check    # compare only, write nothing

Fails loudly when a page's images are not plain JPEG streams, or they do not cover the page (one image, or tiles
of equal height in a single row without gaps or overlaps) (such a PDF needs another export route; ask before adding one).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import sys
from pathlib import Path

import pymupdf
from PIL import Image, JpegImagePlugin

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import ARTBOOKS, ArtBook  # noqa: E402


class ExportError(Exception):
    pass


TOLERANCE = 1.5   # points: how far an image edge may sit from the page edge or the next tile


def page_jpeg(doc: pymupdf.Document, index: int) -> bytes:
    """The spread JPEG of page `index` (0-based): the raw stream of a single full-page image, or its tiles stitched."""
    page = doc[index]
    images = page.get_images(full=True)
    if not images:
        raise ExportError(f"PDF page {index + 1}: no image")
    pr = page.rect
    tiles: list[tuple[pymupdf.Rect, bytes, int, int]] = []
    for xref, _smask, width, height, _bpc, _cs, _alt, _name, filt, *_ in images:
        if filt != "DCTDecode":
            raise ExportError(f"PDF page {index + 1}: image filter {filt!r}, expected DCTDecode")
        rects = page.get_image_rects(xref)
        if len(rects) != 1:
            raise ExportError(f"PDF page {index + 1}: image {xref} is drawn {len(rects)} times")
        data = doc.xref_stream_raw(xref)
        if not data.startswith(b"\xff\xd8"):
            raise ExportError(f"PDF page {index + 1}: image stream is not a JPEG ({data[:4]!r})")
        tiles.append((rects[0], data, width, height))
    tiles.sort(key=lambda t: t[0].x0)
    covers = (abs(tiles[0][0].x0 - pr.x0) <= TOLERANCE and abs(tiles[-1][0].x1 - pr.x1) <= TOLERANCE
              and all(abs(r.y0 - pr.y0) <= TOLERANCE and abs(r.y1 - pr.y1) <= TOLERANCE for r, *_ in tiles)
              and all(abs(a[0].x1 - b[0].x0) <= TOLERANCE for a, b in zip(tiles, tiles[1:])))
    if not covers:
        raise ExportError(f"PDF page {index + 1}: images at {[str(t[0]) for t in tiles]} do not tile the page {pr}")
    if len(tiles) == 1:
        return tiles[0][1]
    if len({h for *_, h in tiles}) != 1:
        raise ExportError(f"PDF page {index + 1}: tiles differ in pixel height {[h for *_, h in tiles]}")
    return stitch([t[1] for t in tiles])


def stitch(jpegs: list[bytes]) -> bytes:
    """Paste JPEG tiles left to right and encode once, keeping the first tile's tables and subsampling."""
    ims = [Image.open(io.BytesIO(b)) for b in jpegs]
    first = ims[0]
    canvas = Image.new("RGB", (sum(im.width for im in ims), first.height))
    x = 0
    for im in ims:
        canvas.paste(im.convert("RGB"), (x, 0))
        x += im.width
    out = io.BytesIO()
    canvas.save(out, "JPEG", qtables=first.quantization, subsampling=JpegImagePlugin.get_sampling(first),
                dpi=first.info.get("dpi", (72, 72)), optimize=True)
    return out.getvalue()


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
