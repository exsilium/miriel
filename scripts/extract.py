"""Run the page-extraction prompt over pages of a book and write out/<book>/p{PAGE:04d}.json.

Pages are always given as PRINTED page numbers (see scripts/pages.py for the mapping).

Books come from config/books.json (--book is required; source files are read from DATA_DIR, see scripts/pages.py).

Examples:
  uv run python scripts/extract.py --book vol1 159                    # one page
  uv run python scripts/extract.py --book vol1 --workers 4 1-513      # the whole book, 4 pages in flight
  uv run python scripts/extract.py --book vol1 --pages-from retakes.txt --force   # redo listed pages
  uv run python scripts/extract.py --book vol1 --fixture --dry-run    # build requests for test-pages/vol1/, no API call
  uv run python scripts/extract.py --book vol1 --fixture              # run the fixture pages (scripts/build_fixture.py)
  uv run python scripts/extract.py --book vol1 --retake-report        # list pages flagged for a re-shoot

Resumable and idempotent: a page whose output file exists and validates is skipped unless --force is given.
Kill the run at any time; output files are written atomically and the next run continues where it stopped.
Every run appends to out/<book>/_runlog.jsonl (one record per attempt, tagged with run_id) and prints a
cost summary. Pages that fail after all retries leave out/<book>/_failed/pNNNN.txt (error + raw model text).

Credentials: ANTHROPIC_API_KEY in the environment, or in a `.env` file at the repo root
(one `KEY=value` per line; .env is gitignored). Environment variables win over .env.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import anthropic
import jsonschema
import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, ROOT, Book  # noqa: E402
from schema import PAGE_SCHEMA  # noqa: E402

PROMPT_PATH = ROOT / "prompts" / "page-extraction-prompt.md"
DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_MAX_TOKENS = 32000
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RATE_LIMIT_WAITS = 30   # per page; rate-limit pauses do not consume the page's retry budget

# USD per million tokens (input, output). Cache reads bill at 0.1x input, cache writes at 1.25x input.
# Longest key wins on prefix match, so a dated model id still prices.
PRICES_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-opus-4-7": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}

_log_lock = threading.Lock()
_print_lock = threading.Lock()


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """Minimal .env support: KEY=value lines, '#' comments, optional surrounding quotes. Never overrides the environment."""
    if not path.exists():
        return
    import os
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def say(msg: str, *, err: bool = False) -> None:
    with _print_lock:
        print(msg, file=sys.stderr if err else sys.stdout, flush=True)


# ----------------------------------------------------------------------------- prompt

def load_prompt_body(path: Path = PROMPT_PATH) -> str:
    """Return the model-facing part of the prompt file: everything after the first `---` line.

    The text above the rule is operator documentation (file paths, test-run checklist)."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "---":
            body = "\n".join(lines[i + 1:]).strip() + "\n"
            break
    else:
        sys.exit(f"{path}: no `---` separator found; cannot locate the model prompt")
    for var in ("{{BOOK}}", "{{PAGE}}"):
        if var not in body:
            sys.exit(f"{path}: template variable {var} not found in prompt body")
    return body


def fill_prompt(body: str, book: Book, page: int) -> str:
    return body.replace("{{BOOK}}", book.name).replace("{{PAGE}}", str(page))


# ----------------------------------------------------------------------------- pricing

def price_for(model: str) -> tuple[float, float] | None:
    for key in sorted(PRICES_USD_PER_MTOK, key=len, reverse=True):
        if model == key or model.startswith(key + "-"):
            return PRICES_USD_PER_MTOK[key]
    return None


def cost_usd(model: str, input_tokens: int, output_tokens: int, cache_read: int = 0, cache_write: int = 0) -> float | None:
    p = price_for(model)
    if p is None:
        return None
    pin, pout = p
    return (input_tokens * pin + cache_read * pin * 0.1 + cache_write * pin * 1.25 + output_tokens * pout) / 1_000_000


# ----------------------------------------------------------------------------- sources

