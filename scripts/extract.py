"""Run the page-extraction prompt over pages of a book and write out/<book>/p{PAGE:04d}.json.

Pages are always given as PRINTED page numbers (see scripts/pages.py for the mapping).

Examples:
  uv run python scripts/extract.py 159                    # one page
  uv run python scripts/extract.py 40-60 73 316           # ranges and singles
  uv run python scripts/extract.py --fixture --dry-run    # build requests for test-pages/, no API call
  uv run python scripts/extract.py --fixture              # run the six fixture pages
  uv run python scripts/extract.py --fixture --force      # re-run even if output exists
  uv run python scripts/extract.py --retake-report        # list pages flagged for a re-shoot

Credentials: ANTHROPIC_API_KEY in the environment, or in a `.env` file at the repo root
(one `KEY=value` per line; .env is gitignored). Environment variables win over .env.
"""
from __future__ import annotations

import argparse
import base64
import json
import random
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import anthropic
import jsonschema
import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, FIXTURE_MANIFEST, FIXTURE_PDF, ROOT, Book  # noqa: E402
from schema import PAGE_SCHEMA  # noqa: E402

PROMPT_PATH = ROOT / "prompts" / "page-extraction-prompt.md"
DEFAULT_MODEL = "claude-opus-5"
DEFAULT_MAX_TOKENS = 32000
FALLBACK_BETA = "server-side-fallback-2026-07-01"

_log_lock = threading.Lock()


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


# ----------------------------------------------------------------------------- sources

class Source:
    """Resolves a printed page number to OCR text and an image file."""

    def __init__(self, book: Book, pdf_path: Path, index_of: dict[int, int], image_of: dict[int, Path]):
        self.book = book
        self.pdf_path = pdf_path
        self.doc = pymupdf.open(pdf_path)
        self._index_of = index_of          # printed page -> index in self.doc
        self._image_of = image_of          # printed page -> image path

    @classmethod
    def for_book(cls, book: Book, pages: list[int]) -> "Source":
        return cls(book, book.pdf, {p: book.pdf_index(p) for p in pages}, {p: book.image_path(p) for p in pages})

    @classmethod
    def for_fixture(cls, book: Book) -> "Source":
        if not FIXTURE_MANIFEST.exists() or not FIXTURE_PDF.exists():
            sys.exit("fixture not built; run scripts/build_fixture.py first")
        manifest = json.loads(FIXTURE_MANIFEST.read_text())
        index_of = {e["printed_page"]: e["fixture_index"] for e in manifest["pages"]}
        image_of = {e["printed_page"]: FIXTURE_MANIFEST.parent / e["image"] for e in manifest["pages"]}
        return cls(book, FIXTURE_PDF, index_of, image_of)

    @property
    def pages(self) -> list[int]:
        return list(self._index_of)

    def pdf_index(self, page: int) -> int:
        return self._index_of[page]

    def ocr_text(self, page: int) -> str:
        # "text" mode keeps the OCR layer's line order; pymupdf returns "" for image-only pages.
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


def validate(obj: dict, job: PageJob, book: Book) -> list[str]:
    """Raise on schema violations; return soft warnings for the review step."""
    jsonschema.validate(obj, PAGE_SCHEMA)
    if obj["page"] != job.page:
        raise jsonschema.ValidationError(f"page is {obj['page']}, expected {job.page}")
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


# ----------------------------------------------------------------------------- run one page

def out_path(out_dir: Path, page: int) -> Path:
    return out_dir / f"p{page:04d}.json"


def append_runlog(out_dir: Path, record: dict) -> None:
    with _log_lock:
        with (out_dir / "_runlog.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")


def run_page(job: PageJob, *, book: Book, client: anthropic.Anthropic, out_dir: Path, args) -> tuple[int, str]:
    image_bytes = job.image_path.read_bytes()
    request = build_request(job, image_bytes)
    attempts = args.retries + 1
    started = time.time()
    for attempt in range(1, attempts + 1):
        text = None
        try:
            text, message = call_model(client, request, model=args.model, max_tokens=args.max_tokens,
                                       effort=args.effort, fallback=not args.no_fallback)
            obj = parse_json(text)
            warnings = validate(obj, job, book)
        except FatalError as e:
            append_runlog(out_dir, {"page": job.page, "status": "refused", "attempt": attempt, "error": str(e)})
            return job.page, f"FAILED (not retried): {e}"
        except (anthropic.BadRequestError, anthropic.AuthenticationError, anthropic.PermissionDeniedError,
                anthropic.NotFoundError) as e:
            append_runlog(out_dir, {"page": job.page, "status": "error", "attempt": attempt, "error": str(e)})
            return job.page, f"FAILED (not retried): {e}"
        except (RetryableError, anthropic.APIConnectionError, anthropic.APIStatusError,
                json.JSONDecodeError, jsonschema.ValidationError) as e:
            reason = e.message if isinstance(e, jsonschema.ValidationError) else str(e)
            reason = reason.splitlines()[0][:300]
            if text is not None:
                failed_dir = out_dir / "_failed"
                failed_dir.mkdir(exist_ok=True)
                (failed_dir / f"p{job.page:04d}.attempt{attempt}.txt").write_text(text, encoding="utf-8")
            append_runlog(out_dir, {"page": job.page, "status": "retry" if attempt < attempts else "failed",
                                    "attempt": attempt, "error": f"{type(e).__name__}: {reason}"})
            if attempt == attempts:
                return job.page, f"FAILED after {attempts} attempts: {type(e).__name__}: {reason}"
            delay = min(args.backoff * 2 ** (attempt - 1), 120) + random.uniform(0, 2)
            print(f"  p{job.page:04d} attempt {attempt} failed ({type(e).__name__}: {reason}); retrying in {delay:.0f}s",
                  file=sys.stderr)
            time.sleep(delay)
            continue

        path = out_path(out_dir, job.page)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
        usage = message.usage
        q = obj["quality"]
        append_runlog(out_dir, {
            "page": job.page, "status": "ok", "attempt": attempt, "model": message.model,
            "stop_reason": message.stop_reason, "seconds": round(time.time() - started, 1),
            "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
            "cache_read": getattr(usage, "cache_read_input_tokens", None),
            "image_quality": q["image_quality"], "retake": q["retake_recommended"],
            "ocr_agreement": q["ocr_agreement"], "warnings": warnings,
            "request_id": getattr(message, "_request_id", None),
        })
        summary = (f"ok  {path.name}  type={obj['page_type']} quality={q['image_quality']} retake={q['retake_recommended']} "
                   f"ocr={q['ocr_agreement']} figs={len(obj['figures'])} ents={len(obj['entities'])} "
                   f"tokens={usage.input_tokens}+{usage.output_tokens} {time.time() - started:.0f}s")
        if warnings:
            summary += "\n     warnings: " + "; ".join(warnings)
        return job.page, summary
    raise AssertionError("unreachable")


