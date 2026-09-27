# Quest checklist runbook

What the checklist is and why it is built this way: `docs/build-spec-checklist.md`. This page covers keeping
it running: editing a list, rebuilding the page links, fixing a bad link, adding a list, and accounts and
progress.

The lists are u/Stellarwand's Reddit posts "All NPC interactions in Elden Ring" and "... in Shadow of the
Erdtree", imported with typos fixed. The app credits the author and links each post; keep that when you edit.

## What lives where

| path | what | in git? |
| --- | --- | --- |
| `config/checklists.json` | the lists: title, label, file, author, source URL, the guide books its links and questions use, id prefix, item markers | yes |
| `config/checklists/<id>.md` | the list itself (below) | yes |
| `config/checklists/aliases.json` | `names`: bold name -> guide entity; `chapters`: entity -> chapter title, for names the matcher cannot resolve | yes |
| `out/checklists/<id>.json` | the build: rows in order, NPCs with their guide chapters, chains, footnotes | no (out/) |
| `out/checklists/<id>_pages.json` | the top 3 guide pages per item (retrieval, embedding only) | no |
| `out/checklists/<id>_overrides.json` | hand corrections (below), optional | no |
| `out/checklists/<id>_qa.md` | QA report | no |
| database | `checklists`, `checklist_items`, and the users' `runs` and `progress` | no; **progress exists only here**, so back it up (README, moving the stack) |

## The list format

```
## Liurnia of the Lakes                       <- section (## top level, ### and #### nested)
### Southeast Liurnia
Note: a plain line is a note, shown in place without a checkbox.
- Meet **Hyetta** at the Lake-Facing Cliffs Grace. ... <!-- q:m038 -->
- ** Talk to **Corhyn** next to the map ... <!-- q:m091 -->
- ***** Go through Caria Manor and speak to **Ranni.** ... <!-- q:m065 -->
```

- A `- ` bullet is an item. Keep each item on one line.
- **Bold** names are NPCs. The build links them to the guides' NPC chapters, and names bolded anywhere in the
  list are also found in plain text.
- A leading `**` (followed by a space) marks steps that belong together: chains, grouped by shared NPC. A leading
  `*****` is the asterisk footnote to the Frenzied Flame Ending section. The meanings are set per list under
  `markers` in `config/checklists.json`.
- `<!-- q:m038 -->` is the item's id. **Never change or reuse an id**: progress is stored against it. Edit the
  text freely; the id keeps the tick.
- The files are CRLF. Edit them in an editor or with the Edit tool; `sed -i` in Git Bash turns them into LF (the
  build does not mind, but the diff gets noisy).

## Rebuild after editing a list

All in Docker, from the repo root:

```
npm run py -- scripts/checklist_build.py --assign-ids   # new bullets get the next free ids (m197, ...); then builds
npm run checklist-pages                                 # page links for new or changed items only (~$0, seconds)
npm run py -- scripts/checklist_qa.py                   # out/checklists/<id>_qa.md
npm run index                                           # loads the lists (unchanged ones are skipped)
```

- Without new bullets, `checklist_build.py` alone is enough. It refuses to build while an item has no id.
- The build prints unresolved NPC names. Add those to `aliases.json` `names`, or fix the spelling in the list.
- The index retires an item that is no longer in the list; it is not deleted. Its ticks stay in the database,
  and the app shows ticked retired steps at the end of the list. Putting the bullet back (same id) restores it.
- On the host the same steps are `uv run python scripts/checklist_build.py ...`,
  `node packages/api/dist/checklist-pages-cli.js` (after `npm run build`) and
  `node packages/indexer/dist/cli.js checklists`. Host and Docker builds are byte-identical.

## Read the QA report

`out/checklists/<id>_qa.md` rates each item's page links:

| rating | meaning |
| --- | --- |
| chapter | the top page lies in the guide chapter of an NPC the item names (usually the best page) |
| chapter+ | the NPC's chapter is the 2nd or 3rd page |
| npc-page | the top page mentions the item's NPC |
| no-npc | the item names no NPC (collectibles, places): look at the pages |
| check | none of the above: look at these first |

It also lists the `**` chains and `*****` footnotes as parsed, names that did not match exactly, each NPC's
chapter, and a fixed sample of 20 items. As of 2026-09-27: main 110 / 40 / 9 / 20 / 17, dlc 31 / 14 / 5 / 5 / 14.
Most "check" items point to the right walkthrough, map or boss page.

## Fix a bad page link or prompt

`out/checklists/<id>_overrides.json`:

```json
{"items": {"d047": {"pages": [{"book": "vol3", "page": 68}, {"book": "vol3", "page": 69}], "note": "Abyssal Woods maps, not the progression page"}}}
```

- `pages` replaces the item's links (and the chat's focus pages). `prompt` replaces the question Ask sends.
- `npm run index` applies it, and so does the QA report. The builders never touch it.
- An override for an id that is not in the list, or a page outside the list's `books`, stops the index for that
  list with a message.

## After retakes or a new book

- A retake replaces a page's photo and extraction, but the page number stays, so links stay valid. If a retake
  changed a quest page a lot, `npm run checklist-pages -- --force` looks every item up again (seconds, a
  fraction of a cent).
- A new guide book is not used by a list until it is in that list's `books` in `config/checklists.json`. Then run
  `checklist-pages -- --force`, the QA report and `npm run index`.

## Add a list

1. Put the Markdown under `config/checklists/<id>.md` in the format above, and credit the source.
2. Add an entry to `config/checklists.json` with a new `idPrefix` (ids must be unique across lists, so the index
   refuses clashes), its `books`, and `markers` (`{}` if none).
3. Run the four steps of "Rebuild after editing a list".

## Accounts and progress

- Every user's progress belongs to a run (a character or NG+); each account keeps at least one.
- Ticking needs a login; reading the list and Ask do not (unless `AUTH_REQUIRED=true`).
- Admins create accounts in the app (your name > Users) or with `npm run user -- add <name> [--admin]`. The admin
  list shows items done per user.
- Deleting a user deletes their runs and progress. `npm run reset` drops the database, and with it every
  account and tick. `npm run export` (README, "Backup, restore and moving to another machine") keeps them, and the backup includes the
  `users`, `sessions`, `runs`, `progress`, `checklists` and `checklist_items` tables.
