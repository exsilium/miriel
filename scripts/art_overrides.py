"""Manual corrections to art labels: out/<art id>/_overrides.json (docs/build-spec-artbooks.md §5.3).

Label files (out/<id>/sNNNN.json) stay exactly as the model wrote them; corrections live beside them, so re-running
scripts/art_label.py never loses them. Readers (scripts/art_qa.py, `indexer ingest` in Phase C) apply them.

  {
    "60":  { "artworks": { "1": { "names": [{ "name": "Academy of Raya Lucaria", "source": "caption" }] } } },
    "166": { "artworks": { "20": { "names": [{ "name": "Recusant Finger", "source": "caption" }] },
                           "30": { "drop": true } },
             "note": "why, for the next reader" }
  }

Keys: PDF page, then the 1-based artwork index within that spread's `artworks`. Allowed fields per artwork: names,
kind, caption_ja, description, confidence (replace the model's value), and drop (remove the artwork). Names are
re-checked against the guide entities after an override.
"""
from __future__ import annotations

import json
from pathlib import Path

FIELDS = {"names", "kind", "caption_ja", "description", "confidence", "drop"}


def load_overrides(out_dir: Path) -> dict[int, dict]:
    path = out_dir / "_overrides.json"
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    out: dict[int, dict] = {}
    for page, spec in raw.items():
        for idx, fields in spec.get("artworks", {}).items():
            unknown = set(fields) - FIELDS
            if unknown:
                raise ValueError(f"{path}: spread {page} artwork {idx}: unknown field(s) {sorted(unknown)}")
        out[int(page)] = spec
    return out


def apply_overrides(label: dict, spec: dict | None, index=None) -> dict:
    """A copy of the label file with the spread's overrides applied (names re-checked when `index` is given)."""
    if not spec:
        return label
    label = json.loads(json.dumps(label))
    arts = label["artworks"]
    changes = spec.get("artworks", {})
    for idx, fields in changes.items():
        i = int(idx) - 1
        if not 0 <= i < len(arts):
            raise ValueError(f"spread {label['pdf_page']}: override for artwork {idx}, which does not exist ({len(arts)})")
        for k, v in fields.items():
            if k != "drop":
                arts[i][k] = v
        arts[i]["overridden"] = True
    label["artworks"] = [a for i, a in enumerate(arts) if not changes.get(str(i + 1), {}).get("drop")]
    if index is not None:
        for a in label["artworks"]:
            for n in a["names"]:
                n.update(index.match(n["name"]))
    return label