class Source:
    """Resolves a printed page number to OCR text and an image file."""

    def __init__(self, book: Book, pdf_path: Path, index_of: dict[int, int], image_of: dict[int, Path]):
        self.book = book
        self.pdf_path = pdf_path
        self.doc = pymupdf.open(pdf_path)
        self._index_of = index_of          # printed page -> index in self.doc
        self._image_of = image_of          # printed page -> image path
        self._lock = threading.Lock()      # pymupdf documents are not thread-safe

    @classmethod
    def for_book(cls, book: Book, pages: list[int]) -> "Source":
        return cls(book, book.pdf, {p: book.pdf_index(p) for p in pages}, {p: book.image_path(p) for p in pages})

    @classmethod
    def for_fixture(cls, book: Book) -> "Source":
        if not book.fixture_manifest.exists() or not book.fixture_pdf.exists():
            sys.exit(f"fixture for {book.key} not built; run scripts/build_fixture.py --book {book.key} --pages ... first")
        manifest = json.loads(book.fixture_manifest.read_text(encoding="utf-8"))
        if manifest.get("book") != book.key:
            sys.exit(f"{book.fixture_manifest} is for book {manifest.get('book')!r}, not {book.key!r}")
        index_of = {e["printed_page"]: e["fixture_index"] for e in manifest["pages"]}
        image_of = {e["printed_page"]: book.fixture_dir / e["image"] for e in manifest["pages"]}
        return cls(book, book.fixture_pdf, index_of, image_of)

    @property
    def pages(self) -> list[int]:
        return list(self._index_of)

    def pdf_index(self, page: int) -> int:
        return self._index_of[page]

    def ocr_text(self, page: int) -> str:
        # "text" mode keeps the OCR layer's line order; pymupdf returns "" for image-only pages.
        with self._lock:
            return self.doc[self._index_of[page]].get_text("text").strip()

    def image_path(self, page: int) -> Path:
        return self._image_of[page]


# ----------------------------------------------------------------------------- request

@dataclass
class PageJob:
    page: int
    pdf_index: int
    image_path: Path
    ocr_text: str
    prompt: str


def build_request(job: PageJob, image_bytes: bytes) -> dict:
    """System prompt = the filled extraction prompt; user turn = the page image, then the OCR text."""
    ocr_block = job.ocr_text if job.ocr_text else "(The PDF has no OCR text layer for this page.)"
    return {
        "system": job.prompt,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                             "data": base64.standard_b64encode(image_bytes).decode("ascii")}},
                {"type": "text", "text": f"OCR text for page {job.page}:\n\n{ocr_block}"},
            ],
        }],
    }


class RetryableError(Exception):
    pass


class FatalError(Exception):
    pass


