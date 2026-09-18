"""JSON Schema for one extracted page. Mirrors the Output section of prompts/page-extraction-prompt.md.

If the prompt's output block changes, change this file to match.
"""
from __future__ import annotations

PAGE_TYPES = ["walkthrough", "map", "item_table", "boss", "npc", "lore", "index", "other"]
FIGURE_KINDS = ["map", "screenshot", "diagram", "icon_row"]
ENTITY_TYPES = [
    "item", "weapon", "armor", "talisman", "spell", "ash_of_war", "consumable", "key_item",
    "location", "region", "dungeon", "boss", "enemy", "npc", "merchant", "site_of_grace",
]
IMAGE_QUALITY = ["good", "usable", "poor", "unusable"]
QUALITY_ISSUES = [
    "blur", "glare", "shadow", "skew", "crop_cut_off", "low_resolution", "page_curl", "motion_blur",
    "color_cast", "fingers_or_obstruction", "two_pages_in_frame", "other",
]
OCR_AGREEMENT = ["high", "medium", "low"]


def _nullable(t: str) -> dict:
    return {"type": [t, "null"]}


PAGE_SCHEMA: dict = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["book", "page", "chapter", "region", "page_type", "markdown", "figures", "entities", "quality"],
    "properties": {
        "book": {"type": "string", "minLength": 1},
        "page": {"type": "integer", "minimum": 0},
        "chapter": _nullable("string"),
        "region": _nullable("string"),
        "page_type": {"enum": PAGE_TYPES},
        "markdown": {"type": "string"},
        "figures": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "description", "labels", "legend"],
                "properties": {
                    "kind": {"enum": FIGURE_KINDS},
                    "description": {"type": "string"},
                    "labels": {"type": "array", "items": {"type": "string"}},
                    "legend": _nullable("string"),
                },
            },
        },
        "entities": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["type", "name", "location", "how_to_obtain", "connects_to"],
                "properties": {
                    "type": {"enum": ENTITY_TYPES},
                    "name": {"type": "string", "minLength": 1},
                    "location": _nullable("string"),
                    "how_to_obtain": _nullable("string"),
                    "connects_to": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "quality": {
            "type": "object",
            "additionalProperties": False,
            "required": [
                "image_quality", "quality_issues", "affected_areas", "retake_recommended",
                "retake_reason", "ocr_agreement", "illegible_regions", "notes",
            ],
            "properties": {
                "image_quality": {"enum": IMAGE_QUALITY},
                "quality_issues": {"type": "array", "items": {"enum": QUALITY_ISSUES}},
                "affected_areas": _nullable("string"),
                "retake_recommended": {"type": "boolean"},
                "retake_reason": _nullable("string"),
                "ocr_agreement": {"enum": OCR_AGREEMENT},
                "illegible_regions": {"type": "integer", "minimum": 0},
                "notes": _nullable("string"),
            },
        },
    },
}
