"""Fallback for a page the API's output content filter blocks as a whole: transcribe it as several
rectangular parts of the photo and merge the results into one out/<book>/pNNNN.json.

The extraction prompt is unchanged; each request only adds a note that the image is one part of the page.
A part the filter still blocks becomes a marked gap in the markdown instead of failing the page, and the
deviation is recorded in quality.notes. By default the page is cut into a top and a bottom half at the
lightest horizontal gap near the middle (no text line is split).

Usage:
  uv run python scripts/extract_split.py --book vol1 --page 493                       # top / bottom halves
  uv run python scripts/extract_split.py --book vol1 --page 493 \\
      --parts "top=0,0,1,0.56;bottom-left=0,0.56,0.64,1;bottom-right=0.64,0.56,1,1"  # explicit rectangles (fractions)
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import anthropic
import jsonschema
import pymupdf
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, ROOT  # noqa: E402
import extract as ex  # noqa: E402

BLOCKED_MARK = "[not transcribed: the API's output content filter blocked this section of the page ({name})]"


@dataclass
class Part:
    name: str
    x0: float
    y0: float
    x1: float
    y1: float

    def crop(self, im: Image.Image) -> bytes:
        w, h = im.size
        box = (int(w * self.x0), int(h * self.y0), int(w * self.x1), int(h * self.y1))
        buf = io.BytesIO()
        im.crop(box).save(buf, format="JPEG", quality=92)
        return buf.getvalue()

    def contains(self, cx: float, cy: float) -> bool:
        return self.x0 <= cx < self.x1 and self.y0 <= cy < self.y1


def find_cut(im: Image.Image, lo: float = 0.40, hi: float = 0.60) -> float:
    """Fraction of the height with the least ink between lo and hi: a gap between text lines."""
    g = ImageOps.grayscale(im)
    w, h = g.size
    px = g.load()
    best_row, best_ink = h // 2, None
    for y in range(int(h * lo), int(h * hi)):
        ink = sum(255 - px[x, y] for x in range(0, w, 4))
        if best_ink is None or ink < best_ink:
            best_row, best_ink = y, ink
    return best_row / h


def parse_parts(spec: str) -> list[Part]:
    parts = []
    for item in spec.split(";"):
        item = item.strip()
        if not item:
            continue
        name, coords = item.split("=", 1)
        x0, y0, x1, y1 = (float(v) for v in coords.split(","))
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            sys.exit(f"bad rectangle for {name!r}: {coords} (fractions, x0<x1, y0<y1)")
        parts.append(Part(name.strip(), x0, y0, x1, y1))
    if not parts:
        sys.exit("--parts is empty")
    return parts


def ocr_for(page: pymupdf.Page, part: Part) -> str:
    w, h = page.rect.width, page.rect.height
    blocks = sorted(page.get_text("blocks"), key=lambda b: (b[1], b[0]))
    return "\n".join(b[4].strip() for b in blocks
                     if b[4].strip() and part.contains(((b[0] + b[2]) / 2) / w, ((b[1] + b[3]) / 2) / h))


def shift_figures(md: str, shift: int) -> str:
    if not shift:
        return md
    return re.sub(r"\[FIGURE (\d+)", lambda m: f"[FIGURE {int(m.group(1)) + shift}", md)


def merge(parts: list[tuple[Part, dict | None]], book_name: str, page: int, note: str) -> dict:
    """Combine part transcriptions (None = blocked) into one page object, in the given order."""
    md_chunks: list[str] = []
    figures: list[dict] = []
    entities: list[dict] = []
    seen: dict[tuple[str, str], dict] = {}
    chapter = region = page_type = None
    quality_issues: set[str] = set()
    affected: list[str] = []
    notes: list[str] = [note]
    image_quality, ocr_agreement, retake, retake_reason, illegible = "good", "high", False, None, 0
    q_order = ["good", "usable", "poor", "unusable"]
    ocr_order = ["high", "medium", "low"]
    blocked = [p.name for p, o in parts if o is None]
    for part, obj in parts:
        if obj is None:
            md_chunks.append(BLOCKED_MARK.format(name=part.name))
            continue
        md_chunks.append(shift_figures(obj["markdown"].strip(), len(figures)))
        figures.extend(obj["figures"])
        for e in obj["entities"]:
            key = (e["type"], e["name"])
            if key in seen:
                prev = seen[key]
                prev["location"] = prev["location"] or e["location"]
                prev["how_to_obtain"] = prev["how_to_obtain"] or e["how_to_obtain"]
                for c in e["connects_to"]:
                    if c not in prev["connects_to"]:
                        prev["connects_to"].append(c)
            else:
                seen[key] = dict(e)
                entities.append(seen[key])
        chapter = chapter or obj["chapter"]
        region = region or obj["region"]
        if page_type is None or (page_type == "other" and obj["page_type"] != "other"):
            page_type = obj["page_type"]
        q = obj["quality"]
        image_quality = max(image_quality, q["image_quality"], key=q_order.index)
        ocr_agreement = max(ocr_agreement, q["ocr_agreement"], key=ocr_order.index)
        quality_issues |= set(q["quality_issues"])
        if q["affected_areas"]:
            affected.append(f"{part.name}: {q['affected_areas']}")
        retake = retake or q["retake_recommended"]
        retake_reason = retake_reason or q["retake_reason"]
        illegible += q["illegible_regions"]
        if q["notes"]:
            notes.append(f"{part.name}: {q['notes']}")
    if blocked:
        notes.append(f"Section(s) not transcribed because the API's output content filter blocked them: {', '.join(blocked)}.")
    return {
        "book": book_name,
        "page": page,
        "chapter": chapter,
        "region": region,
        "page_type": page_type or "other",
        "markdown": "\n\n".join(md_chunks) + "\n",
        "figures": figures,
        "entities": entities,
        "quality": {
            "image_quality": image_quality,
            "quality_issues": sorted(quality_issues),
            "affected_areas": " / ".join(affected) or None,
            "retake_recommended": retake,
            "retake_reason": retake_reason,
            "ocr_agreement": ocr_agreement,
            "illegible_regions": illegible,
            "notes": " ".join(notes),
        },
    }


def is_filter_block(e: Exception) -> bool:
    return isinstance(e, anthropic.APIStatusError) and "content filtering" in str(e)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--page", type=int, required=True, help="printed page number")
    ap.add_argument("--parts", help='rectangles as fractions: "name=x0,y0,x1,y1;..." (default: top/bottom halves at the lightest gap)')
    ap.add_argument("--model", default=ex.DEFAULT_MODEL)
    ap.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--max-tokens", type=int, default=ex.DEFAULT_MAX_TOKENS)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--keep-parts", action="store_true", help="write each part's image and raw JSON under _failed/ for inspection")
    args = ap.parse_args()
    book = BOOKS[args.book]
    out_dir = args.out or (ROOT / "out" / book.key)
    page = args.page

    image_path = book.image_path(page)
    pdf_page = pymupdf.open(book.pdf)[book.pdf_index(page)]
    im = Image.open(image_path)
    im.load()
    if args.parts:
        parts = parse_parts(args.parts)
    else:
        cut = find_cut(im)
        parts = [Part("top", 0, 0, 1, cut), Part("bottom", 0, cut, 1, 1)]
    print(f"p{page:04d}: {image_path.name} {im.size[0]}x{im.size[1]}; parts: "
          + "; ".join(f"{p.name}=({p.x0:.2f},{p.y0:.2f})-({p.x1:.2f},{p.y1:.2f})" for p in parts))
    dbg = out_dir / "_failed"
    if args.keep_parts:
        dbg.mkdir(exist_ok=True)

    ex.load_dotenv()
    client = anthropic.Anthropic(max_retries=2, timeout=600.0)
    prompt = ex.fill_prompt(ex.load_prompt_body(), book, page)
    results: list[tuple[Part, dict | None]] = []
    usage_in = usage_out = 0
    started = time.time()
    for part in parts:
        img = part.crop(im)
        ocr = ocr_for(pdf_page, part)
        if args.keep_parts:
            (dbg / f"p{page:04d}.{part.name}.jpg").write_bytes(img)
        job = ex.PageJob(page=page, pdf_index=book.pdf_index(page), image_path=image_path, ocr_text=ocr, prompt=prompt)
        request = ex.build_request(job, img)
        note = (f"Note: this image is one part of printed page {page} (the '{part.name}' area); the page is being transcribed "
                f"in {len(parts)} parts because of its size. Transcribe only what is visible in this part. The OCR text below covers this part only.")
        request["messages"][0]["content"][1]["text"] = note + "\n\n" + request["messages"][0]["content"][1]["text"]
        t0 = time.time()
        try:
            text, message = ex.call_model(client, request, model=args.model, max_tokens=args.max_tokens, effort=args.effort, fallback=True)
        except Exception as e:  # noqa: BLE001
            if is_filter_block(e):
                print(f"  {part.name}: BLOCKED by the output content filter ({time.time() - t0:.0f}s); will be marked as a gap")
                results.append((part, None))
                continue
            raise
        obj = ex.parse_json(text)
        warnings = ex.validate(obj, page, book)
        usage_in += message.usage.input_tokens
        usage_out += message.usage.output_tokens
        print(f"  {part.name}: ok {time.time() - t0:.0f}s {message.usage.input_tokens}/{message.usage.output_tokens} tok, "
              f"type={obj['page_type']} figs={len(obj['figures'])} ents={len(obj['entities'])} md={len(obj['markdown'])} chars"
              + (f"\n     warnings: {'; '.join(warnings)}" if warnings else ""))
        if args.keep_parts:
            (dbg / f"p{page:04d}.{part.name}.json").write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        results.append((part, obj))

    if all(o is None for _, o in results):
        sys.exit("every part was blocked by the output content filter; nothing written")
    note = (f"Transcribed from {len(parts)} rectangular parts of the page photo by scripts/extract_split.py "
            f"({'; '.join(f'{p.name}=({p.x0:.2f},{p.y0:.2f})-({p.x1:.2f},{p.y1:.2f})' for p in parts)}) "
            f"because the API's output content filter blocked the transcription of the full page.")
    merged = merge(results, book.name, page, note)
    jsonschema.validate(merged, ex.PAGE_SCHEMA)
    warnings = ex.validate(merged, page, book)
    path = ex.out_path(out_dir, page)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    fp = ex.failed_path(out_dir, page)
    if fp.exists():
        fp.unlink()
    cost = ex.cost_usd(args.model, usage_in, usage_out)
    blocked = [p.name for p, o in results if o is None]
    with (out_dir / "_runlog.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"run_id": "split-" + time.strftime("%Y%m%d-%H%M%S"), "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                            "page": page, "status": "ok", "attempt": 1, "model": args.model, "effort": args.effort,
                            "parts": [p.name for p in parts], "blocked_parts": blocked, "seconds": round(time.time() - started, 1),
                            "input_tokens": usage_in, "output_tokens": usage_out,
                            "cost_usd": round(cost, 4) if cost is not None else None,
                            "image_quality": merged["quality"]["image_quality"], "retake": merged["quality"]["retake_recommended"],
                            "ocr_agreement": merged["quality"]["ocr_agreement"], "warnings": warnings}, ensure_ascii=False) + "\n")
    print(f"wrote {path.name}: figs={len(merged['figures'])} ents={len(merged['entities'])} md={len(merged['markdown'])} chars"
          + (f", blocked parts: {blocked}" if blocked else "") + (f" ${cost:.3f}" if cost is not None else "")
          + (f"\n  warnings: {'; '.join(warnings)}" if warnings else ""))


if __name__ == "__main__":
    main()
