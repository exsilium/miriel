"""Check English artwork names against the entity names of the guide extractions (docs/build-spec-artbooks.md §4.8).

A name is `verified` when it matches a guide entity (or page region) name after normalisation: exactly, with the
words in another order, or with one clear close spelling (similarity >= CLOSE). The guide spelling is recorded
as `entity`, so the index can join on it; unverified names are kept and listed by scripts/art_qa.py.

  uv run python scripts/art_names.py --selftest
  uv run python scripts/art_names.py "Raya Lucaria Academy" "Grafted Scion"      # look names up
  uv run python scripts/art_names.py --recheck out/art1                          # re-run the check on label files
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
import unicodedata
from collections import Counter
from functools import lru_cache
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pages import BOOKS, ROOT  # noqa: E402

CLOSE = 0.92


def normalize_name(name: str) -> str:
    """Python twin of normalizeName() in packages/shared/src/normalize.ts; keep the two in step (see --selftest)."""
    s = unicodedata.normalize("NFKC", name).lower()
    s = re.sub(r"['’‘]", "", s)
    s = "".join(c if c.isspace() or unicodedata.category(c)[0] in "LN" else " " for c in s)
    return re.sub(r"\s+", " ", s).strip()


class NameIndex:
    """name_norm -> most frequent guide spelling, over every guide's out/<id>/p*.json."""

    def __init__(self, out_root: Path = ROOT / "out"):
        counts: dict[str, Counter] = {}
        for key in BOOKS:
            for f in sorted((out_root / key).glob("p[0-9][0-9][0-9][0-9].json")):
                page = json.loads(f.read_text(encoding="utf-8"))
                spellings = [e["name"] for e in page["entities"]] + ([page["region"]] if page.get("region") else [])
                for name in spellings:
                    n = normalize_name(name)
                    if n:
                        counts.setdefault(n, Counter())[name] += 1
        self.spelling = {n: c.most_common(1)[0][0] for n, c in counts.items()}
        self.norms = sorted(self.spelling)
        self.by_sorted_words: dict[str, str] = {}
        for n in self.norms:
            self.by_sorted_words.setdefault(" ".join(sorted(n.split())), n)

    def __len__(self) -> int:
        return len(self.spelling)

    def match(self, name: str) -> dict:
        """{verified, entity, match}: match is exact | word_order | prefix | close | none."""
        n = normalize_name(name)
        if n in self.spelling:
            return {"verified": True, "entity": self.spelling[n], "match": "exact"}
        alt = self.by_sorted_words.get(" ".join(sorted(n.split())))
        if alt:
            return {"verified": True, "entity": self.spelling[alt], "match": "word_order"}
        # the guide name is the start of a longer title ("Queen Marika the Eternal" -> "Queen Marika"); two words
        # at least, the longest wins; flagged as "prefix" so QA can review it
        words = n.split()
        for k in range(len(words) - 1, 1, -1):
            head = " ".join(words[:k])
            if head in self.spelling:
                return {"verified": True, "entity": self.spelling[head], "match": "prefix"}
        close = difflib.get_close_matches(n, self.norms, n=2, cutoff=CLOSE)
        # one clear winner only: two near-identical candidates ("... Set" vs "... Helm") are not a match
        if len(close) == 1 or (len(close) == 2 and difflib.SequenceMatcher(None, n, close[1]).ratio() < CLOSE + 0.03):
            if close:
                return {"verified": True, "entity": self.spelling[close[0]], "match": "close"}
        return {"verified": False, "entity": None, "match": "none"}


@lru_cache(maxsize=1)
def default_index() -> NameIndex:
    return NameIndex()


def annotate(label: dict, index: NameIndex) -> None:
    """Add verified/entity/match to every name in a label file's artworks, in place."""
    for art in label["artworks"]:
        for nm in art["names"]:
            nm.update(index.match(nm["name"]))


def selftest() -> None:
    cases = {
        "Oridys's Rise": "oridyss rise",
        "Lenne’s Rise": "lennes rise",
        "Roots of the Haligtree–Floor 3": "roots of the haligtree floor 3",
        "Demi-Human Forest Ruins": "demi human forest ruins",
        "Dominula, Windmill Village": "dominula windmill village",
        "  Golden Rune [3] ": "golden rune 3",
        "Highway Lookout Tower (Altus Plateau)": "highway lookout tower altus plateau",
    }
    for raw, want in cases.items():
        got = normalize_name(raw)
        assert got == want, f"normalize_name({raw!r}) = {got!r}, want {want!r}"
    for s in ["Meteorite Staff", "Night's Cavalry (Flail)", "Castle Morne Rampart"]:
        assert normalize_name(normalize_name(s)) == normalize_name(s)
    print(f"normalize_name: {len(cases) + 3} cases ok")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--recheck", type=Path, metavar="DIR", help="re-annotate every s*.json label file in DIR")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    index = default_index()
    print(f"{len(index)} guide names indexed")
    for name in args.names:
        print(f"  {name!r}: {index.match(name)}")
    if args.recheck:
        changed = 0
        for f in sorted(args.recheck.glob("s[0-9][0-9][0-9][0-9].json")):
            label = json.loads(f.read_text(encoding="utf-8"))
            before = json.dumps(label, ensure_ascii=False)
            annotate(label, index)
            after = json.dumps(label, ensure_ascii=False, indent=2)
            if json.dumps(label, ensure_ascii=False) != before:
                f.write_text(after + "\n", encoding="utf-8")
                changed += 1
        print(f"rechecked {args.recheck}: {changed} file(s) changed")


if __name__ == "__main__":
    main()
