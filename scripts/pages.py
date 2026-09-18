"""Book configuration and the printed-page <-> PDF index <-> image file mapping.

Verified 2026-09-17 for Vol 1 on all 513 pages:
    image  "<dir> - N.jpg"   ==  PDF page N (1-based)  ==  PDF index N-1  ==  printed page N-1
i.e. printed page = image number - 1. Image 1 is the cover (no printed number).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Book:
    key: str            # short id used in output paths, e.g. "vol1"
    name: str           # value for {{BOOK}}
    pdf: Path
    image_dir: Path
    offset: int         # printed page + offset = 1-based PDF page number = image number
    page_count: int

    def pdf_index(self, printed: int) -> int:
        """0-based index into the PDF for a printed page number."""
        idx = printed + self.offset - 1
        if not 0 <= idx < self.page_count:
            raise ValueError(f"printed page {printed} is outside {self.key} (0..{self.page_count - self.offset})")
        return idx

    def image_path(self, printed: int) -> Path:
        n = printed + self.offset
        return self.image_dir / f"{self.image_dir.name} - {n}.jpg"

    def printed_from_index(self, idx: int) -> int:
        return idx + 1 - self.offset


VOL1 = Book(
    key="vol1",
    name="Vol 1 - The Lands Between",
    pdf=ROOT / "Elden Ring Vol 1 - The Lands Between.pdf",
    image_dir=ROOT / "Elden Ring Vol 1 - The Lands Between",
    offset=1,
    page_count=513,
)

BOOKS = {b.key: b for b in (VOL1,)}

# Test fixture (see "Test run" in prompts/page-extraction-prompt.md). Printed page numbers, in order.
FIXTURE_PAGES = {
    159: "Dense walkthrough (two-column text)",
    73:  "Full-page or large map with numbered legend",
    33:  "Item table (enemy stat tables; Vol 1 has no weapon/armor tables)",
    316: "Boss page with stat block and sidebars",
    501: "Lore / NPC page",
    289: "Weak scan (out of focus map)",
}
FIXTURE_PDF = ROOT / "test-pages.pdf"
FIXTURE_DIR = ROOT / "test-pages"
FIXTURE_MANIFEST = FIXTURE_DIR / "manifest.json"
