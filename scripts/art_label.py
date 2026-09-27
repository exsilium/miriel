"""Label the artworks of art book spreads: out/<art id>/s{PDFPAGE:04d}.json (docs/build-spec-artbooks.md §4).

Pages are PDF page numbers (one spread each; printed folios come from the config's `spread` rule). Per spread:
scripts/art_segment.py finds the boxes, the model (prompts/art-label-prompt.md) groups them into artworks and names
them, scripts/art_names.py checks each English name against the guide extractions.

  uv run python scripts/art_label.py --book art1 60 120 180               # a few spreads
  uv run python scripts/art_label.py --book art1 --workers 4 2-220        # the whole book
  uv run python scripts/art_label.py --book art1 60 --dry-run             # boxes + request sizes, no API call
  uv run python scripts/art_label.py --book art1 3 60 --out test-pages/art/sonnet --model claude-sonnet-5

Same machinery as scripts/extract.py: resumable (valid output is skipped unless --force), shared rate-limit
pause across --workers, retries, atomic writes, out/<id>/_runlog.jsonl, cost summary, _failed/sNNNN.txt.
A spread without any box (blank page) gets a label file with no artworks and no model call.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import anthropic
import jsonschema
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from art_names import annotate, default_index  # noqa: E402
from art_segment import Segmentation, draw_boxes, segment  # noqa: E402
from extract import (  # noqa: E402
    DEFAULT_MODEL, MAX_RATE_LIMIT_WAITS, FatalError, RetryableError, Throttle, call_model, cost_usd, fmt_duration,
    fmt_tokens, load_dotenv, parse_json, parse_pages, price_for, read_pages_file, retry_after_seconds, say,
)
from pages import ARTBOOKS, ROOT, ArtBook  # noqa: E402

PROMPT_PATH = ROOT / "prompts" / "art-label-prompt.md"
CLEAN_WIDTH = 2300          # 2300 x 1627 = 3.74 MP, under the 3.75 MP / 2576 px image limit
BOXES_WIDTH = 1400
BOXES_WIDTH_CROWDED = 2000  # spreads with more than CROWDED boxes (item icon grids) get a larger annotated image
CROWDED = 20
DEFAULT_MAX_TOKENS = 16000
KINDS = ["location", "architecture", "character", "npc", "boss", "enemy", "creature", "weapon", "armor", "item",
         "spell", "object", "scene", "other"]

# What the model returns.
LABEL_SCHEMA = {
    "type": "object",
    "required": ["artworks", "not_art", "section_heading_ja", "notes"],
    "additionalProperties": False,
    "properties": {
        "artworks": {"type": "array", "items": {
            "type": "object",
            "required": ["boxes", "kind", "caption_ja", "names", "description", "confidence"],
            "additionalProperties": False,
            "properties": {
                "boxes": {"type": "array", "items": {"type": "integer", "minimum": 1}, "minItems": 1},
                "kind": {"enum": KINDS},
                "caption_ja": {"type": ["string", "null"]},
                "names": {"type": "array", "items": {
                    "type": "object", "required": ["name", "source"], "additionalProperties": False,
                    "properties": {"name": {"type": "string", "minLength": 1}, "source": {"enum": ["caption", "visual"]}},
                }},
                "description": {"type": "string", "minLength": 1},
                "confidence": {"enum": ["high", "medium", "low"]},
            },
        }},
        "not_art": {"type": "array", "items": {"type": "integer", "minimum": 1}},
        "section_heading_ja": {"type": ["string", "null"]},
        "notes": {"type": ["string", "null"]},
    },
}

_log_lock = threading.Lock()


def load_prompt_body(path: Path = PROMPT_PATH) -> str:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "---":
            return "\n".join(lines[i + 1:]).strip() + "\n"
    sys.exit(f"{path}: no `---` separator found")


def out_path(out_dir: Path, pdf_page: int) -> Path:
    return out_dir / f"s{pdf_page:04d}.json"


def jpeg_b64(im: Image.Image, quality: int = 88) -> str:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


@dataclass
class SpreadJob:
    pdf_page: int
    folios: list[int]
    contents: list[dict]
    seg: Segmentation


def context_text(book: ArtBook, job: SpreadJob) -> str:
    lines = [f"Book: {book.title}", f"PDF page {job.pdf_page}"
             + (f", printed pages {job.folios[0]}-{job.folios[1]}" if job.folios else " (cover, no page numbers)")]
    for e in job.contents:
        part = e["chapter"] + (f" > {e['section']}" if e.get("section") else "")
        if e.get("section_ja"):
            part += f" ({e['section_ja']})"
        if e.get("region"):
            part += f"; region: {e['region']}"
        lines.append(f"Contents: {part} [pp. {e['from']}-{e['to']}]")
    if not job.contents:
        lines.append("Contents: (no contents entry for these pages)")
    lines.append("")
    if job.seg.mode == "full_bleed":
        lines.append("Box 1 is the whole spread (the art runs to the page edges).")
    lines.append(f"Boxes ({len(job.seg.boxes)}), as percent of spread width/height, left-top to right-bottom:")
    for i, (x0, y0, x1, y1) in enumerate(job.seg.boxes, 1):
        side = "left page" if (x0 + x1) / 2 < 0.5 else "right page"
        if x0 < 0.45 and x1 > 0.55:
            side = "across the gutter"
        lines.append(f"  {i}: x {x0 * 100:.0f}-{x1 * 100:.0f}, y {y0 * 100:.0f}-{y1 * 100:.0f} ({side})")
    return "\n".join(lines)


def build_request(book: ArtBook, job: SpreadJob, system: str) -> dict:
    path = book.image_path(job.pdf_page)
    with Image.open(path) as im:
        im = im.convert("RGB")
        clean = im.resize((CLEAN_WIDTH, round(im.height * CLEAN_WIDTH / im.width)), Image.Resampling.LANCZOS)
    boxed = draw_boxes(path, job.seg.boxes, BOXES_WIDTH_CROWDED if len(job.seg.boxes) > CROWDED else BOXES_WIDTH)
    return {
        "system": system,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "The spread:"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(clean)}},
            {"type": "text", "text": "The same spread with the numbered boxes:"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(boxed)}},
            {"type": "text", "text": context_text(book, job)},
        ]}],
    }


def validate_label(obj: dict, n_boxes: int) -> list[str]:
    """Raise on schema violations or a box used twice / out of range; return soft warnings."""
    jsonschema.validate(obj, LABEL_SCHEMA)
    used = [b for a in obj["artworks"] for b in a["boxes"]] + obj["not_art"]
    bad = sorted({b for b in used if b > n_boxes})
    if bad:
        raise jsonschema.ValidationError(f"box numbers {bad} do not exist (there are {n_boxes})")
    dup = sorted({b for b in used if used.count(b) > 1})
    if dup:
        raise jsonschema.ValidationError(f"boxes {dup} are used more than once")
    missing = sorted(set(range(1, n_boxes + 1)) - set(used))
    if missing:
        raise jsonschema.ValidationError(f"boxes {missing} are neither in an artwork nor in not_art")
    warnings = []
    for i, a in enumerate(obj["artworks"], 1):
        if a["caption_ja"] and not any(n["source"] == "caption" for n in a["names"]):
            warnings.append(f"artwork {i} has a caption but no caption-sourced name")
    return warnings


def union_bbox(seg: Segmentation, boxes: list[int]) -> list[float]:
    rects = [seg.boxes[b - 1] for b in boxes]
    return [min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects)]


def label_file(book: ArtBook, job: SpreadJob, label: dict | None, meta: dict) -> dict:
    """The file written to out/<id>/sNNNN.json: segmentation + label, names annotated, bbox per artwork."""
    label = label or {"artworks": [], "not_art": [], "section_heading_ja": None, "notes": None}
    for a in label["artworks"]:
        a["bbox"] = union_bbox(job.seg, a["boxes"])
    annotate(label, default_index())
    return {
        "book": book.key, "pdf_page": job.pdf_page, "folios": job.folios,
        "contents": [{k: e.get(k) for k in ("chapter", "section", "section_ja", "region")} for e in job.contents],
        "segmentation": {"mode": job.seg.mode, "background": job.seg.background, "boxes": job.seg.boxes},
        **label,
        "meta": meta,
    }


def existing_valid(out_dir: Path, pdf_page: int) -> bool | None:
    path = out_path(out_dir, pdf_page)
    if not path.exists():
        return None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        # back to what the model returned: drop the runner's bbox and name-check fields, then validate as a reply
        label = {k: obj[k] for k in LABEL_SCHEMA["required"]}
        label["artworks"] = [
            {k: v for k, v in a.items() if k != "bbox"} | {"names": [{"name": n["name"], "source": n["source"]} for n in a["names"]]}
            for a in label["artworks"]]
        validate_label(label, len(obj["segmentation"]["boxes"]))
        return True
    except (json.JSONDecodeError, jsonschema.ValidationError, KeyError, TypeError):
        return False


@dataclass
class RunContext:
    book: ArtBook
    client: anthropic.Anthropic | None
    out_dir: Path
    args: argparse.Namespace
    run_id: str
    system: str
    prompt_sha256: str
    throttle: Throttle = field(default_factory=Throttle)


@dataclass
class Result:
    pdf_page: int
    status: str
    seconds: float
    input_tokens: int = 0
    output_tokens: int = 0
    cost: float | None = None
    detail: str = ""
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


def append_runlog(ctx: RunContext, record: dict) -> None:
    record = {"run_id": ctx.run_id, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}
    with _log_lock:
        with (ctx.out_dir / "_runlog.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_atomic(path: Path, obj: dict) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def write_failed(ctx: RunContext, pdf_page: int, error: str, text: str | None) -> None:
    path = ctx.out_dir / "_failed" / f"s{pdf_page:04d}.txt"
    path.parent.mkdir(exist_ok=True)
    path.write_text(f"pdf page: {pdf_page}\nrun_id: {ctx.run_id}\nmodel: {ctx.args.model}\nerror: {error}\n\n"
                    f"----- raw model text -----\n{text or '(no model text)'}\n", encoding="utf-8")


def summary_line(obj: dict) -> str:
    names = [n for a in obj["artworks"] for n in a["names"]]
    ver = sum(1 for n in names if n["verified"])
    return (f"{obj['segmentation']['mode']} boxes={len(obj['segmentation']['boxes'])} art={len(obj['artworks'])} "
            f"not_art={len(obj['not_art'])} names={len(names)} verified={ver}")


def run_spread(job: SpreadJob, ctx: RunContext) -> Result:
    args = ctx.args
    started = time.time()
    path = out_path(ctx.out_dir, job.pdf_page)
    base_meta = {"run_id": ctx.run_id, "prompt_sha256": ctx.prompt_sha256}
    if not job.seg.boxes:
        obj = label_file(ctx.book, job, None, {**base_meta, "model": None})
        write_atomic(path, obj)
        append_runlog(ctx, {"pdf_page": job.pdf_page, "status": "ok", "model": None, "note": "no boxes, no model call"})
        return Result(job.pdf_page, "ok", time.time() - started, detail=summary_line(obj))

    request = build_request(ctx.book, job, ctx.system)
    attempts = args.retries + 1
    attempt = 1
    waits = 0
    last_text: str | None = None
    while True:
        text = None
        try:
            ctx.throttle.wait()
            text, message = call_model(ctx.client, request, model=args.model, max_tokens=args.max_tokens,
                                       effort=args.effort, fallback=not args.no_fallback)
            last_text = text
            label = parse_json(text)
            warnings = validate_label(label, len(job.seg.boxes))
        except FatalError as e:
            append_runlog(ctx, {"pdf_page": job.pdf_page, "status": "refused", "attempt": attempt, "error": str(e)})
            write_failed(ctx, job.pdf_page, str(e), text)
            return Result(job.pdf_page, "refused", time.time() - started, error=str(e))
        except (anthropic.BadRequestError, anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                anthropic.NotFoundError) as e:
            err = f"{type(e).__name__}: {str(e).splitlines()[0][:300]}"
            append_runlog(ctx, {"pdf_page": job.pdf_page, "status": "error", "attempt": attempt, "error": err})
            write_failed(ctx, job.pdf_page, err, text)
            return Result(job.pdf_page, "failed", time.time() - started, error=err + " (not retried)")
        except (anthropic.RateLimitError, anthropic.OverloadedError) as e:
            waits += 1
            delay = retry_after_seconds(e, min(args.backoff * 2 ** min(waits, 6), 300)) + random.uniform(0, 2)
            append_runlog(ctx, {"pdf_page": job.pdf_page, "status": "rate_limited", "wait": waits, "delay": round(delay, 1)})
            if ctx.throttle.back_off(delay):
                say(f"  {type(e).__name__} on s{job.pdf_page:04d}: all workers pausing {delay:.0f}s", err=True)
            if waits >= MAX_RATE_LIMIT_WAITS:
                err = f"{type(e).__name__}: gave up after {waits} rate-limit waits"
                write_failed(ctx, job.pdf_page, err, last_text)
                return Result(job.pdf_page, "failed", time.time() - started, error=err)
            continue
        except (RetryableError, anthropic.APIConnectionError, anthropic.APIStatusError,
                json.JSONDecodeError, jsonschema.ValidationError) as e:
            reason = (e.message if isinstance(e, jsonschema.ValidationError) else str(e)).splitlines()[0][:300]
            err = f"{type(e).__name__}: {reason}"
            append_runlog(ctx, {"pdf_page": job.pdf_page, "status": "retry" if attempt < attempts else "failed",
                                "attempt": attempt, "error": err})
            if attempt >= attempts:
                write_failed(ctx, job.pdf_page, f"{err} (after {attempts} attempts)", last_text)
                return Result(job.pdf_page, "failed", time.time() - started, error=f"{err} (after {attempts} attempts)")
            delay = min(args.backoff * 2 ** (attempt - 1), 120) + random.uniform(0, 2)
            say(f"  s{job.pdf_page:04d} attempt {attempt} failed ({err}); retrying in {delay:.0f}s", err=True)
            attempt += 1
            time.sleep(delay)
            continue

        usage = message.usage
        cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
        cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
        cost = cost_usd(message.model, usage.input_tokens, usage.output_tokens, cache_read, cache_write)
        obj = label_file(ctx.book, job, label, {**base_meta, "model": message.model, "effort": args.effort})
        write_atomic(path, obj)
        failed = ctx.out_dir / "_failed" / f"s{job.pdf_page:04d}.txt"
        if failed.exists():
            failed.unlink()
        seconds = time.time() - started
        append_runlog(ctx, {
            "pdf_page": job.pdf_page, "status": "ok", "attempt": attempt, "model": message.model, "effort": args.effort,
            "prompt_sha256": ctx.prompt_sha256, "seconds": round(seconds, 1), "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens, "cache_read": cache_read, "cache_write": cache_write,
            "cost_usd": round(cost, 4) if cost is not None else None, "warnings": warnings,
            "request_id": getattr(message, "_request_id", None),
        })
        return Result(job.pdf_page, "ok", seconds, usage.input_tokens, usage.output_tokens, cost, summary_line(obj), warnings)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", nargs="*", help="PDF page numbers: 60, 2-220, 3,60")
    ap.add_argument("--book", required=True, choices=sorted(ARTBOOKS), help="art book id from config/books.json")
    ap.add_argument("--pages-from", type=Path, help="file with page numbers/ranges (# comments)")
    ap.add_argument("--out", type=Path, help="output directory (default out/<book>)")
    ap.add_argument("--dry-run", action="store_true", help="segment and build requests, write the box images to "
                    "<out>/_boxes/, no API call")
    ap.add_argument("--force", action="store_true", help="re-run spreads that already have valid output")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--backoff", type=float, default=5.0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--no-fallback", action="store_true", help="disable server-side refusal fallback")
    ap.add_argument("--run-id")
    args = ap.parse_args()

    book = ARTBOOKS[args.book]
    out_dir = (args.out if args.out and args.out.is_absolute() else ROOT / args.out) if args.out else ROOT / "out" / book.key
    specs = list(args.pages) + (read_pages_file(args.pages_from) if args.pages_from else [])
    if not specs:
        ap.error("give at least one PDF page / range or --pages-from")
    pages = parse_pages(specs)
    bad = [p for p in pages if not 1 <= p <= book.page_count]
    if bad:
        sys.exit(f"PDF pages {bad} are outside {book.key} (1..{book.page_count})")
    missing = [p for p in pages if not book.image_path(p).exists()]
    if missing:
        sys.exit(f"missing spread files for PDF pages {missing[:10]}: run scripts/art_export.py --book {book.key}")

    if not args.force and not args.dry_run:
        done = [p for p in pages if existing_valid(out_dir, p) is True]
        if done:
            print(f"skipping {len(done)} spread(s) with valid output (use --force to redo)")
        pages = [p for p in pages if p not in done]
    if not pages:
        print("nothing to do")
        return

    contents = book.contents()
    if not contents:
        print(f"warning: no contents file at {book.contents_path}; the model gets no chapter context", file=sys.stderr)
    jobs = [SpreadJob(p, book.folios(p), book.contents_entries(p, contents), segment(book.image_path(p))) for p in pages]
    system = load_prompt_body()
    prompt_sha256 = hashlib.sha256(system.encode("utf-8")).hexdigest()

    if args.dry_run:
        boxes_dir = out_dir / "_boxes"
        boxes_dir.mkdir(parents=True, exist_ok=True)
        for j in jobs:
            req = build_request(book, j, system)
            kb = sum(len(c["source"]["data"]) for c in req["messages"][0]["content"] if c["type"] == "image") // 1024
            draw_boxes(book.image_path(j.pdf_page), j.seg.boxes, BOXES_WIDTH).save(boxes_dir / f"s{j.pdf_page:04d}.jpg", quality=85)
            print(f"s{j.pdf_page:04d} {j.folios} {j.seg.mode} {len(j.seg.boxes)} box(es), images {kb} KB base64")
            print("   " + context_text(book, j).replace("\n", "\n   "))
        print(f"\ndry run: box images in {boxes_dir}; no API calls")
        return

    load_dotenv()
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("no credentials: set ANTHROPIC_API_KEY in the environment or .env")
    out_dir.mkdir(parents=True, exist_ok=True)
    client = anthropic.Anthropic(max_retries=0, timeout=600.0)
    run_id = args.run_id or (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    ctx = RunContext(book, client, out_dir, args, run_id, system, prompt_sha256)
    print(f"run {run_id}: model={args.model} effort={args.effort} workers={args.workers} prompt={prompt_sha256[:12]}"
          f"  ->  {out_dir}  ({len(jobs)} spread(s))" + ("" if price_for(args.model) else "  (no price entry)"))
    append_runlog(ctx, {"event": "run_start", "model": args.model, "effort": args.effort, "spreads": len(jobs),
                        "prompt_sha256": prompt_sha256})

    results: list[Result] = []
    started = time.time()
    interrupted = False
    pool = ThreadPoolExecutor(max_workers=args.workers)
    try:
        futures = [pool.submit(run_spread, j, ctx) for j in jobs]
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            if r.status == "ok":
                line = (f"[{len(results)}/{len(jobs)}] s{r.pdf_page:04d} ok {r.seconds:.0f}s "
                        f"{fmt_tokens(r.input_tokens)}/{fmt_tokens(r.output_tokens)} tok  {r.detail}"
                        + (f" ${r.cost:.3f}" if r.cost is not None else ""))
                if r.warnings:
                    line += "\n     warnings: " + "; ".join(r.warnings)
            else:
                line = f"[{len(results)}/{len(jobs)}] s{r.pdf_page:04d} {r.status.upper()} {r.seconds:.0f}s  {r.error}"
            say(line)
    except KeyboardInterrupt:
        interrupted = True
        say("\ninterrupted: waiting for in-flight spreads to finish", err=True)
        pool.shutdown(wait=True, cancel_futures=True)
    finally:
        pool.shutdown(wait=True)

    ok = [r for r in results if r.status == "ok"]
    failed = [r for r in results if r.status != "ok"]
    known = [r.cost for r in ok if r.cost is not None]
    total = sum(known) if known else None
    wall = time.time() - started
    print(f"\nrun {run_id} summary ({'interrupted' if interrupted else 'complete'}): {len(ok)} ok, {len(failed)} failed")
    print(f"  tokens: {sum(r.input_tokens for r in ok):,} in / {sum(r.output_tokens for r in ok):,} out")
    if total is not None and known:
        print(f"  cost: ${total:.2f} estimated (${total / len(known):.3f}/spread; "
              f"${total / len(known) * (book.page_count - 1):.0f} for all {book.page_count - 1} spreads of {book.key})")
    print(f"  wall time: {fmt_duration(wall)}")
    if failed:
        print(f"  failed (see {out_dir / '_failed'}): {[r.pdf_page for r in failed]}")
    append_runlog(ctx, {"event": "run_end", "ok": len(ok), "failed": len(failed),
                        "cost_usd": round(total, 4) if total is not None else None, "seconds": round(wall, 1)})
    sys.exit(1 if failed or interrupted else 0)


if __name__ == "__main__":
    main()
