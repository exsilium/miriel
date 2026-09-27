"""Find the artworks on an art book spread without a model (docs/build-spec-artbooks.md §4.5).

Art sits on a flat background (light grey or black). The spread is shrunk, pixels that differ from the background
colour are masked, small gaps are closed, and each connected component becomes a box. Components below
MIN_AREA of the spread (captions, folios, specks) are dropped; a component that is itself a flat panel holding
several pieces (object sheets) is segmented again inside. A spread whose border is not mostly background is a
full-bleed painting: one box. Boxes are fractions of the spread [x0, y0, x1, y1], left to right, top to bottom.

  uv run python scripts/art_segment.py --book art1 60 120 180 --sheet <dir>   # numbered boxes for review
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import ARTBOOKS, ROOT  # noqa: E402

SCALE_WIDTH = 452           # working width (~1/6 of a 2714 px spread)
TOLERANCE = 26              # max channel difference still counted as background
BORDER = 3                  # border ring (working pixels) sampled for the background colour
FULL_BLEED_BELOW = 0.55     # background share of the border under which the spread is one painting
CLOSE = 5                   # MaxFilter size used to bridge gaps inside one artwork
MIN_AREA = 0.004            # boxes smaller than this share of the spread are dropped
PANEL_TOL = 6               # a panel is flat: its colour varies by at most this much ...
PANEL_RING = 0.9            # ... on this share of its border ring (a painting's edge scores ~0.4) ...
PANEL_INNER = 0.4           # ... and on this share of its interior (the space between the pieces)
PAD = 0.004                 # padding added around each box (fraction of the spread width)


@dataclass
class Segmentation:
    boxes: list[list[float]]    # [x0, y0, x1, y1] fractions of the spread
    background: str             # "#rrggbb", or "mixed" for full-bleed spreads
    mode: str                   # "segmented" | "full_bleed" | "empty"


def _quant(c: tuple[int, int, int]) -> tuple[int, int, int]:
    return (c[0] // 8 * 8, c[1] // 8 * 8, c[2] // 8 * 8)


def _ring(px, x0: int, y0: int, x1: int, y1: int, width: int) -> list[tuple[int, int, int]]:
    """Pixels of the ring `width` thick just inside the box (x1, y1 exclusive)."""
    out = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if x - x0 < width or x1 - 1 - x < width or y - y0 < width or y1 - 1 - y < width:
                out.append(px[x, y])
    return out


def _dominant(colors: list[tuple[int, int, int]]) -> tuple[tuple[int, int, int], float]:
    """Mean colour of the most common quantised colour, and the share of `colors` within TOLERANCE of it."""
    if not colors:
        return (0, 0, 0), 0.0
    mode, _ = Counter(_quant(c) for c in colors).most_common(1)[0]
    near = [c for c in colors if max(abs(a - b) for a, b in zip(c, mode)) <= TOLERANCE]
    mean = tuple(sum(c[i] for c in near) // len(near) for i in range(3)) if near else mode
    share = sum(1 for c in colors if max(abs(a - b) for a, b in zip(c, mean)) <= TOLERANCE) / len(colors)
    return mean, share


def _components(mask: list[list[bool]], x0: int, y0: int, x1: int, y1: int) -> list[tuple[int, int, int, int, int]]:
    """Connected components (4-neighbour) of `mask` inside the box: (x0, y0, x1, y1 exclusive, pixel count)."""
    seen = [[False] * (x1 - x0) for _ in range(y1 - y0)]
    out = []
    for sy in range(y0, y1):
        for sx in range(x0, x1):
            if not mask[sy][sx] or seen[sy - y0][sx - x0]:
                continue
            q = deque([(sx, sy)])
            seen[sy - y0][sx - x0] = True
            bx0 = bx1 = sx
            by0 = by1 = sy
            n = 0
            while q:
                x, y = q.popleft()
                n += 1
                bx0, bx1, by0, by1 = min(bx0, x), max(bx1, x), min(by0, y), max(by1, y)
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if x0 <= nx < x1 and y0 <= ny < y1 and mask[ny][nx] and not seen[ny - y0][nx - x0]:
                        seen[ny - y0][nx - x0] = True
                        q.append((nx, ny))
            out.append((bx0, by0, bx1 + 1, by1 + 1, n))
    return out


def _segment_region(small: Image.Image, bg: tuple[int, int, int], box: tuple[int, int, int, int],
                    min_px: float, depth: int) -> list[tuple[int, int, int, int]]:
    """Boxes (working pixels) of the art inside `box` on background `bg`."""
    x0, y0, x1, y1 = box
    px = small.load()
    w, h = small.size
    raw = Image.new("L", (w, h), 0)
    rp = raw.load()
    for y in range(y0, y1):
        for x in range(x0, x1):
            c = px[x, y]
            if max(abs(c[0] - bg[0]), abs(c[1] - bg[1]), abs(c[2] - bg[2])) > TOLERANCE:
                rp[x, y] = 255
    closed = raw.filter(ImageFilter.MaxFilter(CLOSE)).filter(ImageFilter.MinFilter(3))
    cp = closed.load()
    mask = [[cp[x, y] > 0 for x in range(w)] for y in range(h)]
    boxes = []
    for bx0, by0, bx1, by1, _n in _components(mask, x0, y0, x1, y1):
        if (bx1 - bx0) * (by1 - by0) < min_px:
            continue
        sub = _panel_children(small, (bx0, by0, bx1, by1), bg, min_px, depth)
        boxes.extend(sub or [(bx0, by0, bx1, by1)])
    return boxes


def _panel_children(small: Image.Image, box: tuple[int, int, int, int], outer_bg: tuple[int, int, int],
                    min_px: float, depth: int) -> list[tuple[int, int, int, int]] | None:
    """If the component is a flat panel of another colour holding two or more pieces, return those pieces."""
    if depth >= 1:
        return None
    # the closed mask is dilated by CLOSE // 2, so the component box reaches that far onto the outer background
    inset = CLOSE // 2 + 1
    x0, y0, x1, y1 = box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset
    if x1 - x0 < 20 or y1 - y0 < 20:
        return None
    px = small.load()
    ring = _ring(px, x0, y0, x1, y1, 2)
    color, _share = _dominant(ring)
    if max(abs(a - b) for a, b in zip(color, outer_bg)) <= TOLERANCE:
        return None

    def flat_share(colors: list[tuple[int, int, int]]) -> float:
        return sum(1 for c in colors if max(abs(a - b) for a, b in zip(c, color)) <= PANEL_TOL) / max(1, len(colors))

    inner = [px[x, y] for y in range(y0 + 2, y1 - 2, 2) for x in range(x0 + 2, x1 - 2, 2)]
    if flat_share(ring) < PANEL_RING or flat_share(inner) < PANEL_INNER:
        return None
    inner = _segment_region(small, color, (x0 + 2, y0 + 2, x1 - 2, y1 - 2), min_px, depth + 1)
    return inner if len(inner) >= 2 else None


def _merge_contained(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Drop boxes that lie mostly (> 70 %) inside a bigger one."""
    def area(b):
        return max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    keep = []
    for b in sorted(boxes, key=area, reverse=True):
        inside = False
        for k in keep:
            ix = max(0, min(b[2], k[2]) - max(b[0], k[0])) * max(0, min(b[3], k[3]) - max(b[1], k[1]))
            if area(b) and ix / area(b) > 0.7:
                inside = True
                break
        if not inside:
            keep.append(b)
    return keep


