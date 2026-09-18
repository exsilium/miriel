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
   whole query.
4. **Span selection.** Among candidates that matched something, an exact span
   beats a trigram span that contains it ("godskin apostle" over "godskin
   apostle drop"); otherwise the longest span wins ("Lenne's Rise" over
   "Rise").
5. **Prior entities** (`opts.priorEntities`, `name_norm` values from the
   previous turn) are looked up exactly and added with `match: "prior"`, so
   "how do I get there?" resolves "there".
6. **Grouping.** Rows are grouped by `name_norm` into `ResolvedEntity`
   `{name, types[], pages[], match, similarity, matchedText, isLocation}`.
7. **Anchor pages** = own pages (where the entities appear) + one hop through
   `entity_links` in either direction + (route questions only) every page
   sharing the entities' region.

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

If it is a route question **and** at least two resolved entities are
location-typed (`location`, `region`, `dungeon`, `site_of_grace`), the full
markdown of the anchor pages is added as `pages[]` with
`context_kind: "page"`: own pages first, then the remaining anchor pages,
filling a 12k-token budget (pages that do not fit are skipped, smaller later
pages may still be taken), finally ordered by page number.

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
- Constants live in `RETRIEVE_DEFAULTS` (`types.ts`): topK 12, vectorK 40,
  lexicalK 40, rerankK 30, rrfK 60, trigramThreshold 0.6, pageTokenBudget
  12000, anchorBoost 1.5, ownPageBoost 2. All are overridable per call.