# ----------------------------------------------------------------------------- dry run

def dry_run(jobs: list[PageJob], source: Source, out_dir: Path, show_prompt: bool) -> None:
    print(f"pdf: {source.pdf_path.name}\nout: {out_dir}\n")
    print(f"{'printed':>7} {'pdf_idx':>7}  {'image':<45} {'dims':>10} {'jpeg_kb':>7} {'b64_kb':>6} {'ocr_chars':>9} {'exists':>6}")
    for job in jobs:
        data = job.image_path.read_bytes()
        with Image.open(job.image_path) as im:
            dims = f"{im.width}x{im.height}"
        exists = out_path(out_dir, job.page).exists()
        print(f"{job.page:>7} {job.pdf_index:>7}  {job.image_path.name:<45} {dims:>10} {len(data) // 1024:>7} "
              f"{len(base64.standard_b64encode(data)) // 1024:>6} {len(job.ocr_text):>9} {'yes' if exists else '-':>6}")
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
        for part in spec.split(","):
            part = part.strip()
            if not part:
                continue
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


def main() -> None:
    # Windows consoles default to cp1252; page content in summaries and warnings can contain any Unicode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pages", nargs="*", help="printed page numbers: 159, 40-60, 73,316")
    ap.add_argument("--book", default="vol1", choices=sorted(BOOKS))
    ap.add_argument("--fixture", action="store_true", help="use test-pages.pdf + test-pages/ (pages filter optional)")
    ap.add_argument("--out", type=Path, help="output directory (default out/<book>)")
    ap.add_argument("--dry-run", action="store_true", help="build requests and report sizes; no API calls, no writes")
    ap.add_argument("--show-prompt", action="store_true", help="with --dry-run: print the filled prompt for the first page")
    ap.add_argument("--force", action="store_true", help="re-run pages that already have output")
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

    if args.fixture:
        source = Source.for_fixture(book)
        pages = parse_pages(args.pages) if args.pages else source.pages
        unknown = [p for p in pages if p not in source.pages]
        if unknown:
            sys.exit(f"pages {unknown} are not in the fixture (fixture has {source.pages})")
    else:
        if not args.pages:
            ap.error("give at least one page / range, or --fixture, or --retake-report")
        pages = parse_pages(args.pages)
        try:
            source = Source.for_book(book, pages)
        except ValueError as e:
            sys.exit(str(e))

    body = load_prompt_body()
    jobs = []
    for p in pages:
        img = source.image_path(p)
        if not img.exists():
            sys.exit(f"missing image for printed page {p}: {img}")
        jobs.append(PageJob(page=p, pdf_index=source.pdf_index(p), image_path=img,
                            ocr_text=source.ocr_text(p), prompt=fill_prompt(body, book, p)))

    if args.dry_run:
        dry_run(jobs, source, out_dir, args.show_prompt)
        return

    if not args.force:
        skipped = [j.page for j in jobs if out_path(out_dir, j.page).exists()]
        jobs = [j for j in jobs if j.page not in skipped]
        if skipped:
            more = "..." if len(skipped) > 20 else ""
            print(f"skipping {len(skipped)} page(s) with existing output (use --force to redo): {skipped[:20]}{more}")
    if not jobs:
        print("nothing to do")
        return

    load_dotenv()
    import os
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        sys.exit("no credentials: set ANTHROPIC_API_KEY in the environment or put ANTHROPIC_API_KEY=... in .env at the repo root")
    out_dir.mkdir(parents=True, exist_ok=True)
    client = anthropic.Anthropic(max_retries=2)
    print(f"model={args.model} effort={args.effort} max_tokens={args.max_tokens} workers={args.workers} "
          f"fallback={'off' if args.no_fallback else 'on'}  ->  {out_dir}  ({len(jobs)} page(s))")

    failures = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_page, j, book=book, client=client, out_dir=out_dir, args=args): j for j in jobs}
        for fut in as_completed(futures):
            page, summary = fut.result()
            if summary.startswith("FAILED"):
                failures += 1
            print(f"p{page:04d}: {summary}")
    print(f"\ndone: {len(jobs) - failures} ok, {failures} failed, {time.time() - started:.0f}s")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
