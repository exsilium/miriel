-- Quest checklists and progress (docs/build-spec-checklist.md §4, Phase D). Loaded by `indexer checklists` (also
-- run by `ingest --all`) from out/checklists/<id>.json (scripts/checklist_build.py), <id>_pages.json
-- (`npm run checklist-pages`) and the hand corrections in <id>_overrides.json.
--
-- Item ids are the `<!-- q:m001 -->` ids in config/checklists/<id>.md; they never change when a bullet is edited.
-- An item that disappears from its list is retired (retired_at), not deleted, and progress refers to item ids
-- without a foreign key, so re-indexing, retiring and re-adding never lose a tick.

CREATE TABLE checklists (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  label         text NOT NULL,
  author        text,
  source_url    text,
  books         text[] NOT NULL DEFAULT '{}',   -- guide books the items' page links and chat questions use
  sort          int NOT NULL DEFAULT 0,
  -- headings, notes and item ids in file order: [{type: heading|note|item, ...}]
  outline       jsonb NOT NULL DEFAULT '[]',
  chains        jsonb NOT NULL DEFAULT '[]',     -- [{id, label, items[]}]  (`**` items)
  footnotes     jsonb NOT NULL DEFAULT '[]',     -- [{id, marker, label, section, items[]}]  (`*****` items)
  source_hash   text,                            -- sha256 of the build, pages and overrides files
  indexed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_items (
  id            text PRIMARY KEY,                -- the q: id, e.g. m042
  checklist_id  text NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  ord           int NOT NULL,                    -- position in the list (1-based)
  section       text NOT NULL,                   -- section slug path, e.g. liurnia-of-the-lakes/central-liurnia
  path          text[] NOT NULL DEFAULT '{}',    -- section titles
  text          text NOT NULL,                   -- display Markdown (bold NPC names)
  prompt        text NOT NULL,                   -- the chat question: "[Section > Sub] plain text"
  optional      boolean NOT NULL DEFAULT false,
  collectible   jsonb,                           -- {name, n} for "Deathroot #3" and the like
  footnote      text,
  chain         text,
  npcs          jsonb NOT NULL DEFAULT '[]',     -- [{name, norm, entity, match, chapter{book,title,from,to}}]
  pages         jsonb NOT NULL DEFAULT '[]',     -- [{book, page, score}]: "Open page" and the chat focus
  retired_at    timestamptz
);

CREATE INDEX checklist_items_list_idx ON checklist_items (checklist_id, ord);

CREATE TABLE progress (
  run_id    uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  item_id   text NOT NULL,                       -- no FK: retired and re-added items keep their ticks
  done_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, item_id)
);
