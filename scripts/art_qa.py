"""QA report for an art book's labels: out/<art id>/_qa.md (docs/build-spec-artbooks.md §5.2).

  uv run python scripts/art_qa.py --book art1
  uv run python scripts/art_qa.py --book art1 --recheck      # re-run the name check on the label files first

Sections: coverage and cost; spreads without labels; unverified names (grouped); prefix and close name matches;
low-confidence visual names; unnamed artworks of kinds that are usually named; possible segmentation misses;
the model's notes. Overrides from out/<id>/_overrides.json are applied before counting.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from art_names import annotate, default_index  # noqa: E402
from art_overrides import apply_overrides, load_overrides  # noqa: E402
from pages import ARTBOOKS, ROOT  # noqa: E402

NAMED_KINDS = {"boss", "enemy", "npc", "creature", "weapon", "armor", "item", "spell"}
SEGMENTATION_WORDS = ("missed", "cuts", "cut through", "split", "not boxed", "outside", "no box", "partially")


def pp(label: dict) -> str:
    f = label["folios"]
    return f"s{label['pdf_page']:04d} (pp. {f[0]}-{f[1]})" if f else f"s{label['pdf_page']:04d} (cover)"


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--book", required=True, choices=sorted(ARTBOOKS))
    ap.add_argument("--out", type=Path, help="label folder (default out/<book>)")
    ap.add_argument("--recheck", action="store_true", help="re-run the guide name check on every label file first")
    args = ap.parse_args()
    book = ARTBOOKS[args.book]
    out_dir = args.out or ROOT / "out" / book.key

    index = default_index()
    overrides = load_overrides(out_dir)
    labels = []
    for f in sorted(out_dir.glob("s[0-9][0-9][0-9][0-9].json")):
        label = json.loads(f.read_text(encoding="utf-8"))
        if args.recheck:
            annotate(label, index)
            f.write_text(json.dumps(label, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        labels.append(apply_overrides(label, overrides.get(label["pdf_page"]), index))
    done = {l["pdf_page"] for l in labels}
    missing = [p for p in range(1, book.page_count + 1) if p not in done]
    failed = sorted(int(f.stem[1:]) for f in (out_dir / "_failed").glob("s*.txt")) if (out_dir / "_failed").exists() else []

    cost = 0.0
    models = Counter()
    log = out_dir / "_runlog.jsonl"
    if log.exists():
        last_ok: dict[int, dict] = {}
        for r in map(json.loads, log.read_text(encoding="utf-8").splitlines()):
            if r.get("status") == "ok" and "pdf_page" in r:
                cost += r.get("cost_usd") or 0
                last_ok[r["pdf_page"]] = r
        models.update(r.get("model") or "(no call)" for r in last_ok.values())

    arts = [(l, i, a) for l in labels for i, a in enumerate(l["artworks"], 1)]
    names = [(l, i, a, n) for l, i, a in arts for n in a["names"]]
    ver = [x for x in names if x[3]["verified"]]
    by_source = Counter(n["source"] for *_, n in names)
    by_match = Counter(n["match"] for *_, n in names)
    kinds = Counter(a["kind"] for _, _, a in arts)

    L: list[str] = [f"# Art labels QA — {book.title} ({book.key})", ""]
    L.append(f"- Spreads: {len(labels)} of {book.page_count} labelled" + (f"; **missing {len(missing)}**: {missing[:40]}" if missing else ""))
    if failed:
        L.append(f"- **Failed spreads** (out/{book.key}/_failed/): {failed}")
    L.append(f"- Artworks: {len(arts)} ({', '.join(f'{k} {v}' for k, v in kinds.most_common())})")
    L.append(f"- Names: {len(names)}, verified against the guides {len(ver)} ({100 * len(ver) / max(1, len(names)):.0f} %); "
             f"source: {dict(by_source)}; match: {dict(by_match)}")
    L.append(f"- Artworks with at least one verified name: {sum(1 for _, _, a in arts if any(n['verified'] for n in a['names']))}; "
             f"without any name: {sum(1 for _, _, a in arts if not a['names'])}")
    L.append(f"- Overrides applied: {len(overrides)} spread(s)")
    L.append(f"- Cost (runlog, successful calls): ${cost:.2f}; models: {dict(models)}")
    L.append("")

    empty = [l for l in labels if not l["artworks"]]
    L.append(f"## Spreads without artworks ({len(empty)})")
    L.append("Expected for text pages (contents, colophon); anything else is a miss.")
    for l in empty:
        L.append(f"- {pp(l)}: {l['segmentation']['mode']}, {len(l['segmentation']['boxes'])} box(es) all not_art"
                 + (f" — {l['notes']}" if l.get("notes") else ""))
    L.append("")

    unv: dict[str, list[str]] = defaultdict(list)
    for l, i, a, n in names:
        if not n["verified"]:
            unv[n["name"]].append(f"s{l['pdf_page']:04d}#{i} {n['source']}/{a['confidence']}")
    L.append(f"## Unverified names ({len(unv)} distinct, {sum(map(len, unv.values()))} uses)")
    L.append("Not found in any guide. Either a name the guides never print (fine, shown lower) or a wrong translation "
             "(fix with an override).")
    for name, uses in sorted(unv.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        L.append(f"- {name} — {len(uses)}: {', '.join(uses[:6])}{' …' if len(uses) > 6 else ''}")
    L.append("")

    fuzzy = [(l, i, a, n) for l, i, a, n in names if n["match"] in ("prefix", "close", "word_order")]
    L.append(f"## Prefix, close and word-order matches ({len(fuzzy)})")
    L.append("Verified, but check the pairing.")
    for l, i, _a, n in fuzzy:
        L.append(f"- s{l['pdf_page']:04d}#{i}: {n['name']} → {n['entity']} ({n['match']})")
    L.append("")

    low = [(l, i, a, n) for l, i, a, n in names if n["source"] == "visual" and a["confidence"] != "high"]
    L.append(f"## Visual names below high confidence ({len(low)})")
    for l, i, a, n in low:
        L.append(f"- s{l['pdf_page']:04d}#{i} {a['kind']}/{a['confidence']}: {n['name']}"
                 f"{'' if n['verified'] else ' (unverified)'} — {a['description'][:110]}")
    L.append("")

    unnamed = [(l, i, a) for l, i, a in arts if not a["names"] and a["kind"] in NAMED_KINDS]
    L.append(f"## Unnamed artworks of usually-named kinds ({len(unnamed)})")
    for l, i, a in unnamed:
        L.append(f"- s{l['pdf_page']:04d}#{i} {a['kind']}"
                 + (f" caption {a['caption_ja']}" if a["caption_ja"] else "") + f" — {a['description'][:110]}")
    L.append("")

    seg = []
    for l in labels:
        note = (l.get("notes") or "").lower()
        big = [b for b in l["segmentation"]["boxes"] if (b[2] - b[0]) * (b[3] - b[1]) > 0.6]
        crowded = [a for a in l["artworks"] if len(a["names"]) >= 3]
        if any(w in note for w in SEGMENTATION_WORDS) or (big and len(l["artworks"]) == 1 and len(l["artworks"][0]["names"]) >= 2) or crowded:
            seg.append(l)
    L.append(f"## Possible segmentation misses ({len(seg)})")
    L.append("One box holding several named pieces, or the model reporting a box that cuts or misses art. "
             "A crop of such an artwork shows more than its subject; acceptable unless it matters for a frequent subject.")
    for l in seg:
        L.append(f"- {pp(l)}: {len(l['segmentation']['boxes'])} box(es), {len(l['artworks'])} artwork(s)"
                 + (f" — {l['notes']}" if l.get("notes") else ""))
    L.append("")

    L.append("## Model notes")
    for l in labels:
        if l.get("notes"):
            L.append(f"- {pp(l)}: {l['notes']}")
    L.append("")

    path = out_dir / "_qa.md"
    path.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L[:9]))
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
