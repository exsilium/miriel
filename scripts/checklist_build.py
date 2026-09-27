"""Build the quest checklists (docs/build-spec-checklist.md §2, §3 decision 5) from config/checklists.json.

Each checklist is a Markdown file under config/: `##`/`###`/`####` headings are sections, `- ` bullets are the
items a user ticks off, any other non-blank line is a note shown in place. A bullet may start with a marker
configured in the checklist's `markers` (`*****` = footnote to a section, `**` = chain of linked activities);
its stable id is a trailing `<!-- q:m001 -->` comment, added once by --assign-ids and kept across edits.

Writes out/checklists/<id>.json: the rows in file order, every item's NPCs (bold names resolved to guide NPC
entities, with the NPC's chapter pages in the guides), chains and footnotes. Page links are added separately by
`npm run checklist-pages` (out/checklists/<id>_pages.json); scripts/checklist_qa.py reports on both.

  uv run python scripts/checklist_build.py --selftest
  uv run python scripts/checklist_build.py --assign-ids            # once, and after adding bullets
  uv run python scripts/checklist_build.py [--checklist main]      # all checklists by default
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from art_names import normalize_name  # noqa: E402
from pages import BOOKS, ROOT  # noqa: E402

CONFIG_PATH = ROOT / "config" / "checklists.json"
ALIASES_PATH = ROOT / "config" / "checklists" / "aliases.json"
OUT_DIR = ROOT / "out" / "checklists"
NPC_TYPES = {"npc", "merchant", "boss"}
CLOSE = 0.88

ID_COMMENT = re.compile(r"\s*<!--\s*q:([a-z0-9]+)\s*-->\s*$")
HEADING = re.compile(r"^(#{2,4})\s+(.+?)\s*$")
BOLD = re.compile(r"\*\*([^*]+?)\*\*")
# "Deathroot #2 ...", "Seedbed Curse #1 ...", "**Forager Brood** Cookbook #2: ..."
COLLECTIBLE = re.compile(r"^([A-Z][\w' ]*?)\s?#\s?(\d+)\b")  # matched on the plain text


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def fold(s: str) -> str:
    """Accent-folded normalize_name: 'Jolán' and 'Jolan' compare equal."""
    return "".join(c for c in unicodedata.normalize("NFKD", normalize_name(s)) if not unicodedata.combining(c))


def slug(s: str) -> str:
    return re.sub(r"\s+", "-", fold(s))


# --- Markdown ---------------------------------------------------------------------------------------------------


@dataclass
class Row:
    type: str                      # heading | note | item
    line: int                      # 0-based line index in the file
    text: str                      # heading title, note text, or item text (Markdown, marker and id removed)
    level: int = 0                 # headings
    path: list[str] = field(default_factory=list)
    id: str | None = None          # items
    marker: str | None = None      # items


def parse(md: str, markers: list[str]) -> list[Row]:
    """Rows in file order. `markers` are the configured item prefixes, longest tried first."""
    rows: list[Row] = []
    path: list[str] = []
    by_len = sorted(markers, key=len, reverse=True)
    for i, raw in enumerate(md.split("\n")):
        line = raw.rstrip("\r").strip()
        if not line:
            continue
        m = HEADING.match(line)
        if m:
            level = len(m.group(1))
            path = path[: level - 2] + [m.group(2)]
            rows.append(Row("heading", i, m.group(2), level=level, path=list(path)))
            continue
        if line.startswith("- "):
            text = line[2:].strip()
            idm = ID_COMMENT.search(text)
            item_id = idm.group(1) if idm else None
            if idm:
                text = text[: idm.start()].rstrip()
            marker = next((mk for mk in by_len if text.startswith(mk + " ")), None)
            if marker:
                text = text[len(marker):].strip()
            rows.append(Row("item", i, text, path=list(path), id=item_id, marker=marker))
            continue
        if raw.startswith((" ", "\t")) and rows and rows[-1].type == "item":
            raise ValueError(f"line {i + 1}: indented continuation lines are not supported; keep each item on one line")
        rows.append(Row("note", i, line, path=list(path)))
    return rows


def assign_ids(md: str, prefix: str, markers: list[str]) -> tuple[str, int]:
    """Give every id-less bullet the next free <prefix>NNN id. Returns (new text, ids added)."""
    rows = parse(md, markers)
    taken = [r.id for r in rows if r.type == "item" and r.id]
    dup = [k for k, n in Counter(taken).items() if n > 1]
    if dup:
        raise ValueError(f"duplicate item ids: {dup}")
    nums = [int(t[len(prefix):]) for t in taken if t.startswith(prefix) and t[len(prefix):].isdigit()]
    nxt = max(nums, default=0) + 1
    lines = md.split("\n")
    added = 0
    for r in rows:
        if r.type == "item" and not r.id:
            raw = lines[r.line]
            cr = "\r" if raw.endswith("\r") else ""
            lines[r.line] = raw.rstrip("\r").rstrip() + f" <!-- q:{prefix}{nxt:03d} -->" + cr
            nxt += 1
            added += 1
    return "\n".join(lines), added


def plain(text: str) -> str:
    """Item Markdown as plain text for the chat prompt."""
    return re.sub(r"\s+", " ", text.replace("**", "").replace("*", "")).strip()


def _clean(name: str) -> str:
    """Trailing punctuation and possessives dropped: "Ansbach's weapon" -> Ansbach, "Patches'" -> Patches."""
    name = name.strip().strip(".,:;!?()").strip()
    return re.split(r"['’]s\b", name)[0].rstrip("'’").strip()


def bold_spans(text: str) -> list[tuple[str, list[str]]]:
    """Each bold span as (whole name, its parts): '**Blackguard, Millicent,**' -> ('Blackguard, Millicent',
    ['Blackguard', 'Millicent']). The whole span is tried first, so 'D, Hunter of the Dead' stays one name."""
    out = []
    for span in BOLD.findall(text):
        whole = _clean(span)
        parts = [p for p in (_clean(x) for x in re.split(r",|\band\b", span)) if p]
        if whole:
            out.append((whole, parts))
    return out


def bold_names(text: str) -> list[str]:
    return [p for _, parts in bold_spans(text) for p in parts]


# --- guide NPCs -------------------------------------------------------------------------------------------------


@dataclass
class Npc:
    norm: str
    name: str                       # most frequent guide spelling
    pages: list[tuple[str, int]]    # (book, page) where the entity appears


class NpcIndex:
    """NPC, merchant and boss entities of the guide extractions, and the NPC chapters (H1 on npc pages)."""

    def __init__(self, out_root: Path = ROOT / "out", books: list[str] | None = None):
        spell: dict[str, Counter] = defaultdict(Counter)
        pages: dict[str, set] = defaultdict(set)
        self.chapters: list[dict] = []    # {book, title, norm, from, to}
        for key in books or list(BOOKS):
            npc_pages: list[int] = []
            heads: list[tuple[int, str]] = []
            for f in sorted((out_root / key).glob("p[0-9][0-9][0-9][0-9].json")):
                page = json.loads(f.read_text(encoding="utf-8"))
                for e in page["entities"]:
                    if e["type"] in NPC_TYPES:
                        n = normalize_name(e["name"])
                        if n:
                            spell[n][e["name"]] += 1
                            pages[n].add((key, page["page"]))
                if page["page_type"] == "npc":
                    npc_pages.append(page["page"])
                    for h in re.findall(r"^# (.+)$", page["markdown"], re.M):
                        heads.append((page["page"], h.strip()))
            # A chapter runs from its H1 page to the page before the next H1 (npc pages only). Some pages carry an
            # event as H1 ("Event 5", "Event 1-B"): those continue the chapter. All-caps H1s are group intros
            # ("RANNI AND HER VASSALS"): they end the previous chapter but are no NPC's chapter themselves.
            heads = [(p, t) for p, t in heads if not re.match(r"Event\b", t)]
            for j, (p, title) in enumerate(heads):
                end = heads[j + 1][0] - 1 if j + 1 < len(heads) else max(npc_pages)
                if not title.isupper():
                    self.chapters.append({"book": key, "title": title, "norm": normalize_name(title), "from": p, "to": max(p, end)})
        self.mentions = {n: set(ps) for n, ps in pages.items()}
        self.npcs = {n: Npc(n, c.most_common(1)[0][0], sorted(pages[n])) for n, c in spell.items()}
        self.by_fold: dict[str, list[str]] = defaultdict(list)
        for n in self.npcs:
            self.by_fold[fold(n)].append(n)

    def chapter_for(self, norm: str, chapter_aliases: dict[str, str] | None = None) -> dict | None:
        """The NPC's chapter: an alias, else the title equal to the name, else titles that contain the name as whole
        words ("ranni" in "Ranni the Witch"), else titles whose head (before a comma or slash) is inside the name
        ("Alexander, Warrior Jar" for "iron fist alexander"). Ties go to the chapter that mentions the NPC on most
        of its pages, then to the first."""
        f = fold(norm)
        alias = (chapter_aliases or {}).get(f)
        if alias:
            return next((c for c in self.chapters if fold(c["norm"]) == fold(alias)), None)

        def has(words: str, part: str) -> bool:
            return f" {part} " in f" {words} "

        tiers = [
            [c for c in self.chapters if fold(c["norm"]) == f],
            [c for c in self.chapters if has(fold(c["norm"]), f)],
            [c for c in self.chapters if has(f, fold(normalize_name(re.split(r"[,/]", c["title"])[0])))],
        ]
        for tier in tiers:
            if tier:
                seen = self.mentions.get(norm, set())
                return max(tier, key=lambda c: (sum((c["book"], p) in seen for p in range(c["from"], c["to"] + 1)), -c["from"]))
        return None

    def resolve(self, name: str, aliases: dict[str, str], chapter_aliases: dict[str, str] | None = None) -> dict:
        """{name, norm, match, chapter} for a bold name; norm is None when unresolved."""
        target = aliases.get(fold(name))
        how = "alias" if target else None
        n = normalize_name(target or name)
        if n not in self.npcs:
            folded = self.by_fold.get(fold(n), [])
            if len(folded) == 1:
                n, how = folded[0], how or "accent"
            else:
                chap = self.chapter_for(n)
                words = [k for k in self.npcs if fold(k).startswith(fold(n) + " ") or fold(k).endswith(" " + fold(n))]
                if chap and chap["norm"] in self.npcs:
                    n, how = chap["norm"], how or "chapter"
                elif len(words) == 1:
                    n, how = words[0], how or "word"
                else:
                    close = difflib.get_close_matches(fold(n), list(self.by_fold), n=2, cutoff=CLOSE)
                    if len(close) == 1 and len(self.by_fold[close[0]]) == 1:
                        n, how = self.by_fold[close[0]][0], how or "close"
                    else:
                        return {"name": name, "norm": None, "match": "none", "chapter": None}
        how = how or "exact"
        chap = self.chapter_for(n, chapter_aliases)
        return {
            "name": name,
            "norm": n,
            "entity": self.npcs[n].name,
            "match": how,
            "chapter": {"book": chap["book"], "title": chap["title"], "from": chap["from"], "to": chap["to"]} if chap else None,
        }


# --- build ------------------------------------------------------------------------------------------------------


def build_chains(items: list[dict]) -> list[dict]:
    """Chain items (marker with "chain": true) grouped into chains of items that share a resolved NPC."""
    members = [it for it in items if it.get("_chain")]
    parent = list(range(len(members)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def bold_norms(it: dict) -> set[str]:
        return {x["norm"] for x in it["npcs"] if x["norm"] and x["match"] != "text"}

    first: dict[str, int] = {}
    for i, it in enumerate(members):
        for n in bold_norms(it):
            if n in first:
                parent[find(i)] = find(first[n])
            else:
                first[n] = i
    groups: dict[int, list[dict]] = defaultdict(list)
    for i, it in enumerate(members):
        groups[find(i)].append(it)
    chains = []
    for group in sorted(groups.values(), key=lambda g: g[0]["ord"]):
        count = Counter(n for it in group for n in bold_norms(it))
        names = {x["norm"]: x["entity"] for it in group for x in it["npcs"] if x["norm"]}
        order = [n for n, _ in sorted(count.items(), key=lambda kv: (-kv[1], min(it["ord"] for it in group if kv[0] in bold_norms(it))))]
        core = [n for n in order if count[n] * 2 > len(group)] or order[:1]
        label = " & ".join(names[n] for n in core) if core else "Linked steps"
        chain_id = "-".join(slug(names[n]) for n in core) or f"chain-{group[0]['id']}"
        for it in group:
            it["chain"] = chain_id
        chains.append({"id": chain_id, "label": label, "items": [it["id"] for it in group]})
    return chains


def build(key: str, cfg: dict, index: NpcIndex, aliases: dict[str, str], chapter_aliases: dict[str, str]) -> dict:
    src = ROOT / "config" / cfg["file"]
    raw = src.read_bytes()
    markers = cfg.get("markers", {})
    rows = parse(raw.decode("utf-8"), list(markers))
    missing = [r.line + 1 for r in rows if r.type == "item" and not r.id]
    if missing:
        raise SystemExit(f"{src.relative_to(ROOT)}: {len(missing)} item(s) without an id (lines {missing[:5]}...); run --assign-ids")
    dup = [k for k, n in Counter(r.id for r in rows if r.type == "item").items() if n > 1]
    if dup:
        raise SystemExit(f"{src.relative_to(ROOT)}: duplicate item ids {dup}")

    sections: dict[tuple, str] = {}
    out_rows: list[dict] = []
    items: list[dict] = []
    for r in rows:
        sec = sections.setdefault(tuple(r.path), "/".join(slug(p) for p in r.path) or "top")
        if r.type == "heading":
            out_rows.append({"type": "heading", "section": sec, "level": r.level, "title": r.text, "path": r.path})
        elif r.type == "note":
            out_rows.append({"type": "note", "section": sec, "text": r.text})
        else:
            mk = markers.get(r.marker or "", {})
            col = COLLECTIBLE.match(plain(r.text))
            item = {
                "type": "item",
                "id": r.id,
                "ord": len(items) + 1,
                "section": sec,
                "path": r.path,
                "text": r.text,
                "prompt": ("[" + " > ".join(r.path) + "] " if r.path else "") + plain(r.text),
                "optional": r.text.startswith("(Optional)"),
                "collectible": {"name": col.group(1).strip(), "n": int(col.group(2))} if col else None,
                "footnote": mk.get("footnote"),
                "chain": None,
                "npcs": [],
            }
            seen = set()
            for whole, parts in bold_spans(r.text):
                first = index.resolve(whole, aliases, chapter_aliases)
                # a span of several names is kept whole only on a firm match ("D, Hunter of the Dead")
                firm = first["match"] in ("exact", "alias", "accent")
                results = [first] if len(parts) < 2 or firm else [index.resolve(p, aliases, chapter_aliases) for p in parts]
                for res in results:
                    k = res["norm"] or "?" + fold(res["name"])
                    if k not in seen:
                        seen.add(k)
                        item["npcs"].append(res)
            if mk.get("chain"):
                item["_chain"] = True
            items.append(item)
            out_rows.append(item)

    # NPCs named without bold ("Summon Rogier for your fight"): any name that is bold somewhere in this checklist,
    # found as a whole word (same spelling, 3+ letters) outside the item's bold spans, is added with match "text".
    # A name followed by a capitalised word is a place or an item ("Shabriri Grape", "Ranni's Rise"), not the NPC.
    vocab: dict[str, dict] = {}
    for it in items:
        for n in it["npcs"]:
            if n["norm"] and n["match"] in ("exact", "alias", "accent") and len(n["name"]) >= 3:
                vocab.setdefault(n["name"], n)
    for it in items:
        have = {n["norm"] for n in it["npcs"]}
        text = plain(BOLD.sub(" | ", it["text"]))
        for spelling, n in sorted(vocab.items(), key=lambda kv: -len(kv[0])):
            pattern = r"(?<![\w-])" + re.escape(spelling) + r"(?![\w-])(?!(?:['’]s)?\s+[A-Z])"
            if n["norm"] not in have and re.search(pattern, text):
                it["npcs"].append({**n, "name": spelling, "match": "text"})
                have.add(n["norm"])

    chains = build_chains(items)
    for it in items:
        it.pop("_chain", None)
    footnotes = []
    for mk, spec in markers.items():
        if "footnote" in spec:
            target = [r for r in out_rows if r["type"] == "heading" and r["title"] == spec["section"]]
            if not target:
                raise SystemExit(f"{key}: marker {mk!r} points to section {spec['section']!r}, which is not in {cfg['file']}")
            footnotes.append({"id": spec["footnote"], "marker": mk, "label": spec["label"], "section": target[0]["section"],
                              "items": [it["id"] for it in items if it["footnote"] == spec["footnote"]]})
    return {
        "checklist": key,
        "title": cfg["title"],
        "label": cfg.get("label", cfg["title"]),
        "author": cfg.get("author"),
        "sourceUrl": cfg.get("sourceUrl"),
        "books": cfg["books"],
        "source": str(src.relative_to(ROOT)).replace("\\", "/"),
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "counts": {
            "items": len(items),
            "notes": sum(1 for r in out_rows if r["type"] == "note"),
            "sections": sum(1 for r in out_rows if r["type"] == "heading"),
        },
        "chains": chains,
        "footnotes": footnotes,
        "rows": out_rows,
    }


def load_aliases() -> tuple[dict[str, str], dict[str, str]]:
    """config/checklists/aliases.json: {"names": {bold name: guide entity}, "chapters": {guide entity: chapter title}}."""
    if not ALIASES_PATH.exists():
        return {}, {}
    data = json.loads(ALIASES_PATH.read_text(encoding="utf-8"))
    return ({fold(k): v for k, v in data.get("names", {}).items()},
            {fold(k): v for k, v in data.get("chapters", {}).items()})


# --- self test --------------------------------------------------------------------------------------------------

SAMPLE = """\r
## Limgrave\r
\r
- Talk to **Boc** at the Coastal Cave <!-- q:m002 -->\r
    \r
