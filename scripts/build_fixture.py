"""Build a book's test fixture: test-pages/<book>/fixture.pdf (the chosen pages extracted from the
source PDF, in the given order), the matching page images, and manifest.json.

Pages are PRINTED page numbers. See "Test run" in prompts/page-extraction-prompt.md for how to pick them.

Usage:
  uv run python scripts/build_fixture.py --book vol1 --pages 159,73,33,316,501,289
  uv run python scripts/build_fixture.py --book vol2 --pages 11,200,...
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, Book  # noqa: E402


def parse_pages(spec: str) -> list[int]:
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if part:
            pages.append(int(part))
    if not pages:
        sys.exit("--pages is empty")
    if len(set(pages)) != len(pages):
        sys.exit("--pages contains duplicates")
    return pages


def build(book: Book, pages: list[int]) -> None:
    for p in (book.pdf, book.image_dir):
        if not p.exists():
            sys.exit(f"missing source: {p} (is DATA_DIR right?)")
    book.fixture_dir.mkdir(parents=True, exist_ok=True)
    for old in book.fixture_dir.glob("*.jpg"):
        old.unlink()
    src = pymupdf.open(book.pdf)
    out = pymupdf.open()
    manifest = []
    for fixture_idx, printed in enumerate(pages):
        try:
            idx = book.pdf_index(printed)
        except ValueError as e:
            sys.exit(str(e))
        out.insert_pdf(src, from_page=idx, to_page=idx)
        img = book.image_path(printed)
        if not img.exists():
            sys.exit(f"missing image: {img}")
        shutil.copy2(img, book.fixture_dir / img.name)
        # Sanity: the embedded image on the PDF page must match the JPG dimensions.
        images = src[idx].get_images()
        if images:
            info = src.extract_image(images[0][0])
            with Image.open(img) as im:
                if (info["width"], info["height"]) != im.size:
                    sys.exit(f"dimension mismatch for printed page {printed}: pdf {info['width']}x{info['height']} vs jpg {im.size}")
        manifest.append({
            "fixture_index": fixture_idx,
            "printed_page": printed,
            "source_pdf_index": idx,
            "image": img.name,
        })
        print(f"fixture page {fixture_idx}: printed {printed:3d}  <- pdf idx {idx:3d}, {img.name}")
    out.save(book.fixture_pdf, garbage=3, deflate=True)
    book.fixture_manifest.write_text(
        json.dumps({"book": book.key, "source_book": book.name, "pdf": book.fixture_pdf.name, "pages": manifest}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {book.fixture_pdf.relative_to(book.fixture_dir.parent.parent)} ({book.fixture_pdf.stat().st_size // 1024} KB, "
          f"{len(out)} pages), {len(manifest)} images and manifest.json in {book.fixture_dir.relative_to(book.fixture_dir.parent.parent)}/")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--pages", required=True, help="printed page numbers, comma-separated, in fixture order")
    args = ap.parse_args()
    build(BOOKS[args.book], parse_pages(args.pages))


if __name__ == "__main__":
    main()
