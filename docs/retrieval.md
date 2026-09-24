# Retrieval: how a query flows through the system

Implementation: `packages/api/src/retrieval/`. Harness:

```
npm run retrieve -- "How do I get from Castle Morne Rampart to Oridys's Rise?"
npm run retrieve -- --rerank --k 8 "which bosses are in Miquella's Haligtree"
npm run retrieve -- --json "..."            # full RetrievalResult
npm run retrieve -- --prior "castle morne" "how do I get there"   # previous turn's entities
```

`retrieve(query, opts)` is a pure module (no HTTP): it takes a Postgres pool,
an `EmbeddingProvider` and optionally a `RerankProvider`, and returns a
`RetrievalResult` with `anchors`, ranked `chunks`, and for route questions
full `pages`.

## 1. Entity resolution (`resolve.ts`, `candidates.ts`)

Runs first and in parallel with the query embedding and the lexical search.

1. **Candidates.** Word n-grams of 1 to 4 words, skipping n-grams that start
   or end with a stopword (a name may start with a capitalised stopword:
   "The Four Belfries"), plus the whole query. Each candidate is normalised
   with the shared `normalizeName` (the same function the indexer used for
   `entities.name_norm`).
2. **Exact match** of every candidate against `entities.name_norm`
   (btree index) and against the distinct `pages.region` values. The region
   match exists because names like "Miquella's Haligtree" are often only the
   page's region and not an entity on the page; a region match becomes a
   synthetic entity of type `region` whose pages are every page in that region.
3. **Trigram match** (`name_norm % candidate`, `pg_trgm`, similarity >= 0.6)
   for candidates that did not match exactly and are eligible for fuzzy
   matching: capitalised n-grams, multi-word n-grams of 8+ characters, and the
   whole query. A fuzzy match on a name that appears on more than 40 pages
   (`trigramMaxPages`; "Golden Rune") is dropped: with 13k+ entities such a
   match anchors nothing useful. Exact matches are never dropped.
4. **Span selection.** Among candidates that matched something, an exact span
   beats a trigram span that contains it ("godskin apostle" over "godskin
   apostle drop"); otherwise the longest span wins ("Lenne's Rise" over
   "Rise").
5. **Prior entities** (`opts.priorEntities`, `name_norm` values from the
   previous turn) are looked up exactly and added with `match: "prior"`, so
   "how do I get there?" resolves "there".
6. **Grouping.** Rows are grouped by `name_norm` into `ResolvedEntity`
   `{name, types[], pages[], match, similarity, matchedText, isLocation}`.