- ***** Go through Caria Manor and speak to **Ranni.** Then return to **Rogier**\r
### Sub area\r
Note: a note paragraph.\r
- ** Talk to **Corhyn** and **Goldmask**, then **Blackguard, Millicent,** and **Ansbach's weapon**\r
- Deathroot #3 Northeast of the ruins\r
- **Forager Brood** Cookbook #2: Head south\r
- (Optional) Summon **Freyja**\r
## Next\r
#### Deep\r
- last\r
"""


def selftest() -> None:
    rows = parse(SAMPLE, ["*****", "**"])
    kinds = [(r.type, r.path) for r in rows]
    assert kinds[0] == ("heading", ["Limgrave"]), kinds
    items = [r for r in rows if r.type == "item"]
    assert len(items) == 7, [r.text for r in items]
    assert items[0].id == "m002" and items[0].text == "Talk to **Boc** at the Coastal Cave", items[0]
    assert items[1].marker == "*****" and items[1].text.startswith("Go through"), items[1]
    assert items[2].marker == "**" and items[2].path == ["Limgrave", "Sub area"], items[2]
    assert items[4].marker is None and items[4].text.startswith("**Forager Brood**"), "real bold is not a marker"
    assert [r.text for r in rows if r.type == "note"] == ["Note: a note paragraph."]
    assert rows[-2].type == "heading" and rows[-2].path == ["Next", "Deep"], rows[-2]
    assert bold_names(items[2].text) == ["Corhyn", "Goldmask", "Blackguard", "Millicent", "Ansbach"], bold_names(items[2].text)
    assert bold_names(items[1].text) == ["Ranni", "Rogier"]
    assert COLLECTIBLE.match(plain(items[3].text)).groups() == ("Deathroot", "3")
    assert COLLECTIBLE.match(plain(items[4].text)).groups() == ("Forager Brood Cookbook", "2")
    assert COLLECTIBLE.match(plain(items[0].text)) is None
    assert plain(items[2].text).startswith("Talk to Corhyn and Goldmask, then Blackguard, Millicent,")
    text, added = assign_ids(SAMPLE, "m", ["*****", "**"])
    assert added == 6, added
    again = parse(text, ["*****", "**"])
    ids = [r.id for r in again if r.type == "item"]
    assert ids == ["m002", "m003", "m004", "m005", "m006", "m007", "m008"], ids
    assert "\r\n" in text and "\n" not in text.replace("\r\n", ""), "CRLF kept"
    assert assign_ids(text, "m", ["*****", "**"])[1] == 0, "idempotent"
    assert fold("Jolán") == fold("jolan") == "jolan"
    print("checklist_build: selftest ok")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checklist", action="append", help="checklist id from config/checklists.json (default: all)")
    ap.add_argument("--assign-ids", action="store_true", help="add ids to bullets that have none, then build")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    config = load_config()
    keys = args.checklist or list(config)
    unknown = [k for k in keys if k not in config]
    if unknown:
        raise SystemExit(f"unknown checklist(s) {unknown}; configured: {list(config)}")
    aliases, chapter_aliases = load_aliases()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key in keys:
        cfg = config[key]
        bad = [b for b in cfg["books"] if b not in BOOKS]
        if bad:
            raise SystemExit(f"{key}: books {bad} are not guide books in config/books.json")
        if args.assign_ids:
            src = ROOT / "config" / cfg["file"]
            text, added = assign_ids(src.read_bytes().decode("utf-8"), cfg["idPrefix"], list(cfg.get("markers", {})))
            if added:
                src.write_bytes(text.encode("utf-8"))
            print(f"{key}: {added} id(s) added to {cfg['file']}")
        index = NpcIndex(books=cfg["books"])
        data = build(key, cfg, index, aliases, chapter_aliases)
        (OUT_DIR / f"{key}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        items = [r for r in data["rows"] if r["type"] == "item"]
        names = [n for it in items for n in it["npcs"]]
        unresolved = sorted({n["name"] for n in names if not n["norm"]})
        print(f"{key}: {data['counts']['items']} items, {data['counts']['notes']} notes, {data['counts']['sections']} sections; "
              f"{len(data['chains'])} chain(s), {sum(len(f['items']) for f in data['footnotes'])} footnoted item(s); "
              f"NPC names {len(names) - sum(1 for n in names if not n['norm'])}/{len(names)} resolved -> out/checklists/{key}.json")
        if unresolved:
            print(f"  unresolved: {', '.join(unresolved)}")


if __name__ == "__main__":
    main()
