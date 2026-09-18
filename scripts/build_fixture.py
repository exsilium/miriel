"""Build the test fixture: test-pages.pdf (pages extracted from the source PDF, in order)
and ./test-pages/ with the matching page images plus a manifest.json.

Usage:  uv run python scripts/build_fixture.py
"""
from __future__ import annotations

import json
import shutil
import sys

import pymupdf

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from pages import FIXTURE_DIR, FIXTURE_MANIFEST, FIXTURE_PAGES, FIXTURE_PDF, VOL1  # noqa: E402


def main() -> None:
    book = VOL1
    FIXTURE_DIR.mkdir(exist_ok=True)
    src = pymupdf.open(book.pdf)
    out = pymupdf.open()
    manifest = []
    for fixture_idx, (printed, why) in enumerate(FIXTURE_PAGES.items()):
        idx = book.pdf_index(printed)
        out.insert_pdf(src, from_page=idx, to_page=idx)
        img = book.image_path(printed)
        if not img.exists():
            sys.exit(f"missing image: {img}")
        shutil.copy2(img, FIXTURE_DIR / img.name)
        # Sanity: the embedded image on the PDF page must match the JPG dimensions.
        info = src.extract_image(src[idx].get_images()[0][0])
        with __import__("PIL.Image", fromlist=["Image"]).open(img) as im:
            if (info["width"], info["height"]) != im.size:
                sys.exit(f"dimension mismatch for printed page {printed}: pdf {info['width']}x{info['height']} vs jpg {im.size}")
        manifest.append({
            "fixture_index": fixture_idx,
            "printed_page": printed,
            "source_pdf_index": idx,
            "image": img.name,
            "page_type": why,
        })
        print(f"fixture page {fixture_idx}: printed {printed:3d}  <- pdf idx {idx:3d}, {img.name}")
    out.save(FIXTURE_PDF, garbage=3, deflate=True)
    FIXTURE_MANIFEST.write_text(json.dumps({"book": book.key, "pages": manifest}, indent=2) + "\n")
    print(f"wrote {FIXTURE_PDF.name} ({FIXTURE_PDF.stat().st_size // 1024} KB, {len(out)} pages) and {FIXTURE_DIR.name}/ ({len(manifest)} images + manifest.json)")


if __name__ == "__main__":
    main()
