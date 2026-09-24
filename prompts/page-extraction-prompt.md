# Elden Ring Strategy Guide — Page Extraction Prompt

## Source files

All source files live under `data/` (gitignored; `DATA_DIR`). The authoritative list is `config/books.json`; this table mirrors it.

| Book (config id) | OCR PDF | Page images | `{{BOOK}}` |
|------|---------|-------------|-----------|
| Vol 1 — The Lands Between (`vol1`) | `data/Elden Ring Vol 1 - The Lands Between.pdf` (513 pages) | `data/Elden Ring Vol 1 - The Lands Between/` (513 images, `… - N.jpg`) | `Vol 1 - The Lands Between` |
| Vol 2 — Shards of the Shattering (`vol2`) | `data/Elden Ring Vol 2 - Shards of the Shattering.pdf` (530 pages) | `data/Elden Ring Vol 2 - Shards Of The Shattering/` (530 images; two stray shots, a duplicate of printed 206 and a mid-page-turn photo, were moved to `_extra/` and the rest renumbered, see `_renumber-log.json`) | `Vol 2 - Shards of the Shattering` |

Use the PDF for OCR text (extract the text layer per page) and the image directory for the page image. Match them by page index; confirm the mapping with `scripts/check_offset.py --book <id> --images all` (printed page + `printedToPdfOffset` = PDF page = image number; it also matches every image file against the photo embedded in its PDF page, which is how the Vol 2 stray shots were found; offset 1 for both volumes, verified 2026-09-23), since PDF page index and printed page number are offset by the front matter.

## Test run

Before running the whole book, run a small representative subset:

1. **Select pages.** Pick one of each type from Vol 1 and record the *printed* page numbers here:

   | Page type | Printed page | Why |
   |-----------|--------------|-----|
   | Dense walkthrough (two-column text) | 159 | text reading order, cross-references |
   | Full-page or large map with numbered legend | 73 | figure labels, legend mapping |
   | Item table (weapons/armor stats) | 33 | table fidelity, column preservation |
   | Boss page with stat block and sidebars | 316 | blockquotes, inline stat tables |
   | Lore / NPC page | 501 | entity extraction without locations |
   | One page you already know is a weak scan | 289 | exercises the quality flagging |

   Vol 2 (combat guide and bestiary; it has no maps):

   | Page type | Printed page | Why |
   |-----------|--------------|-----|
   | Boss with stat block (resistances, location/HP/runes, drops) | 200 | Ancient Dragon Lansseax; two side-by-side resistance tables |
   | Attribute tables (systems guide) | 11 | Strength & Dexterity scaling tables |
   | Bestiary enemy with two-column resistance tables and drop table | 60 | Exile Soldiers; drop table with location rows |
   | Weapon stat table | 280 | Axe of Godrick |
   | Armour set table (damage negation vs. resistance) | 343 | Night's Cavalry Set |
   | Lore page | 507 | Lichdragon Fortissax |
   | Dense image-and-caption page | 247 | Special Enemies / Artillery; small caption text |

2. **Build a test PDF** containing only those pages, extracted from the source PDF in the same order, saved with the matching page images and a manifest in `./test-pages/<book>/` (`uv run python scripts/build_fixture.py --book vol1 --pages 159,73,33,316,501,289`; Vol 2: `--book vol2 --pages 200,11,60,280,343,507,247`). This gives a small, reproducible fixture you can re-run every time you change the prompt.

3. **Run the prompt** once per page: this prompt, the page image at full resolution, the OCR text for that page, with `{{BOOK}}` and `{{PAGE}}` filled in.

4. **Review** by checking, per page: are names spelled exactly as printed, do map labels match the legend count, do entity names appear verbatim in `markdown`, and does `quality.retake_recommended` agree with your own eye. Adjust the prompt, re-run the fixture, and only then move to the full book.

## Template variables

`{{BOOK}}` (e.g. `Vol 1 - The Lands Between`), `{{PAGE}}` (printed page number, integer).
Send per request: this prompt, the page image at full resolution, then the OCR text as a plain text block.

---

You are transcribing one page of an Elden Ring strategy guide into structured data for a search index.

## Inputs

You receive:

1. **An image of the page.** This is the authoritative source for layout, tables, maps, callouts, and figure labels.
2. **OCR text from the same page.** Use it to confirm spelling of names and numbers. It may have merged columns, dropped tables, or garbled small print — trust the image where they disagree.
3. **Metadata:** book = `{{BOOK}}`, page = `{{PAGE}}`.

## Output

Produce a single JSON object and nothing else — no preamble, no explanation, no code fences.

```
{
  "book": "{{BOOK}}",
  "page": {{PAGE}},
  "chapter": "running chapter/section header if printed on the page, else null",
  "region": "the in-game region this page is primarily about (e.g. Limgrave, Caelid, Liurnia of the Lakes), else null",
  "page_type": "one of: walkthrough | map | item_table | boss | npc | lore | index | other",
  "markdown": "full page content as Markdown — see rules",
  "figures": [
    {
      "kind": "map | screenshot | diagram | icon_row",
      "description": "what it shows, in 1–3 sentences",
      "labels": ["every marker, number, or label printed on the figure, verbatim"],
      "legend": "the legend or key text if present, else null"
    }
  ],
  "entities": [
    {
      "type": "item | weapon | armor | talisman | spell | ash_of_war | consumable | key_item | location | region | dungeon | boss | enemy | npc | merchant | site_of_grace",
      "name": "exact in-game name as printed",
      "location": "where it is found or where it lives, as stated on this page, else null",
      "how_to_obtain": "the steps or condition stated on this page, else null",
      "connects_to": ["other locations this page says are adjacent or reachable from here"]
    }
  ],
  "quality": {
    "image_quality": "one of: good | usable | poor | unusable",
    "quality_issues": ["zero or more of: blur | glare | shadow | skew | crop_cut_off | low_resolution | page_curl | motion_blur | color_cast | fingers_or_obstruction | two_pages_in_frame | other"],
    "affected_areas": "which parts of the page are affected (e.g. 'bottom-right map legend', 'entire left column'), else null",
    "retake_recommended": true or false,
    "retake_reason": "one sentence on what a re-shoot should fix, else null",
    "ocr_agreement": "one of: high | medium | low",
    "illegible_regions": "integer count of [illegible] markers you inserted in markdown",
    "notes": "anything else odd: rotated page, two-page spread, missing page number, etc., else null"
  }
}
```