def segment(image_path: Path) -> Segmentation:
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        scale = SCALE_WIDTH / im.width
        small = im.resize((SCALE_WIDTH, max(1, round(im.height * scale))), Image.Resampling.BOX)
    w, h = small.size
    bg, share = _dominant(_ring(small.load(), 0, 0, w, h, BORDER))
    if share < FULL_BLEED_BELOW:
        return Segmentation([[0.0, 0.0, 1.0, 1.0]], "mixed", "full_bleed")
    boxes = _merge_contained(_segment_region(small, bg, (0, 0, w, h), MIN_AREA * w * h, 0))
    if not boxes:
        return Segmentation([], "#%02x%02x%02x" % bg, "empty")
    # reading order: left page, then right page (by box centre); within a page rows (bands of ~8 % height), then x
    boxes.sort(key=lambda b: ((b[0] + b[2]) / 2 >= w / 2, round(b[1] / (h * 0.08)), b[0]))
    pad = PAD * w
    frac = [[round(max(0.0, (x0 - pad) / w), 4), round(max(0.0, (y0 - pad) / h), 4),
             round(min(1.0, (x1 + pad) / w), 4), round(min(1.0, (y1 + pad) / h), 4)] for x0, y0, x1, y1 in boxes]
    return Segmentation(frac, "#%02x%02x%02x" % bg, "segmented")


def draw_boxes(image_path: Path, boxes: list[list[float]], width: int) -> Image.Image:
    """The spread at `width` px with numbered box outlines (the annotated image the labelling model sees)."""
    with Image.open(image_path) as im:
        im = im.convert("RGB")
        im = im.resize((width, round(im.height * width / im.width)), Image.Resampling.LANCZOS)
    d = ImageDraw.Draw(im)
    lw = max(2, width // 500)
    base = max(22, width // 45)
    for i, (x0, y0, x1, y1) in enumerate(boxes, 1):
        r = (x0 * im.width, y0 * im.height, x1 * im.width, y1 * im.height)
        d.rectangle(r, outline=(255, 0, 170), width=lw)
        # the tag covers at most ~a third of a small box (item icon grids), so the art stays visible
        size = int(max(12, min(base, (r[3] - r[1]) * 0.3, (r[2] - r[0]) * 0.3)))
        font = ImageFont.load_default(size=size)
        label = str(i)
        tb = d.textbbox((0, 0), label, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        pad = max(2, size // 4)
        lx, ly = r[0] + lw, r[1] + lw
        d.rectangle((lx, ly, lx + tw + 2 * pad, ly + th + 2 * pad), fill=(255, 0, 170))
        d.text((lx + pad, ly + pad - tb[1]), label, fill="white", font=font)
    return im


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf_pages", nargs="+", type=int)
    ap.add_argument("--book", required=True, choices=sorted(ARTBOOKS))
    ap.add_argument("--sheet", type=Path, help="write <book>_s<page>.jpg with numbered boxes into this folder")
    args = ap.parse_args()
    book = ARTBOOKS[args.book]
    for p in args.pdf_pages:
        seg = segment(book.image_path(p))
        print(f"{book.key} pdf {p} {book.folios(p)}: {seg.mode} bg={seg.background} {len(seg.boxes)} box(es)")
        if args.sheet:
            args.sheet.mkdir(parents=True, exist_ok=True)
            draw_boxes(book.image_path(p), seg.boxes, 1400).save(args.sheet / f"{book.key}_s{p:04d}.jpg", quality=85)


if __name__ == "__main__":
    main()
