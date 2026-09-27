"""QA report for a built checklist (docs/build-spec-checklist.md §6 Phase A): out/checklists/<id>_qa.md.

Reads out/checklists/<id>.json (checklist_build.py), <id>_pages.json (`npm run checklist-pages`) and the hand
corrections in <id>_overrides.json (`{"items": {"m042": {"pages": [...], "prompt": "..."}}}`, applied the same way
as by `indexer checklists`) and rates each item's page links:

  chapter    the top page lies in the guide chapter of an NPC the item names
  chapter+   a lower page (2nd or 3rd) does
  npc-page   the top page mentions one of the item's NPCs
  no-npc     the item names no NPC (collectibles, places); pages listed for a look
  check      none of the above: the pages may be off, look at these first
  missing    no pages (run `npm run checklist-pages`)

  uv run python scripts/checklist_qa.py [--checklist main] [--sample 20]
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from checklist_build import OUT_DIR, NpcIndex, load_config  # noqa: E402

ORDER = ["chapter", "chapter+", "npc-page", "no-npc", "check", "missing"]


def rate(item: dict, pages: list[dict], mentions: dict[str, set]) -> str:
    if not pages:
        return "missing"
    named = [n for n in item["npcs"] if n["norm"]]
    if not named:
        return "no-npc"

    def in_chapter(p: dict) -> bool:
        return any(n["chapter"] and n["chapter"]["book"] == p["book"] and n["chapter"]["from"] <= p["page"] <= n["chapter"]["to"]
                   for n in named)

    if in_chapter(pages[0]):
        return "chapter"
    if any(in_chapter(p) for p in pages[1:]):
        return "chapter+"
    if any((pages[0]["book"], pages[0]["page"]) in mentions.get(n["norm"], set()) for n in named):
        return "npc-page"
    return "check"


def fmt_pages(pages: list[dict]) -> str:
    return ", ".join(f"{p['book']} p.{p['page']}" for p in pages) or "-"


def report(key: str, sample_n: int) -> tuple[Path, Counter]:
    data = json.loads((OUT_DIR / f"{key}.json").read_text(encoding="utf-8"))
    pages_file = OUT_DIR / f"{key}_pages.json"
    looked_up = json.loads(pages_file.read_text(encoding="utf-8")) if pages_file.exists() else {}
    overrides_file = OUT_DIR / f"{key}_overrides.json"
    overrides = json.loads(overrides_file.read_text(encoding="utf-8")).get("items", {}) if overrides_file.exists() else {}
    for item_id, o in overrides.items():
        if "pages" in o:
            looked_up.setdefault(item_id, {})["pages"] = o["pages"]
    index = NpcIndex(books=data["books"])
    items = [r for r in data["rows"] if r["type"] == "item"]
    rated = [(it, looked_up.get(it["id"], {}).get("pages", []), None) for it in items]
    rated = [(it, pg, rate(it, pg, index.mentions)) for it, pg, _ in rated]
    counts = Counter(r for _, _, r in rated)

    out: list[str] = []
    w = out.append
    w(f"# Checklist QA: {data['title']} ({key})")
    w("")
    w(f"Source `{data['source']}` (sha256 {data['sourceSha256'][:12]}), by {data['author']}, <{data['sourceUrl']}>. "
      f"Books: {', '.join(data['books'])}.")
    w("")
    if overrides:
        w(f"Hand corrections: {len(overrides)} item(s) in `out/checklists/{key}_overrides.json`.")
        w("")
    w(f"{data['counts']['items']} items, {data['counts']['notes']} notes, {data['counts']['sections']} sections, "
      f"{len(data['chains'])} chains, {sum(len(f['items']) for f in data['footnotes'])} footnoted items; "
      f"{sum(1 for it in items if it['optional'])} optional, {sum(1 for it in items if it['collectible'])} collectibles.")
    w("")
    w("## Page links")
    w("")
    w("| Rating | Items |")
    w("|---|---|")
    for r in ORDER:
        if counts[r]:
            w(f"| {r} | {counts[r]} |")
    w("")
    for r in ("check", "missing", "no-npc"):
        group = [(it, pg) for it, pg, rr in rated if rr == r]
        if not group:
            continue
        w(f"### {r} ({len(group)})")
        w("")
        for it, pg in group:
            npcs = ", ".join(n["entity"] for n in it["npcs"] if n["norm"])
            w(f"- **{it['id']}** {it['prompt'][:160]}{'…' if len(it['prompt']) > 160 else ''}")
            w(f"  - pages: {fmt_pages(pg)}" + (f"; NPCs: {npcs}" if npcs else ""))
        w("")

    w("## Chains (`**` items)")
    w("")
    by_id = {it["id"]: it for it in items}
    if not data["chains"]:
        w("None.")
    for c in data["chains"]:
        w(f"### {c['label']} (`{c['id']}`, {len(c['items'])} items)")
        w("")
        for i in c["items"]:
            w(f"- {i}: {by_id[i]['prompt'][:140]}")
        w("")
    w("## Footnotes")
    w("")
    if not data["footnotes"]:
        w("None.")
    for f in data["footnotes"]:
        w(f"### {f['label']} (`{f['marker']}` -> section `{f['section']}`, {len(f['items'])} items)")
        w("")
        for i in f["items"]:
            w(f"- {i}: {by_id[i]['prompt'][:140]}")
        w("")

    w("## NPC names")
    w("")
    names = [n for it in items for n in it["npcs"]]
    unresolved = sorted({n["name"] for n in names if not n["norm"]})
    w(f"{len(names)} names on items, {len(names) - sum(1 for n in names if not n['norm'])} resolved; "
      f"{len({n['norm'] for n in names if n['norm']})} distinct NPCs.")
    w("")
    if unresolved:
        w("Unresolved (add to config/checklists/aliases.json `names`): " + ", ".join(unresolved))
        w("")
    loose = sorted({(n["name"], n["entity"], n["match"]) for n in names if n["norm"] and n["match"] != "exact"})
    if loose:
        w("Not exact (check these):")
        w("")
        w("| Checklist | Guide entity | Match |")
        w("|---|---|---|")
        for a, b, m in loose:
            w(f"| {a} | {b} | {m} |")
        w("")
    chapters = sorted({(n["entity"], f"{n['chapter']['title']} ({n['chapter']['book']} p.{n['chapter']['from']}-{n['chapter']['to']})"
                        if n["chapter"] else "-") for n in names if n["norm"]})
    w("| NPC | Guide chapter |")
    w("|---|---|")
    for e, c in chapters:
        w(f"| {e} | {c} |")
    w("")

    w(f"## Sample for review ({sample_n} items, fixed seed)")
    w("")
    rng = random.Random(key)
    for it, pg, r in sorted(rng.sample(rated, min(sample_n, len(rated))), key=lambda x: x[0]["ord"]):
        w(f"- **{it['id']}** [{r}] {it['prompt'][:160]}")
        w(f"  - pages: {fmt_pages(pg)}")
    w("")
    path = OUT_DIR / f"{key}_qa.md"
    path.write_text("\n".join(out), encoding="utf-8", newline="\n")
    return path, counts


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checklist", action="append")
    ap.add_argument("--sample", type=int, default=20)
    args = ap.parse_args()
    for key in args.checklist or list(load_config()):
        path, counts = report(key, args.sample)
        print(f"{key}: " + ", ".join(f"{r} {counts[r]}" for r in ORDER if counts[r]) + f" -> {path.relative_to(OUT_DIR.parent.parent)}")


if __name__ == "__main__":
    main()