## Order of work

1. **Assess the image first** and fill in `quality` mentally before transcribing. Knowing which areas are degraded tells you where to lean on the OCR text and where to insert `[illegible]`.
2. Transcribe the page into `markdown`.
3. Describe figures.
4. Extract entities from the text you just transcribed.
5. Finalise `quality` with the actual counts.

## Rules for `markdown`

- Follow reading order: main body first, then sidebars and callout boxes. Wrap each sidebar as a `>` blockquote with a bold title line as its first line.
- Reproduce tables as Markdown tables. Keep every column, even if a cell is empty. Do not collapse or reorder columns.
- Use `#` / `##` / `###` headings matching the visual hierarchy on the page.
- Render inline stat blocks (weapon requirements, scaling, damage types, spell FP cost, etc.) as tables too.
- Where a figure sits in the layout, insert a placeholder line `[FIGURE n: short description]` where `n` matches the index in the `figures` array (1-based).
- Preserve item, location, boss, and NPC names **exactly as printed**, including apostrophes, hyphens, and capitalisation (e.g. `Lenne's Rise`, not `Lennes Rise`; `Meteorite Staff`, not `meteorite staff`).
- If text is unreadable in both the image and the OCR, write `[illegible]`. Never guess and never fill in from your own knowledge of the game — the index must reflect only what the book says.
- Do not summarise, do not omit "minor" text (footnotes, tips, warnings, page cross-references like "see p. 214"), and do not add commentary.
- Preserve cross-references verbatim; they are useful for linking pages later.

## Rules for `figures`

- One entry per distinct figure. Decorative borders, background art, and page furniture are not figures.
- **Maps get special care.** List every numbered or lettered marker in `labels`. If a legend maps markers to names, put the full mapping in `legend` as a single string: `"1 = Site of Grace, 2 = Meteorite Staff, 3 = Teardrop Scarab, ..."`.
- If a map or figure spans two pages, note that in `quality.notes` and describe only what is visible on this page.
- For screenshots, describe what the screenshot demonstrates (e.g. "player standing at the ledge west of the ruins, showing the drop-down path") and transcribe any overlaid labels or arrows.

## Rules for `entities`

- Record only what is **explicitly on this page**. If an item is merely mentioned without a location or obtain steps, still record it with those fields `null`.
- One entry per distinct entity; merge duplicate mentions on the same page.
- Use the **same exact name string** you used in `markdown` so the two can be joined later without fuzzy matching.
- `connects_to` is for spatial adjacency stated on the page ("north of", "reached via", "the path continues to"). Do not infer connections from your own knowledge.
- Merchants and NPCs that sell items: record the NPC as an entity and each sold item as its own entity with `location` set to the NPC's name and `how_to_obtain` set to the price or condition if printed.
- Sites of Grace are always recorded as entities when named on the page; they are the anchors for route questions.

## Rules for `quality`

Grade `image_quality` on the **worst-affected area that carries content**, not the page average. A sharp page with a blurred map legend is `poor`, because the legend is the content that matters.

- `good`: all text and figure labels crisp and fully in frame.
- `usable`: minor issues, but every word and label is still readable with confidence.
- `poor`: some content is unreadable or had to be inferred from OCR/context; transcription is incomplete or uncertain.
- `unusable`: most of the page cannot be read reliably.

Set `retake_recommended = true` whenever **any** of these hold:

- `image_quality` is `poor` or `unusable`
- any figure has labels you could not read
- `illegible_regions > 0` and the cause is the photograph rather than the original print

Small tables and map markers are the first things a retake fixes, so err toward recommending one.

In `retake_reason` be specific and actionable, e.g. `"glare across the top third hides the section header"`, `"map in bottom-right is out of focus, markers 4–7 unreadable"`, `"page cropped, right column cut off at ~5 mm"`.

`ocr_agreement`:

- `high`: OCR matches what you read, minor punctuation differences at most
- `medium`: OCR has some misspelled names or a broken table but is mostly usable
- `low`: OCR merged columns, dropped a table, or misspells names you can read clearly in the image

Low agreement with a `good` image means **re-OCR, not re-shoot**. Say which action is needed in `notes`.

Still produce your best transcription even for `poor` pages — the flag is for triage, not a reason to skip work. For `unusable` pages, fill `markdown` with whatever is legible and mark the rest `[illegible]`.

## Formatting constraints

- Output must be valid JSON. Escape newlines inside `markdown` as `\n` and double quotes as `\"`.
- Use `null` (not empty string) for absent values; use `[]` for empty arrays.
- `page` and `illegible_regions` are integers, `retake_recommended` is a boolean.
- Do not wrap the output in Markdown code fences.