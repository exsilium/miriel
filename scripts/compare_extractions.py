"""Compare two extraction runs of the same pages (e.g. Opus vs Sonnet on the fixture, or before/after a
prompt change). Prints a per-page table and the entity/label names that only one side produced.

Usage:
  uv run python scripts/compare_extractions.py out/vol1 out/vol1-sonnet [--label-a opus --label-b sonnet] [--names]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FILE_RE = re.compile(r"^p(\d{4})\.json$")
# Tables may sit inside sidebars, i.e. lines prefixed with one or more "> ".
TABLE_ROW = re.compile(r"^\s*(?:>\s*)*\|.*\|\s*$")
SEP_ROW = re.compile(r"^\s*(?:>\s*)*\|[\s:|-]+\|\s*$")


def load(dir_: Path) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for f in sorted(dir_.iterdir()):
        m = FILE_RE.match(f.name)
        if m:
            out[int(m.group(1))] = json.loads(f.read_text(encoding="utf-8"))
    return out


def table_stats(md: str) -> tuple[int, int]:
    """(data rows, cells) across all markdown tables; separator rows are not counted."""
    rows = cells = 0
    for line in md.splitlines():
        if TABLE_ROW.match(line) and not SEP_ROW.match(line):
            inner = line.strip().lstrip("> ").strip("|")
            rows += 1
            cells += inner.count("|") + 1
    return rows, cells


def runlog_stats(dir_: Path) -> dict[int, dict]:
    """Last successful runlog record per page: tokens, seconds, cost."""
    path = dir_ / "_runlog.jsonl"
    out: dict[int, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("status") == "ok" and "page" in r:
            out[r["page"]] = r
    return out


def summarize(o: dict) -> dict:
    rows, cells = table_stats(o["markdown"])
    md = o["markdown"]
    names = {e["name"] for e in o["entities"]}
    return {
        "type": o["page_type"],
        "md_chars": len(md),
        "headings": sum(1 for ln in md.splitlines() if ln.startswith("#")),
        "table_rows": rows,
        "table_cells": cells,
        "figures": len(o["figures"]),
        "labels": sum(len(f["labels"]) for f in o["figures"]),
        "entities": len(o["entities"]),
        "names": names,
        "names_not_verbatim": sum(1 for n in names if n not in md),
        "illegible": md.count("[illegible]"),
        "quality": o["quality"]["image_quality"],
        "retake": "yes" if o["quality"]["retake_recommended"] else "no",
        "ocr": o["quality"]["ocr_agreement"],
        "label_set": {lab for f in o["figures"] for lab in f["labels"]},
    }


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", type=Path)
    ap.add_argument("b", type=Path)
    ap.add_argument("--label-a", default="A")
    ap.add_argument("--label-b", default="B")
    ap.add_argument("--names", action="store_true", help="list entity names present on only one side, per page")
    args = ap.parse_args()
    A, B = load(args.a), load(args.b)
    la, lb = args.label_a, args.label_b
    common = sorted(set(A) & set(B))
    if not common:
        sys.exit(f"no common pages between {args.a} ({len(A)}) and {args.b} ({len(B)})")
    only_a, only_b = sorted(set(A) - set(B)), sorted(set(B) - set(A))
    if only_a or only_b:
        print(f"pages only in {la}: {only_a}; only in {lb}: {only_b}\n")
    ra, rb = runlog_stats(args.a), runlog_stats(args.b)

    metrics = ["md_chars", "headings", "table_rows", "table_cells", "figures", "labels", "entities", "names_not_verbatim", "illegible"]
    header = f"{'page':>5} {'metric':<18} {la:>9} {lb:>9}   note"
    totals_a = dict.fromkeys(metrics, 0)
    totals_b = dict.fromkeys(metrics, 0)
    for p in common:
        sa, sb = summarize(A[p]), summarize(B[p])
        print(f"=== page {p}: type {sa['type']} / {sb['type']}   quality {sa['quality']} / {sb['quality']}   "
              f"retake {sa['retake']} / {sb['retake']}   ocr {sa['ocr']} / {sb['ocr']}")
        print(header)
        for m in metrics:
            va, vb = sa[m], sb[m]
            totals_a[m] += va
            totals_b[m] += vb
            note = ""
            if va != vb:
                base = max(va, vb, 1)
                note = f"{'+' if vb > va else ''}{vb - va} ({100 * (vb - va) / base:+.0f}%)"
            print(f"{p:>5} {m:<18} {va:>9} {vb:>9}   {note}")
        shared = len(sa["names"] & sb["names"])
        print(f"{p:>5} {'entity names':<18} {len(sa['names']):>9} {len(sb['names']):>9}   {shared} shared, "
              f"{len(sa['names'] - sb['names'])} only {la}, {len(sb['names'] - sa['names'])} only {lb}")
        shared_l = len(sa["label_set"] & sb["label_set"])
        print(f"{p:>5} {'figure labels':<18} {len(sa['label_set']):>9} {len(sb['label_set']):>9}   {shared_l} shared")
        if p in ra and p in rb:
            for k in ("seconds", "input_tokens", "output_tokens"):
                print(f"{p:>5} {k:<18} {ra[p].get(k, ''):>9} {rb[p].get(k, ''):>9}")
            ca, cb = ra[p].get("cost_usd"), rb[p].get("cost_usd")
            if ca is not None or cb is not None:
                print(f"{p:>5} {'cost_usd':<18} {ca if ca is not None else '?':>9} {cb if cb is not None else '?':>9}")
        if args.names:
            oa, ob = sorted(sa["names"] - sb["names"]), sorted(sb["names"] - sa["names"])
            if oa:
                print(f"      only {la}: {'; '.join(oa)}")
            if ob:
                print(f"      only {lb}: {'; '.join(ob)}")
        print()

    print(f"=== totals over {len(common)} pages")
    print(header)
    for m in metrics:
        va, vb = totals_a[m], totals_b[m]
        note = f"{'+' if vb > va else ''}{vb - va} ({100 * (vb - va) / max(va, 1):+.0f}%)" if va != vb else ""
        print(f"{'all':>5} {m:<18} {va:>9} {vb:>9}   {note}")
    if ra and rb:
        for k in ("seconds", "input_tokens", "output_tokens"):
            ta = sum(ra[p].get(k, 0) or 0 for p in common if p in ra)
            tb = sum(rb[p].get(k, 0) or 0 for p in common if p in rb)
            print(f"{'all':>5} {k:<18} {ta:>9.0f} {tb:>9.0f}")
        ca = sum(ra[p].get("cost_usd") or 0 for p in common if p in ra)
        cb = sum(rb[p].get("cost_usd") or 0 for p in common if p in rb)
        print(f"{'all':>5} {'cost_usd':<18} {ca:>9.3f} {cb:>9.3f}")


if __name__ == "__main__":
    main()
