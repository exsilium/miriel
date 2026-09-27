"""QA report over a book's extraction output: out/<book>/_qa.md (+ _retakes.txt for `extract.py --pages-from`).

Checks per page file: schema validity (scripts/schema.py), `page` vs file name, `book` vs sourceBook,
[FIGURE n] placeholders vs figures.length, illegible_regions vs [illegible] markers, entity names not found
verbatim in markdown. Then coverage (missing pages, _failed/), distributions (page_type, image_quality,
ocr_agreement), the retake list grouped by reason, re-OCR candidates, and a seeded random sample for a human
spot-check with image paths.

Usage:
  uv run python scripts/qa_report.py --book vol1 [--out out/vol1] [--sample 20] [--seed 1]
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, ROOT, Book  # noqa: E402
from schema import PAGE_SCHEMA  # noqa: E402

FILE_RE = re.compile(r"^p(\d{3})\.json$")
FIG_RE = re.compile(r"\[FIGURE (\d+)")


def check_file(path: Path, book: Book) -> tuple[dict | None, list[str]]:
    """Returns (page object or None if unusable, list of problems)."""
    problems: list[str] = []
    m = FILE_RE.match(path.name)
    from_name = int(m.group(1)) if m else None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return None, [f"invalid JSON: {e}"]
    try:
        jsonschema.validate(obj, PAGE_SCHEMA)
    except jsonschema.ValidationError as e:
        return None, [f"schema: {'/'.join(str(p) for p in e.absolute_path) or '<root>'}: {e.message[:200]}"]
    if from_name is not None and obj["page"] != from_name:
        problems.append(f"page field {obj['page']} != file name {from_name}")
    if obj["book"] != book.name:
        problems.append(f"book field {obj['book']!r} != sourceBook {book.name!r}")
    md = obj["markdown"]
    placeholders = [int(n) for n in FIG_RE.findall(md)]
    n_fig = len(obj["figures"])
    if placeholders and max(placeholders) > n_fig:
        problems.append(f"markdown references FIGURE {max(placeholders)} but figures has {n_fig}")
    if n_fig > len(set(placeholders)):
        problems.append(f"{n_fig} figures, {len(set(placeholders))} distinct [FIGURE n] placeholders")
    n_ill = md.count("[illegible]")
    if n_ill != obj["quality"]["illegible_regions"]:
        problems.append(f"illegible_regions={obj['quality']['illegible_regions']} but {n_ill} [illegible] markers")
    missing = [e["name"] for e in obj["entities"] if e["name"] not in md]
    if missing:
        problems.append(f"{len(missing)} entity name(s) not verbatim in markdown: {', '.join(missing[:5])}"
                        + (" …" if len(missing) > 5 else ""))
    q = obj["quality"]
    if q["image_quality"] in ("poor", "unusable") and not q["retake_recommended"]:
        problems.append(f"image_quality={q['image_quality']} but retake_recommended=false")
    return obj, problems


def md_table(headers: list[str], rows: list[list[object]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(" --- " for _ in headers) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(c).replace("|", "\\|").replace("\n", " ") for c in r) + " |")
    return "\n".join(out)


def dist(counter: Counter, total: int) -> str:
    rows = [[k, v, f"{100 * v / total:.0f}%"] for k, v in counter.most_common()]
    return md_table(["value", "pages", "share"], rows)


def build_report(book: Book, out_dir: Path, sample_n: int, seed: int) -> tuple[str, list[int]]:
    files = sorted(p for p in out_dir.iterdir() if FILE_RE.match(p.name))
    pages: dict[int, dict] = {}
    problems: dict[str, list[str]] = {}
    invalid: dict[str, list[str]] = {}
    for f in files:
        obj, probs = check_file(f, book)
        if obj is None:
            invalid[f.name] = probs
            continue
        pages[obj["page"]] = obj
        if probs:
            problems[f.name] = probs

    expected = set(range(max(book.first_printed, 1), book.last_printed + 1))
    have = set(pages)
    missing = sorted(expected - have)
    failed_dir = out_dir / "_failed"
    failed = sorted(p.name for p in failed_dir.glob("p*.txt")) if failed_dir.exists() else []

    page_type = Counter(o["page_type"] for o in pages.values())
    image_quality = Counter(o["quality"]["image_quality"] for o in pages.values())
    ocr = Counter(o["quality"]["ocr_agreement"] for o in pages.values())
    issues = Counter(i for o in pages.values() for i in o["quality"]["quality_issues"])

    retakes = [pages[p] for p in sorted(pages) if pages[p]["quality"]["retake_recommended"]]
    by_reason: dict[str, list[dict]] = defaultdict(list)   # one group per quality_issue; a page can sit in several
    for o in retakes:
        for issue in (o["quality"]["quality_issues"] or ["(no quality_issues given)"]):
            by_reason[issue].append(o)
    reocr = [o for o in pages.values()
             if not o["quality"]["retake_recommended"] and o["quality"]["ocr_agreement"] == "low"
             and o["quality"]["image_quality"] in ("good", "usable")]

    n = len(pages)
    figs = sum(len(o["figures"]) for o in pages.values())
    ents = sum(len(o["entities"]) for o in pages.values())
    ill = sum(o["quality"]["illegible_regions"] for o in pages.values())
    md_chars = sum(len(o["markdown"]) for o in pages.values())

    L: list[str] = []
    L.append(f"# QA report — {book.title} (`{book.key}`)\n")
    L.append(f"Generated from `{out_dir.relative_to(ROOT) if out_dir.is_relative_to(ROOT) else out_dir}` with "
             f"`scripts/qa_report.py --book {book.key} --seed {seed}`.\n")
    L.append("## Coverage\n")
    L.append(md_table(["metric", "value"], [
        ["printed pages expected", f"{min(expected)}–{max(expected)} ({len(expected)})"],
        ["page files valid", n],
        ["page files invalid (schema/JSON)", len(invalid)],
        ["pages missing", len(missing)],
        ["pages in _failed/", len(failed)],
        ["figures", figs],
        ["entities", ents],
        ["[illegible] markers", ill],
        ["markdown chars (avg per page)", f"{md_chars:,} ({md_chars // n if n else 0:,})"],
    ]))
    if missing:
        L.append(f"\nMissing pages: {compress_ranges(missing)}")
    if failed:
        L.append(f"\nFailed pages (`_failed/`): {', '.join(failed)}")
    if invalid:
        L.append("\n### Invalid files\n")
        L.append(md_table(["file", "problem"], [[k, "; ".join(v)] for k, v in invalid.items()]))

    L.append("\n## Consistency problems\n")
    if problems:
        L.append(f"{len(problems)} of {n} pages have at least one soft problem.\n")
        L.append(md_table(["file", "problems"], [[k, "; ".join(v)] for k, v in sorted(problems.items())]))
    else:
        L.append("None.")

    L.append("\n## Distributions\n")
    if n:
        L.append("### page_type\n\n" + dist(page_type, n))
        L.append("\n### image_quality\n\n" + dist(image_quality, n))
        L.append("\n### ocr_agreement\n\n" + dist(ocr, n))
        L.append("\n### quality_issues (a page can list several)\n\n" + dist(issues, n) if issues else "\n### quality_issues\n\nNone reported.")

    L.append(f"\n## Retake list ({len(retakes)} pages)\n")
    L.append(f"Also written to `_retakes.txt` for `extract.py --book {book.key} --pages-from out/{book.key}/_retakes.txt --force` after a re-shoot.\n")
    L.append("### By reason (a page with several issues appears under each)\n")
    L.append(md_table(["quality_issue", "pages", "printed pages"], [
        [key, len(group), compress_ranges(sorted(o["page"] for o in group))]
        for key, group in sorted(by_reason.items(), key=lambda kv: -len(kv[1]))]))
    L.append("\n### All retake pages\n")
    L.append(md_table(["page", "quality", "issues", "retake_reason", "affected_areas", "image"], [
        [o["page"], o["quality"]["image_quality"], ", ".join(o["quality"]["quality_issues"]), o["quality"]["retake_reason"] or "",
         o["quality"]["affected_areas"] or "", book.image_path(o["page"]).name] for o in retakes]))

    L.append(f"\n## Re-OCR candidates ({len(reocr)} pages: low OCR agreement on a readable image, no retake)\n")
    if reocr:
        L.append(md_table(["page", "quality", "notes"], [[o["page"], o["quality"]["image_quality"], o["quality"]["notes"] or ""] for o in reocr]))
    else:
        L.append("None.")

    rng = random.Random(seed)
    sample = sorted(rng.sample(sorted(pages), min(sample_n, n))) if n else []
    L.append(f"\n## Spot-check sample ({len(sample)} pages, seed {seed})\n")
    L.append("Open the image next to the JSON and check: names spelled as printed, map labels vs legend, entity names verbatim in markdown, retake flag agrees with your eye.\n")
    L.append(md_table(["page", "type", "quality", "retake", "figs", "ents", "image", "json"], [
        [p, pages[p]["page_type"], pages[p]["quality"]["image_quality"], "yes" if pages[p]["quality"]["retake_recommended"] else "no",
         len(pages[p]["figures"]), len(pages[p]["entities"]), str(book.image_path(p)), f"p{p:03d}.json"] for p in sample]))
    return "\n".join(L) + "\n", [o["page"] for o in retakes]


def compress_ranges(pages: list[int]) -> str:
    out: list[str] = []
    i = 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        out.append(str(pages[i]) if i == j else f"{pages[i]}-{pages[j]}")
        i = j + 1
    return ", ".join(out)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(BOOKS))
    ap.add_argument("--out", type=Path, help="extraction directory (default out/<book>)")
    ap.add_argument("--sample", type=int, default=20, help="spot-check sample size (default 20)")
    ap.add_argument("--seed", type=int, default=1, help="sample seed (default 1)")
    args = ap.parse_args()
    book = BOOKS[args.book]
    out_dir = args.out or (ROOT / "out" / book.key)
    if not out_dir.exists():
        sys.exit(f"no extraction output at {out_dir}")
    report, retakes = build_report(book, out_dir, args.sample, args.seed)
    (out_dir / "_qa.md").write_text(report, encoding="utf-8")
    (out_dir / "_retakes.txt").write_text(
        f"# pages flagged retake_recommended in {book.key}; feed to extract.py --pages-from after the re-shoot\n"
        + "\n".join(str(p) for p in retakes) + ("\n" if retakes else ""), encoding="utf-8")
    print(f"wrote {out_dir / '_qa.md'} and _retakes.txt ({len(retakes)} retake pages)")
    # short console digest
    for line in report.splitlines():
        if line.startswith("## ") or line.startswith("| page files") or line.startswith("| pages missing"):
            print("  " + line.strip("# "))


if __name__ == "__main__":
    main()