7. **Anchor pages.** Rows on `index`-type pages are discarded first: the
   index names everything and would anchor every query. Then:
   - **Own pages** (x2 boost) = the pages the entities appear on, except for
     *containers*: an entity the book types as `region` on any page ("Liurnia",
     "Altus Plateau", but also "Volcano Manor", which is dungeon, location and
     region). A container is named on dozens of pages, so its own pages are
     only its `map`-type pages (else its first page).
   - **One hop** through `entity_links` in either direction, from
     non-container entities only.
   - **Region expansion**: the container entities' remaining pages, plus (route
     questions only) every page sharing the entities' region, capped to the 12
     nearest by page distance to the own pages (`regionPageCap`). On a full
     book a region has 40-60 pages; uncapped they diluted the boost. The cap
     applies per book: a book with no own page for the entity (Vol 2 has no
     region maps) keeps its first 12 pages in page order, so Vol 1's anchors
     never crowd Vol 2 out ("Which bosses drop Remembrances in Liurnia?" needs
     Rennala's boss page, Vol 2 p. 210).
   - **Route span** (route questions only): the guide walks each region stop by
     stop in page order, so the pages strictly between the two endpoints' home
     pages (their `walkthrough`-type pages, else any) are added when the gap is
     at most 24 pages (`routeSpanMax`). They are returned as `anchors.spanPages`
     and are what makes "from Lenne's Rise to the Meteorite Staff" cite the
     stops on pp. 124-128.

Result: `anchors: {entities, pages, ownPages}`. The UI shows `entities` as
the "Understood as" strip.

## 2. Hybrid search (`search.ts`, `fuse.ts`)

1. **Embed the query** with `input_type: "query"` (Voyage `voyage-4`, 1024 dims).
2. **Vector search**: top 40 chunks by cosine similarity over `chunks.embedding` (HNSW).
3. **Lexical search**: top 40 by `ts_rank_cd(tsv, websearch_to_tsquery('english', q))`.
   `q` is the query's content words joined with `or`, because the plain
   question ANDs every word and "Where is the Giant Rat Ashes and how do I get
   it?" then matches nothing. `tsv` weights the heading path (A) above the
   chunk text (B).
4. **Reciprocal rank fusion**, k = 60: `score = sum 1 / (60 + rank)` over the
   lists a chunk appears in; `why` records which lists.
5. **Anchor boost**: chunks on anchor pages x1.5; chunks on the resolved
   entities' own pages x2 (not cumulative). `why` gains `anchor`.
6. **Rerank** (optional, `RERANK_ENABLED=true` or `--rerank`): the top 30 are
   sent to Voyage `rerank-2.5` as `heading_path + "\n\n" + text`; the returned
   relevance score replaces the fused score. Off by default: it costs about
   9k rerank tokens per query on this corpus and the fused baseline is
   inspectable.
7. Return the top 12 `{book, page, chunk_idx, text, heading_path, score, why, ranks}`.

## 3. Route questions (`index.ts`)

A query is a route question if it matches
`from | route | path | way | get to | go to | travel to | reach | head to`.
Bare "to" and "how do I get it" are not signals.

If it is a route question **and** at least two entities resolved, one of
them location-typed (`location`, `region`, `dungeon`, `site_of_grace`; the
other may be an item, as in "from Lenne's Rise to the Meteorite Staff"), the
full markdown of the anchor pages is added as `pages[]` with
`context_kind: "page"`. Priority: own pages in the route span's book ordered
by their best fused chunk score, then the route-span pages in page order, then
own pages from other books, then the remaining anchor pages by score (pages
nothing matched come last). Other-book own pages come after the span because
an item's stat entry in Vol 2 runs to 2,000+ tokens and would crowd out the
walkthrough stops. The 12k-token budget is
filled greedily (pages that do not fit are skipped, smaller later pages may
still be taken), and the result is ordered by page number.

## Worked example

Query: **How do I get from Castle Morne Rampart to Oridys's Rise?**
(six fixture pages indexed)

1. Route question: yes (`from`).
2. Candidates include `castle morne rampart`, `castle morne`, `oridyss rise`,
   `rise`, ... Exact matches: `castle morne rampart` (site_of_grace, p. 73) and
   `oridyss rise` (location, p. 73). `castle morne` also matches an entity, but
   its span lies inside the exact span `castle morne rampart`, so it is dropped.
3. Anchors: 2 entities, own pages {73}; one hop through `connects_to`
   ("Castle Morne Rampart" -> "Oridys's Rise", both already on p. 73); region
   expansion (route question) adds every page with region "Weeping Peninsula",
   which in the fixture is again only p. 73. `anchors.pages = [vol1:73]`.
4. Vector top 40 (36 chunks exist) and lexical top 40 (6 hits for
   `Castle or Morne or Rampart or Oridys or Rise`).
5. Fusion and boost, top 5:

```
 1. 0.0650  p.73 #1  vector+lexical+anchor v1 l2   Weeping Peninsula > Map labels
 2. 0.0650  p.73 #4  vector+lexical+anchor v2 l1   Weeping Peninsula > Figure 1
 3. 0.0635  p.73 #3  vector+lexical+anchor v3 l3   Weeping Peninsula > Essential Objectives
 4. 0.0556  p.73 #2  vector+lexical+anchor v22 l4  Weeping Peninsula > Location Totals
 5. 0.0308  p.159 #4 vector+lexical        v4 l6   Altus Plateau > 28 Highway Lookout Tower
```

   Chunk 1: (1/61 + 1/62) x 2 = 0.0650. Chunk 5 has no boost: 1/64 + 1/66 = 0.0308.
6. Two location entities and a route question, so `pages` holds the full
   markdown of p. 73 (766 tokens) with `context_kind: "page"`.

Timings on this machine: resolve ~50 ms, embed ~300 ms (network), lexical
~20 ms, vector ~4 ms, page fetch ~130 ms.

## Deviations from the spec, and knobs

- Lexical query is OR-joined content words rather than the raw question (see 2.3).
- Candidates for exact matching include lowercase n-grams; trigram matching is
  restricted as described in 1.3 to keep noise down.
- Region names are resolved from `pages.region` as well as from entities.
- One-hop anchor expansion follows `connects_to` in both directions.
- Route detection excludes bare "to".
- Region-typed entities are containers: map pages only as own pages, the rest
  capped as region expansion; index pages never anchor; route questions add
  the walkthrough span between the endpoints (see 1.7).
- Constants live in `RETRIEVE_DEFAULTS` (`types.ts`): topK 12, vectorK 40,
  lexicalK 40, rerankK 30, rrfK 60, trigramThreshold 0.6, trigramMaxPages 40,
  regionPageCap 12, routeSpanMax 24, pageTokenBudget 12000, anchorBoost 1.5,
  ownPageBoost 2. All are overridable per call.

## Full Vol 1 results (512 pages, 4,013 chunks, 13,527 entities; 2026-09-23)

Fourteen review queries against the full Vol 1 index, `npm run retrieve -- --k 5 "..."`, no rerank. For each: resolved entities with their match kind, anchor page count, the top three fused chunks (`why` = which retrievers found it), and route pages when the question is a route question.


### Where is the Meteorite Staff and how do I get it?

Anchors: 1 entities, 5 pages.

- `Meteorite Staff` [weapon] exact, pages 48,113,123,328,435

1. p. 113 #2 — Caelid > Equipment (vector+lexical+anchor, 0.0626)
2. p. 48 #1 — INTELLIGENCE > INTELLIGENCE (lexical+anchor, 0.0328)
3. p. 123 #0 — Caelid > 19 Street of Sages Ruins (lexical+anchor, 0.0317)

### How do I get from Lenne's Rise to the Meteorite Staff?

Anchors: 2 entities, 22 pages.

- `Meteorite Staff` [weapon] exact, pages 48,113,123,328,435
- `Lenne's Rise` [location] exact, pages 110,111,129,133

1. p. 129 #1 — Caelid > 34 Lenne's Rise — +15/+7 (vector+lexical+anchor, 0.0650)
2. p. 123 #0 — Caelid > 19 Street of Sages Ruins (vector+lexical+anchor, 0.0499)
3. p. 48 #1 — INTELLIGENCE > INTELLIGENCE (lexical+anchor, 0.0328)

Route pages (15, 11737 tokens): p.48, p.110, p.111, p.113, p.122, p.123, p.124, p.125, p.126, p.127, p.128, p.129, p.133, p.328, p.435

### What are the requirements for Moonveil?

Anchors: 1 entities, 2 pages.

- `Moonveil` [weapon] exact, pages 48,116

1. p. 48 #1 — INTELLIGENCE > INTELLIGENCE (lexical+anchor, 0.0313)
2. p. 369 #2 — Limgrave > Boc the Seamster > ◆ Important Items (vector+lexical, 0.0235)
3. p. 420 #2 — Goldmask > Important Items (vector+lexical, 0.0228)

### Which bosses drop Remembrances in Liurnia?

Anchors: 2 entities, 21 pages.

- `Remembrances` [item] exact, pages 81,362,409
- `Liurnia` [region] exact, pages 42,50,90,99,100,101,138,140…

1. p. 99 #3 — Liurnia of the Lakes > 28 Village of the Albinaurics (vector+lexical+anchor, 0.0411)
2. p. 101 #2 — Liurnia of the Lakes > 34 Road's End Catacombs (vector+lexical+anchor, 0.0406)
3. p. 91 #0 — Liurnia of the Lakes > (8) Cliffbottom Catacombs (vector+lexical, 0.0310)

### Where is the Giant Rat Ashes and how do I get it?

Anchors: 1 entities, 2 pages.

- `Giant Rat Ashes` [item,consumable] exact, pages 145,159

1. p. 159 #0 — Altus Plateau > (24) West Windmill Pasture (vector+lexical+anchor, 0.0581)
2. p. 62 #3 — Limgrave > 19 Dragon-Burnt Ruins (vector+lexical, 0.0280)
3. p. 185 #0 — Mountaintops of the Giants > 4 Giants' Mountaintop Catacombs (vector+lexical, 0.0276)

### What does the Godskin Apostle drop in Dominula?

Anchors: 2 entities, 10 pages.

- `Godskin Apostle` [boss,enemy] exact, pages 43,137,145,159,190,191,308,359…
- `Dominula` [location] exact, pages 43

1. p. 159 #3 — Altus Plateau > (27) Dominula, Windmill Village (vector+lexical+anchor, 0.0656)
2. p. 492 #3 — Event 5 (vector+lexical+anchor, 0.0593)
3. p. 137 #0 — Caelid > 46 Divine Tower of Caelid (lexical+anchor, 0.0323)

### Which enemies are in Miquella's Haligtree?

Anchors: 1 entities, 18 pages.

- `Miquella's Haligtree` [dungeon,location,region] exact, pages 38,43,44,197,204,209,288,292…

1. p. 294 #1 — Miquella's Haligtree > Haligtree Town (vector+lexical+anchor, 0.0603)
2. p. 298 #0 — Miquella's Haligtree > Elphael Inner Wall (vector+lexical+anchor, 0.0598)
3. p. 288 #0 — Miquella's Haligtree > MIQUELLA'S HALIGTREE (vector+lexical+anchor, 0.0534)

### How much HP do bosses have with 2 allies in co-op?

Anchors: 0 entities, 0 pages.

No entity resolved.

1. p. 360 #19 — Sorceress Sellen — HP 3790 (vector+lexical, 0.0293)
2. p. 317 #7 — Leyndell, Ashen Capital > 7 (vector+lexical, 0.0282)
3. p. 276 #1 — Leyndell, Royal Capital > Erdtree Sanctuary (vector+lexical, 0.0260)

### How do I get from Castle Morne Rampart to Oridys's Rise?

Anchors: 2 entities, 12 pages.

- `Castle Morne Rampart` [site_of_grace] exact, pages 73,74,76
- `Oridys's Rise` [location] exact, pages 73,74

1. p. 74 #3 — Weeping Peninsula > 3 Oridys's Rise (vector+lexical+anchor, 0.0640)
2. p. 74 #4 — Weeping Peninsula > Figure 1 (vector+lexical+anchor, 0.0602)
3. p. 82 #6 — Weeping Peninsula > Figure 1 (vector+lexical+anchor, 0.0424)

Route pages (12, 10573 tokens): p.72, p.73, p.74, p.75, p.76, p.77, p.79, p.81, p.82, p.83, p.482, p.510

### How do I complete Millicent's quest?

Anchors: 1 entities, 31 pages.

- `Millicent` [npc] trigram 0.75, pages 43,44,86,106,111,112,113,120…

1. p. 489 #4 — Chapter 4 ◆ Quest Guide > Event 2 *OPTIONAL* > Event 2 Dialog (vector+lexical+anchor, 0.0636)
2. p. 490 #4 — Event 5 (vector+lexical+anchor, 0.0589)
3. p. 489 #3 — Chapter 4 ◆ Quest Guide > Event 2 *OPTIONAL* (vector+lexical+anchor, 0.0585)

### Where can I find Ancient Dragon Lansseax?

Anchors: 1 entities, 38 pages.

- `Ancient Dragon Lansseax` [boss] exact, pages 142,150,159

1. p. 159 #6 — Altus Plateau > (30) Overworld Boss: Ancient Dragon Lansseax (Pt. 2) (vector+lexical+anchor, 0.0645)
2. p. 150 #1 — 11 Overworld Boss Ancient Dragon Lansseax (Pt. 1) +12/+5 (vector+lexical+anchor, 0.0645)
3. p. 120 #1 — Caelid > 14 Cathedral of Dragon Communion (vector+lexical, 0.0303)

### What is the Golden Rune used for?

Anchors: 1 entities, 2 pages.

- `Golden Rune` [consumable] exact, pages 115,136

1. p. 197 #3 — Consecrated Snowfield > CONSECRATED SNOWFIELD > Items (vector+lexical, 0.0301)
2. p. 11 #2 — Chapter 1 • Systems Guide > GAME PROGRESSION > Great Runes (vector+lexical, 0.0291)
3. p. 183 #3 — Mountaintops of the Giants > MOUNTAINTOPS OF THE GIANTS > Map Legend > Items (vector+lexical, 0.0272)

### Which Sites of Grace are in the Weeping Peninsula?

Anchors: 2 entities, 35 pages.

- `Weeping Peninsula` [region] exact, pages 37,38,39,67,72,73,74,75…
- `Site of Grace` [location,site_of_grace] trigram 0.81, pages 14,27,341,345

1. p. 73 #0 — Weeping Peninsula (vector+lexical+anchor, 0.0597)
2. p. 72 #0 — Weeping Peninsula > WEEPING PENINSULA (vector+lexical+anchor, 0.0593)
3. p. 73 #3 — Weeping Peninsula > Figure 1 (vector+lexical+anchor, 0.0527)

### How do I reach Volcano Manor from the Altus Plateau?

Anchors: 2 entities, 30 pages.

- `Altus Plateau` [region,site_of_grace] exact, pages 37,38,39,40,41,42,43,45…
- `Volcano Manor` [site_of_grace,dungeon,location,region] exact, pages 30,31,38,41,42,156,162,163…

1. p. 248 #0 — Mt. Gelmir > VOLCANO MANOR (vector+lexical+anchor, 0.0466)
2. p. 253 #0 — Volcano Manor (vector+lexical+anchor, 0.0371)
3. p. 253 #1 — Volcano Manor (vector+lexical+anchor, 0.0339)

Route pages (20, 11883 tokens): p.37, p.84, p.85, p.142, p.143, p.145, p.147, p.162, p.163, p.209, p.248, p.251, p.252, p.253, p.254, p.256, p.258, p.260, p.262, p.264

Observations:

- Anchors land on the right pages for every entity-bearing question; index
  pages no longer appear (they ranked second for "Meteorite Staff" before the
  exclusion).
- Container handling cut the anchor set for "Volcano Manor from the Altus
  Plateau" from 204 pages to about 30, and its route pages from the book's
  front matter (pp. 3-43, filled by page order) to the Mt. Gelmir / Volcano
  Manor chapter.
- The route span makes "Lenne's Rise to the Meteorite Staff" deliver pp.
  123-129 in full; the answer stage then lists the 16 numbered stops with a
  citation each (`ANSWER_MAX_TOKENS` 16000; 4096 left no room after thinking).
- Known miss: "How much HP do bosses have with 2 allies in co-op?" resolves no
  entity, and p. 33 (the co-op tables) is not in the top 40 of either
  retriever; boss stat blocks with many "HP" mentions outrank it lexically.
  Rerank did not recover it either. A heading-aware lexical query or a table
  summary chunk would be the next lever.
- "What are the requirements for Moonveil?" finds Moonveil only in the
  Intelligence stat list (p. 48) and Gael Tunnel (p. 116): Vol 1 has no weapon
  requirement tables; that question belongs to Vol 2.