def call_model(client: anthropic.Anthropic, request: dict, *, model: str, max_tokens: int, effort: str,
               fallback: bool) -> tuple[str, anthropic.types.Message]:
    kwargs = dict(model=model, max_tokens=max_tokens, thinking={"type": "adaptive"},
                  output_config={"effort": effort}, **request)
    if fallback:
        # Server-side refusal fallback: if the model declines, the API re-runs on a fallback model in the same call.
        ctx = client.beta.messages.stream(betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
    else:
        ctx = client.messages.stream(**kwargs)
    with ctx as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        details = getattr(message, "stop_details", None)
        raise FatalError(f"model refused: {getattr(details, 'category', None)} {getattr(details, 'explanation', '')}".strip())
    if message.stop_reason == "max_tokens":
        raise RetryableError(f"hit max_tokens={max_tokens}; raise --max-tokens")
    text = "".join(b.text for b in message.content if b.type == "text")
    if not text.strip():
        raise RetryableError(f"empty text response (stop_reason={message.stop_reason})")
    return text, message


# ----------------------------------------------------------------------------- shared rate-limit gate

class Throttle:
    """One pause shared by every worker: a 429/529 on any worker holds all of them back."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pause_until = 0.0
        self.pauses = 0

    def wait(self) -> None:
        while True:
            with self._lock:
                remaining = self._pause_until - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 1.0))

    def back_off(self, seconds: float) -> bool:
        """Extend the shared pause. Returns True if this call lengthened it (so the caller should announce it)."""
        with self._lock:
            until = time.monotonic() + seconds
            if until > self._pause_until + 0.5:
                self._pause_until = until
                self.pauses += 1
                return True
            return False


def retry_after_seconds(e: anthropic.APIStatusError, default: float) -> float:
    try:
        raw = e.response.headers.get("retry-after")
        if raw:
            return min(max(float(raw), 1.0), 300.0)
    except Exception:  # noqa: BLE001 - header parsing is best effort
        pass
    return default


# ----------------------------------------------------------------------------- parse & validate

_FENCE = re.compile(r"^\s*```(?:json)?\s*\n(.*)\n\s*```\s*$", re.S)


def parse_json(text: str) -> dict:
    m = _FENCE.match(text)
    if m:
        text = m.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Salvage: take the outermost object if the model wrapped it in prose.
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(text[start:end + 1])


def validate(obj: dict, page: int, book: Book) -> list[str]:
    """Raise on schema violations; return soft warnings for the review step."""
    jsonschema.validate(obj, PAGE_SCHEMA)
    if obj["page"] != page:
        raise jsonschema.ValidationError(f"page is {obj['page']}, expected {page}")
    if obj["book"] != book.name:
        raise jsonschema.ValidationError(f"book is {obj['book']!r}, expected {book.name!r}")

    warnings: list[str] = []
    md = obj["markdown"]
    q = obj["quality"]
    n_illegible = md.count("[illegible]")
    if n_illegible != q["illegible_regions"]:
        warnings.append(f"illegible_regions={q['illegible_regions']} but markdown has {n_illegible} [illegible] markers")
    placeholders = [int(n) for n in re.findall(r"\[FIGURE (\d+)", md)]
    if placeholders and max(placeholders) > len(obj["figures"]):
        warnings.append(f"markdown references FIGURE {max(placeholders)} but only {len(obj['figures'])} figures listed")
    if len(obj["figures"]) > len(set(placeholders)):
        warnings.append(f"{len(obj['figures'])} figures but only {len(set(placeholders))} distinct [FIGURE n] placeholders")
    missing = [e["name"] for e in obj["entities"] if e["name"] not in md]
    if missing:
        warnings.append(f"{len(missing)} entity name(s) not found verbatim in markdown: {missing[:8]}")
    if q["image_quality"] in ("poor", "unusable") and not q["retake_recommended"]:
        warnings.append(f"image_quality={q['image_quality']} but retake_recommended=false")
    if q["retake_recommended"] and not q["retake_reason"]:
        warnings.append("retake_recommended=true without retake_reason")
    return warnings


def out_path(out_dir: Path, page: int) -> Path:
    return out_dir / f"p{page:04d}.json"


def failed_path(out_dir: Path, page: int) -> Path:
    return out_dir / "_failed" / f"p{page:04d}.txt"


def existing_output_valid(out_dir: Path, page: int, book: Book) -> bool | None:
    """None = no file; True = file exists and validates; False = file exists but is invalid (redo it)."""
    path = out_path(out_dir, page)
    if not path.exists():
        return None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        validate(obj, page, book)
        return True
    except (json.JSONDecodeError, jsonschema.ValidationError, KeyError, TypeError):
        return False


# ----------------------------------------------------------------------------- run one page

@dataclass
class RunContext:
    book: Book
    client: anthropic.Anthropic
    out_dir: Path
    args: argparse.Namespace
    run_id: str
    prompt_sha256: str
    throttle: Throttle = field(default_factory=Throttle)


@dataclass
class PageResult:
    page: int
    status: str                     # ok | failed | refused
    seconds: float
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    cost: float | None = None
    model: str | None = None
    retake: bool | None = None
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    detail: str = ""


def append_runlog(ctx: RunContext, record: dict) -> None:
    record = {"run_id": ctx.run_id, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}
    with _log_lock:
        with (ctx.out_dir / "_runlog.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def write_failed(ctx: RunContext, page: int, error: str, text: str | None) -> None:
    path = failed_path(ctx.out_dir, page)
    path.parent.mkdir(exist_ok=True)
    body = f"page: {page}\nrun_id: {ctx.run_id}\nmodel: {ctx.args.model}\nerror: {error}\n\n----- raw model text -----\n{text or '(no model text)'}\n"
    path.write_text(body, encoding="utf-8")


def run_page(job: PageJob, ctx: RunContext) -> PageResult:
    args = ctx.args
    image_bytes = job.image_path.read_bytes()
    request = build_request(job, image_bytes)
    attempts = args.retries + 1
    attempt = 1
    rate_limit_waits = 0
    started = time.time()
    last_text: str | None = None

    while True:
        text = None
        try:
            ctx.throttle.wait()
            text, message = call_model(ctx.client, request, model=args.model, max_tokens=args.max_tokens,
                                       effort=args.effort, fallback=not args.no_fallback)
            last_text = text
            obj = parse_json(text)
            warnings = validate(obj, job.page, ctx.book)

        except FatalError as e:
            append_runlog(ctx, {"page": job.page, "status": "refused", "attempt": attempt, "effort": args.effort,
                                "prompt_sha256": ctx.prompt_sha256, "error": str(e)})
            write_failed(ctx, job.page, str(e), text)
            return PageResult(job.page, "refused", time.time() - started, error=str(e))

        except (anthropic.BadRequestError, anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                anthropic.NotFoundError) as e:
            err = f"{type(e).__name__}: {str(e).splitlines()[0][:300]}"
            append_runlog(ctx, {"page": job.page, "status": "error", "attempt": attempt, "effort": args.effort,
                                "prompt_sha256": ctx.prompt_sha256, "error": err})
            write_failed(ctx, job.page, err, text)
            return PageResult(job.page, "failed", time.time() - started, error=err + " (not retried)")

        except (anthropic.RateLimitError, anthropic.OverloadedError) as e:
            # Shared back-off: every worker pauses. These waits do not consume the page's retry budget.
            rate_limit_waits += 1
            delay = retry_after_seconds(e, min(args.backoff * 2 ** min(rate_limit_waits, 6), 300)) + random.uniform(0, 2)
            append_runlog(ctx, {"page": job.page, "status": "rate_limited", "attempt": attempt, "wait": rate_limit_waits,
                                "error": f"{type(e).__name__}: {e.status_code}", "delay": round(delay, 1)})
            if ctx.throttle.back_off(delay):
                say(f"  {type(e).__name__} on p{job.page:04d}: all workers pausing {delay:.0f}s", err=True)
            if rate_limit_waits >= MAX_RATE_LIMIT_WAITS:
                err = f"{type(e).__name__}: gave up after {rate_limit_waits} rate-limit waits"
                write_failed(ctx, job.page, err, last_text)
                return PageResult(job.page, "failed", time.time() - started, error=err)
            continue

        except (RetryableError, anthropic.APIConnectionError, anthropic.APIStatusError,
                json.JSONDecodeError, jsonschema.ValidationError) as e:
            reason = e.message if isinstance(e, jsonschema.ValidationError) else str(e)
            reason = reason.splitlines()[0][:300]
            err = f"{type(e).__name__}: {reason}"
            append_runlog(ctx, {"page": job.page, "status": "retry" if attempt < attempts else "failed",
                                "attempt": attempt, "effort": args.effort, "prompt_sha256": ctx.prompt_sha256, "error": err})
            if attempt >= attempts:
                write_failed(ctx, job.page, f"{err} (after {attempts} attempts)", last_text)
                return PageResult(job.page, "failed", time.time() - started, error=f"{err} (after {attempts} attempts)")
            delay = min(args.backoff * 2 ** (attempt - 1), 120) + random.uniform(0, 2)
            say(f"  p{job.page:04d} attempt {attempt} failed ({err}); retrying in {delay:.0f}s", err=True)
            attempt += 1
            time.sleep(delay)
            continue

        # success
        path = out_path(ctx.out_dir, job.page)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
        fp = failed_path(ctx.out_dir, job.page)
        if fp.exists():
            fp.unlink()
        usage = message.usage
        cache_read = getattr(usage, "cache_read_input_tokens", None) or 0
        cache_write = getattr(usage, "cache_creation_input_tokens", None) or 0
        cost = cost_usd(message.model, usage.input_tokens, usage.output_tokens, cache_read, cache_write)
        q = obj["quality"]
        seconds = time.time() - started
        append_runlog(ctx, {
            "page": job.page, "status": "ok", "attempt": attempt, "model": message.model, "effort": args.effort,
            "prompt_sha256": ctx.prompt_sha256, "stop_reason": message.stop_reason, "seconds": round(seconds, 1),
            "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
            "cache_read": cache_read, "cache_write": cache_write,
            "cost_usd": round(cost, 4) if cost is not None else None,
            "image_quality": q["image_quality"], "retake": q["retake_recommended"],
            "ocr_agreement": q["ocr_agreement"], "warnings": warnings,
            "request_id": getattr(message, "_request_id", None),
        })
        detail = (f"type={obj['page_type']} quality={q['image_quality']} ocr={q['ocr_agreement']} "
                  f"figs={len(obj['figures'])} ents={len(obj['entities'])}")
        return PageResult(job.page, "ok", seconds, usage.input_tokens, usage.output_tokens, cache_read, cache_write,
                          cost, message.model, q["retake_recommended"], warnings, detail=detail)


# ----------------------------------------------------------------------------- dry run

def dry_run(jobs: list[PageJob], source: Source, out_dir: Path, book: Book, show_prompt: bool) -> None:
    print(f"pdf: {source.pdf_path.name}\nout: {out_dir}\n")
    print(f"{'printed':>7} {'pdf_idx':>7}  {'image':<45} {'dims':>10} {'jpeg_kb':>7} {'b64_kb':>6} {'ocr_chars':>9} {'output':>8}")
    for job in jobs:
        data = job.image_path.read_bytes()
        with Image.open(job.image_path) as im:
            dims = f"{im.width}x{im.height}"
        state = existing_output_valid(out_dir, job.page, book)
        exists = "-" if state is None else ("valid" if state else "INVALID")
        print(f"{job.page:>7} {job.pdf_index:>7}  {job.image_path.name:<45} {dims:>10} {len(data) // 1024:>7} "
              f"{len(base64.standard_b64encode(data)) // 1024:>6} {len(job.ocr_text):>9} {exists:>8}")
        if not job.ocr_text:
            print("         (no OCR text layer; the model will get a note saying so)")
    if show_prompt:
        print("\n----- filled system prompt for the first page -----\n")
        print(jobs[0].prompt)
        print("----- OCR text block (first 600 chars) -----\n")
        print(f"OCR text for page {jobs[0].page}:\n\n{jobs[0].ocr_text[:600]}")
    print("\ndry run: no API calls made, nothing written.")


# ----------------------------------------------------------------------------- retake report

def retake_report(out_dir: Path) -> int:
    files = sorted(out_dir.glob("p[0-9][0-9][0-9][0-9].json"))
    if not files:
        print(f"no extracted pages in {out_dir}")
        return 0
    retakes, reocr, bad = [], [], []
    for f in files:
        try:
            obj = json.loads(f.read_text(encoding="utf-8"))
            q = obj["quality"]
        except (json.JSONDecodeError, KeyError) as e:
            bad.append((f.name, str(e)))
            continue
        if q.get("retake_recommended"):
            retakes.append((obj["page"], q))
        elif q.get("ocr_agreement") == "low" and q.get("image_quality") in ("good", "usable"):
            reocr.append((obj["page"], q))
    print(f"{len(files)} pages extracted, {len(retakes)} flagged for retake, {len(reocr)} re-OCR only\n")
    if retakes:
        print(f"{'page':>5}  {'quality':<8} {'issues':<28} retake_reason")
        for page, q in retakes:
            issues = ",".join(q.get("quality_issues") or []) or "-"
            print(f"{page:>5}  {q['image_quality']:<8} {issues[:28]:<28} {q.get('retake_reason') or '(no reason given)'}")
            if q.get("affected_areas"):
                print(f"{'':>5}  {'':<8} {'':<28} area: {q['affected_areas']}")
    if reocr:
        print("\nLow OCR agreement on a readable image (re-OCR, not re-shoot):")
        for page, q in reocr:
            print(f"{page:>5}  {q.get('notes') or ''}")
    if bad:
        print("\nUnreadable output files:")
        for name, err in bad:
            print(f"  {name}: {err}")
    return len(retakes)


# ----------------------------------------------------------------------------- cli

def parse_pages(specs: list[str]) -> list[int]:
    pages: list[int] = []
    for spec in specs:
        for part in spec.replace(",", " ").split():
            if "-" in part:
                a, b = (int(x) for x in part.split("-", 1))
                if b < a:
                    sys.exit(f"bad range {part!r}")
                pages.extend(range(a, b + 1))
            else:
                pages.append(int(part))
    seen: set[int] = set()
    ordered: list[int] = []
    for p in pages:
        if p not in seen:
            seen.add(p)
            ordered.append(p)
    return ordered


def read_pages_file(path: Path) -> list[str]:
    """Page specs from a file: whitespace/comma separated, ranges allowed, '#' starts a comment."""
    if not path.exists():
        sys.exit(f"--pages-from: {path} not found")
    specs: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            specs.append(line)
    return specs


def fmt_tokens(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m{s:02d}s" if h else (f"{m}m{s:02d}s" if m else f"{s}s")


def main() -> None:
    # Windows consoles default to cp1252; page content in summaries and warnings can contain any Unicode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", nargs="*", help="printed page numbers: 159, 40-60, 73,316")
    ap.add_argument("--book", required=True, choices=sorted(BOOKS), help="book id from config/books.json")
    ap.add_argument("--pages-from", type=Path, help="file with page numbers/ranges (one or more per line; # comments)")
    ap.add_argument("--fixture", action="store_true", help="use test-pages/<book>/ (pages filter optional)")
    ap.add_argument("--out", type=Path, help="output directory (default out/<book>)")
    ap.add_argument("--dry-run", action="store_true", help="build requests and report sizes; no API calls, no writes")
    ap.add_argument("--show-prompt", action="store_true", help="with --dry-run: print the filled prompt for the first page")
    ap.add_argument("--force", action="store_true", help="re-run pages that already have valid output")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    ap.add_argument("--retries", type=int, default=3, help="extra attempts after a retryable failure (default 3)")
    ap.add_argument("--backoff", type=float, default=5.0, help="base seconds for retry backoff (default 5)")
    ap.add_argument("--workers", type=int, default=1, help="concurrent pages (default 1)")
    ap.add_argument("--no-fallback", action="store_true", help="disable server-side refusal fallback")
    ap.add_argument("--retake-report", action="store_true", help="print pages with quality.retake_recommended=true and exit")
    args = ap.parse_args()

    book = BOOKS[args.book]
    out_dir = args.out or (ROOT / "out" / book.key)

    if args.retake_report:
        retake_report(out_dir)
        return

    specs = list(args.pages)
    if args.pages_from:
        specs += read_pages_file(args.pages_from)

    if args.fixture:
        source = Source.for_fixture(book)
        pages = parse_pages(specs) if specs else source.pages
        unknown = [p for p in pages if p not in source.pages]
        if unknown:
            sys.exit(f"pages {unknown} are not in the fixture (fixture has {source.pages})")
    else:
        if not specs:
            ap.error("give at least one page / range, --pages-from, --fixture, or --retake-report")
        pages = parse_pages(specs)
        try:
            source = Source.for_book(book, pages)
        except ValueError as e:
            sys.exit(str(e))

    body = load_prompt_body()
    prompt_sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
    jobs = []
    for p in pages:
        img = source.image_path(p)
        if not img.exists():
            sys.exit(f"missing image for printed page {p}: {img} (is DATA_DIR right?)")
        jobs.append(PageJob(page=p, pdf_index=source.pdf_index(p), image_path=img,
                            ocr_text=source.ocr_text(p), prompt=fill_prompt(body, book, p)))

    if args.dry_run:
        dry_run(jobs, source, out_dir, book, args.show_prompt)
        return

    skipped: list[int] = []
    invalid: list[int] = []
    if not args.force:
        keep = []
        for j in jobs:
            state = existing_output_valid(out_dir, j.page, book)
            if state is True:
                skipped.append(j.page)
            else:
                if state is False:
                    invalid.append(j.page)
                keep.append(j)
        jobs = keep
        if skipped:
            more = "..." if len(skipped) > 20 else ""
            print(f"skipping {len(skipped)} page(s) with valid output (use --force to redo): {skipped[:20]}{more}")
        if invalid:
            print(f"redoing {len(invalid)} page(s) whose existing output is invalid: {invalid[:20]}")
    if not jobs:
        print("nothing to do")
        return

    load_dotenv()
    import os
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("no credentials: set ANTHROPIC_API_KEY in the environment or put ANTHROPIC_API_KEY=... in .env at the repo root")
    out_dir.mkdir(parents=True, exist_ok=True)
    # max_retries=0: the runner owns retries so a 429 on one worker can pause all of them.
    client = anthropic.Anthropic(max_retries=0, timeout=600.0)
    run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    ctx = RunContext(book=book, client=client, out_dir=out_dir, args=args, run_id=run_id, prompt_sha256=prompt_sha256)
    total = len(jobs)
    unit_price = price_for(args.model)
    print(f"run {run_id}: model={args.model} effort={args.effort} max_tokens={args.max_tokens} workers={args.workers} "
          f"fallback={'off' if args.no_fallback else 'on'} prompt={prompt_sha256[:12]}  ->  {out_dir}  ({total} page(s))"
          + ("" if unit_price else f"\n  (no price table entry for {args.model}; cost will not be estimated)"))
    append_runlog(ctx, {"event": "run_start", "model": args.model, "effort": args.effort, "workers": args.workers,
                        "prompt_sha256": prompt_sha256, "pages": total, "skipped": len(skipped)})

    results: list[PageResult] = []
    started = time.time()
    interrupted = False
    pool = ThreadPoolExecutor(max_workers=args.workers)
    try:
        futures = {pool.submit(run_page, j, ctx): j for j in jobs}
        for fut in as_completed(futures):
            r = fut.result()
            results.append(r)
            done = len(results)
            if r.status == "ok":
                line = (f"[{done}/{total}] p{r.page:04d} ok {r.seconds:.0f}s {fmt_tokens(r.input_tokens)}/{fmt_tokens(r.output_tokens)} tok "
                        f"retake={'yes' if r.retake else 'no'}  {r.detail}")
                if r.cost is not None:
                    line += f" ${r.cost:.3f}"
                if r.warnings:
                    line += "\n     warnings: " + "; ".join(r.warnings)
            else:
                line = f"[{done}/{total}] p{r.page:04d} {r.status.upper()} {r.seconds:.0f}s  {r.error}"
            say(line)
    except KeyboardInterrupt:
        interrupted = True
        say("\ninterrupted: waiting for in-flight pages to finish (they will be saved); pending pages are dropped", err=True)
        pool.shutdown(wait=True, cancel_futures=True)
    finally:
        pool.shutdown(wait=True)

    ok = [r for r in results if r.status == "ok"]
    failed = [r for r in results if r.status != "ok"]
    tin = sum(r.input_tokens for r in ok)
    tout = sum(r.output_tokens for r in ok)
    tcr = sum(r.cache_read for r in ok)
    known = [r.cost for r in ok if r.cost is not None]
    total_cost = sum(known) if known else None
    wall = time.time() - started
    not_run = total - len(results)
    print(f"\nrun {run_id} summary ({'interrupted' if interrupted else 'complete'}):")
    print(f"  pages: {len(ok)} ok, {len(failed)} failed, {len(skipped)} skipped (valid output existed)"
          + (f", {not_run} not started" if not_run else ""))
    print(f"  tokens: {tin:,} in / {tout:,} out" + (f" / {tcr:,} cache read" if tcr else "")
          + (f"  (avg {tin // len(ok):,} / {tout // len(ok):,} per page)" if ok else ""))
    if total_cost is not None:
        per_page = total_cost / len(known)
        print(f"  cost: ${total_cost:.2f} estimated ({len(known)} page(s), ${per_page:.3f}/page"
              + (f"; ${per_page * len(pages):.0f} for all {len(pages)} requested" if len(pages) > len(known) else "") + ")")
    print(f"  wall time: {fmt_duration(wall)}" + (f", {wall / len(results):.0f}s per page at {args.workers} worker(s)" if results else "")
          + (f", {ctx.throttle.pauses} rate-limit pause(s)" if ctx.throttle.pauses else ""))
    if failed:
        print(f"  failed pages (see {out_dir / '_failed'}): {[r.page for r in failed]}")
    append_runlog(ctx, {"event": "run_end", "interrupted": interrupted, "ok": len(ok), "failed": len(failed),
                        "skipped": len(skipped), "not_started": not_run, "input_tokens": tin, "output_tokens": tout,
                        "cost_usd": round(total_cost, 4) if total_cost is not None else None, "seconds": round(wall, 1)})
    sys.exit(1 if failed or interrupted else 0)


if __name__ == "__main__":
    main()
