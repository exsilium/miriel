"""Compare two art label runs spread by spread (model or prompt changes on the art fixture).

  uv run python scripts/compare_art_labels.py test-pages/art/opus test-pages/art/sonnet [--md report.md]

Per spread: artworks and box grouping, every name with source, confidence and whether it matched a guide entity,
captions, and the descriptions side by side; totals at the end (names, verified share, visual names, cost from
each folder's _runlog.jsonl).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load(folder: Path) -> dict[int, dict]:
    return {json.loads(f.read_text(encoding="utf-8"))["pdf_page"]: json.loads(f.read_text(encoding="utf-8"))
            for f in sorted(folder.glob("s[0-9][0-9][0-9][0-9].json"))}


def run_cost(folder: Path) -> float:
    log = folder / "_runlog.jsonl"
    if not log.exists():
        return 0.0
    return sum(r.get("cost_usd") or 0 for r in map(json.loads, log.read_text(encoding="utf-8").splitlines())
               if r.get("status") == "ok")


def fmt_art(a: dict) -> list[str]:
    names = ", ".join(f"{n['name']} [{n['source']}{'' if n['verified'] else ', UNVERIFIED'}]" for n in a["names"]) or "(no name)"
    out = [f"- boxes {a['boxes']} {a['kind']} ({a['confidence']}): {names}"]
    if a["caption_ja"]:
        out.append(f"  caption: {a['caption_ja']}")
    out.append(f"  {a['description']}")
    return out


def totals(labels: dict[int, dict]) -> str:
    names = [n for s in labels.values() for a in s["artworks"] for n in a["names"]]
    arts = sum(len(s["artworks"]) for s in labels.values())
    ver = sum(1 for n in names if n["verified"])
    vis = sum(1 for n in names if n["source"] == "visual")
    return f"{arts} artworks, {len(names)} names ({ver} verified, {vis} visual)"


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a", type=Path, nargs="+", help="folders of run A (several allowed, e.g. one per book), then --vs")
    ap.add_argument("--vs", type=Path, nargs="+", required=True, help="folders of run B")
    ap.add_argument("--md", type=Path, help="also write the report to this file")
    args = ap.parse_args()

    lines: list[str] = []
    cost_a = cost_b = 0.0
    all_a: dict = {}
    all_b: dict = {}
    for fa, fb in zip(args.a, args.vs):
        la, lb = load(fa), load(fb)
        cost_a += run_cost(fa)
        cost_b += run_cost(fb)
        for page in sorted(set(la) | set(lb)):
            sa, sb = la.get(page), lb.get(page)
            ref = sa or sb
            all_a[(ref["book"], page)] = sa
            all_b[(ref["book"], page)] = sb
            lines.append(f"## {ref['book']} PDF {page} (pp. {'-'.join(map(str, ref['folios']))}), "
                         f"{len(ref['segmentation']['boxes'])} boxes")
            for tag, s, folder in (("A", sa, fa), ("B", sb, fb)):
                lines.append(f"### {tag}: {folder.name}" + ("" if s else " — missing"))
                if s:
                    for a in s["artworks"]:
                        lines.extend(fmt_art(a))
                    if s["not_art"]:
                        lines.append(f"- not art: {s['not_art']}")
                    if s.get("notes"):
                        lines.append(f"- notes: {s['notes']}")
            lines.append("")
    lines.append("## Totals")
    lines.append(f"- A {', '.join(f.name for f in args.a)}: {totals({k: v for k, v in all_a.items() if v})}, ${cost_a:.2f}")
    lines.append(f"- B {', '.join(f.name for f in args.vs)}: {totals({k: v for k, v in all_b.items() if v})}, ${cost_b:.2f}")
    text = "\n".join(lines)
    print(text)
    if args.md:
        args.md.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
