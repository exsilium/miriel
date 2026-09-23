"""Book configuration (from config/books.json) and the printed-page <-> PDF index <-> image file mapping.

    image  "<imagePattern with n>"  ==  PDF page n (1-based)  ==  PDF index n-1,   where n = printed + offset

Source files live under DATA_DIR (environment or .env; default <repo>/data); the paths in
config/books.json are relative to it. Run `scripts/check_offset.py --book <id>` to verify the offset
of a new book; the result is recorded in the config as `offsetVerified`.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "books.json"
FIXTURE_ROOT = ROOT / "test-pages"          # test-pages/<book>/{fixture.pdf, manifest.json, *.jpg}


def _read_dotenv(path: Path = ROOT / ".env") -> dict[str, str]:
    """KEY=value lines, '#' comments, optional surrounding quotes. No expansion."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip("'\"")
    return out


def data_dir() -> Path:
    """DATA_DIR from the environment, else from .env, else <repo>/data. Relative values resolve against the repo root."""
    raw = os.environ.get("DATA_DIR") or _read_dotenv().get("DATA_DIR") or "data"
    p = Path(raw)
    return p if p.is_absolute() else (ROOT / p).resolve()


@dataclass(frozen=True)
class Book:
    key: str            # config id, used in output paths, e.g. "vol1"
    name: str           # sourceBook: value for {{BOOK}} and the `book` field of every page file
    title: str
    label: str
    pdf: Path
    image_dir: Path
    image_pattern: str  # "{n}" = printed page + offset
    offset: int         # printed page + offset = 1-based PDF page number = image number
    page_count: int     # PDF page count; surplus image files are ignored
    offset_verified: str | None = None

    def pdf_index(self, printed: int) -> int:
        """0-based index into the PDF for a printed page number."""
        idx = printed + self.offset - 1
        if not 0 <= idx < self.page_count:
            raise ValueError(f"printed page {printed} is outside {self.key} ({self.first_printed}..{self.last_printed})")
        return idx

    def image_path(self, printed: int) -> Path:
        return self.image_dir / self.image_pattern.replace("{n}", str(printed + self.offset))

    def printed_from_index(self, idx: int) -> int:
        return idx + 1 - self.offset

    @property
    def first_printed(self) -> int:
        return 1 - self.offset

    @property
    def last_printed(self) -> int:
        return self.page_count - self.offset

    # --- fixture (test-pages/<book>/) ---
    @property
    def fixture_dir(self) -> Path:
        return FIXTURE_ROOT / self.key

    @property
    def fixture_pdf(self) -> Path:
        return self.fixture_dir / "fixture.pdf"

    @property
    def fixture_manifest(self) -> Path:
        return self.fixture_dir / "manifest.json"


def load_books(config_path: Path = CONFIG_PATH, base: Path | None = None) -> dict[str, Book]:
    base = base or data_dir()
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    books: dict[str, Book] = {}
    for key, b in raw.items():
        if "{n}" not in b["imagePattern"]:
            raise ValueError(f"{config_path}: {key}.imagePattern must contain {{n}}")
        books[key] = Book(
            key=key, name=b["sourceBook"], title=b["title"], label=b["label"],
            pdf=base / b["pdf"], image_dir=base / b["imageDir"], image_pattern=b["imagePattern"],
            offset=int(b["printedToPdfOffset"]), page_count=int(b["pageCount"]),
            offset_verified=b.get("offsetVerified"),
        )
    return books


BOOKS = load_books()
