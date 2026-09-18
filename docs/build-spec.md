# Miriel — Build Specification v1

Read this file completely before writing any code. It is the spec for the retrieval, generation, and UI layers that sit on top of the per-page extraction defined in `prompts/page-extraction-prompt.md`. Work through the phases in order and **stop at the end of each phase for review**.

## 1. Goal

A local web app where I chat with my digitized Elden Ring strategy guides. Every factual claim in an answer carries a page citation; clicking a citation opens that page of the original PDF in the browser, scrolled and highlighted. Typical questions:

- "Where is the Meteorite Staff and how do I get it?"
- "How do I get from Lenne's Rise to the Meteorite Staff?"
- "What are the requirements for Moonveil?"
- "Which bosses drop Remembrances in Liurnia?"

## 2. Hard constraints

- **Node / TypeScript** for every service. No Python in the runtime stack (the extraction runner may stay Python).
- **Docker Compose** for local run and hosting: `docker compose up` must bring up the full stack from a clean checkout plus the source files and `out/` directory.
- **Postgres 16 + pgvector + pg_trgm** as the only datastore. No separate vector DB, no Redis, no message queue.
- Source PDF and page images are mounted **read-only** into the API container. They are never copied into images or committed.
- Secrets (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`) come from `.env`; `.env.example` is committed, `.env` is not.
- Keep the dependency footprint small. Prefer Fastify, Drizzle (or plain `pg`), Vite + React, `react-pdf` (pdf.js). Do not add a framework without asking.
- Every model call (embeddings, rerank, generation) goes through a small provider interface so I can swap vendors later.

## 3. Inputs already present

```
miriel/
├── prompts/page-extraction-prompt.md
├── Elden Ring Vol 1 - The Lands Between.pdf         # OCR PDF
├── Elden Ring Vol 1 - The Lands Between/            # one image per page
└── out/vol1/p0001.json ... pNNNN.json               # extraction output, one per printed page
```

Each `out/**/*.json` follows the schema in the extraction prompt: `book`, `page`, `chapter`, `region`, `page_type`, `markdown`, `figures[]`, `entities[]`, `quality{}`.

A **page offset** between printed page number and PDF page index was established during extraction (see `CLAUDE.md` or ask). It must be stored as book-level config, not hard-coded.

## 4. Target repository layout

```
miriel/
├── docker-compose.yml
├── .env.example
├── packages/
│   ├── shared/          # types shared by indexer, api, web (zod schemas)
│   ├── indexer/         # CLI: reads out/, writes to Postgres
│   ├── api/             # Fastify: retrieval, generation, PDF/page serving
│   └── web/             # Vite + React SPA
├── db/
│   └── migrations/      # plain SQL, applied by a tiny migrate script in indexer
└── docs/
    └── retrieval.md     # written by you in Phase 3: how a query flows through the system
```

Use npm workspaces (or pnpm if already installed). One root `package.json`, one lockfile.

## 5. Data model

Plain SQL migrations. Suggested tables — adjust names if you have a reason, but keep the shape.

```sql
books        (id text pk, title text, pdf_path text, image_dir text,
              printed_to_pdf_offset int, page_count int)

pages        (book_id fk, page int, chapter text, region text, page_type text,
              markdown text, quality jsonb, primary key (book_id, page))

chunks       (id bigserial pk, book_id fk, page int, chunk_idx int,
              text text, embedding vector(1024), tsv tsvector,
              heading_path text,          -- "Liurnia > Lenne's Rise > Items"
              unique (book_id, page, chunk_idx))
  index: hnsw on embedding (vector_cosine_ops); gin on tsv

figures      (id bigserial pk, book_id fk, page int, kind text,
              description text, labels text[], legend text)

entities     (id bigserial pk, book_id fk, page int, type text, name text,
              name_norm text,             -- lowercased, punctuation-stripped
              location text, how_to_obtain text, connects_to text[])
  index: gin trgm on name_norm; btree on (name_norm); btree on (type)

entity_links (from_entity bigint fk, to_name_norm text)   -- expanded connects_to
```

Embedding dimension follows the chosen model; make it a config constant, not a literal in five places.

## 6. Phase 1 — Indexer (`packages/indexer`)

CLI: `indexer ingest --book vol1 --out ./out/vol1` and `indexer reset --book vol1`.

Steps per page file:

1. Validate against the zod schema from `packages/shared`. Log and skip invalid files; exit non-zero at the end if any were skipped.
2. Upsert `pages`, `figures`, `entities`. Derive `name_norm` consistently (one function, in `shared`).
3. **Chunk the markdown, never crossing a page boundary.** Split on headings first, then on paragraph boundaries to a target of ~500 tokens, hard max ~800. Prepend the heading path to each chunk's text before embedding (`"Liurnia > Lenne's Rise\n\n<chunk>"`) so the embedding carries context. Store the raw chunk text without the prefix for display.
4. Tables in the markdown are chunked as whole tables where possible; if a table exceeds the max, split by rows and repeat the header row in each part.
5. Figure descriptions and legends are also chunked (as their own chunks, `heading_path = "Figure"`), because map legends answer a lot of "where is X" questions.
6. Embed with the provider interface (default: Voyage, whichever current general-purpose model the Voyage docs recommend; check the docs, do not assume a model name). Batch requests; respect rate limits with simple backoff.
7. Compute `tsv` with `to_tsvector('english', text)` in SQL.
8. Idempotent: re-running on the same page replaces its rows.

Print a summary at the end: pages, chunks, entities, figures, embedding tokens used.

**Stop for review.** I will check chunk boundaries on the six fixture pages before you continue.

## 7. Phase 2 — Retrieval (`packages/api`, no HTTP yet)

Implement `retrieve(query, opts): RetrievalResult` as a pure module with a test harness (`npm run retrieve -- "how do I get the Meteorite Staff from Lenne's Rise"`) that prints the ranked chunks with scores.

### 7.1 Entity resolution (runs first)

1. Extract candidate names from the query: n-grams of 1–4 capitalised words, plus the whole query.
2. Match against `entities.name_norm` — exact first, then trigram similarity ≥ 0.6. Return distinct entities with their pages.
3. For each resolved entity, collect **anchor pages**: the entity's own pages, plus pages of entities in its `connects_to` (one hop), plus pages sharing its `region` if the query looks like a route question (contains "from", "to", "get to", "path", "route", "way").
4. Return `anchors: {entities[], pages[]}`. This is also returned to the UI so the user sees what the system thinks the question is about.

### 7.2 Hybrid search

1. Embed the query (same provider, `input_type: query` if the provider distinguishes).
2. Vector search: top 40 by cosine over `chunks`.
3. Lexical search: top 40 by `ts_rank_cd(tsv, websearch_to_tsquery('english', query))`.
4. Fuse with **reciprocal rank fusion** (k = 60).
5. **Anchor boost:** chunks whose page is in `anchors.pages` get their fused score multiplied by 1.5. Chunks on the resolved entity's own page get ×2.
6. Optional rerank of the top 30 with the provider's rerank endpoint if `RERANK_ENABLED=true`; default off so the baseline is cheap and inspectable.
7. Return top 12 chunks, each with `{book, page, chunk_idx, text, heading_path, score, why: ['vector','lexical','anchor']}`.

### 7.3 Route questions

If ≥ 2 location-type entities resolved and the query is a route question, additionally pull the **full markdown** of the anchor pages (not just chunks) up to a budget of ~12k tokens, ordered by page number. Route answers need continuous text; chunks fragment them. Mark these in the result as `context_kind: 'page'`.

Write `docs/retrieval.md` describing this flow with one worked example.

**Stop for review.** I will run ten test queries against the harness.

## 8. Phase 3 — Generation with page citations

`answer(query, retrieval): AsyncIterable<AnswerEvent>` streaming text and citation events.

1. Build the request with the Anthropic SDK using **document content blocks with citations enabled** — check the current Anthropic docs for the exact shape of the citations feature before implementing; do not code it from memory. Each retrieved chunk or page becomes one document with a `title` of the form `Vol 1 — p. 214 — Liurnia > Lenne's Rise` and `context` carrying `{book, page, chunk_idx}` as JSON so citations can be mapped back.
2. System prompt (keep it in `packages/api/prompts/answer.md`, not inline in code):
   - Answer only from the provided documents. If the documents do not contain the answer, say so and name the closest pages.
   - Preserve in-game names exactly as they appear in the documents.
   - For route questions, give the route as an ordered list of waypoints, each with its citation.
   - Be concise; the user has the book open next to the answer.
3. Map each returned citation to `{book, page, quote}` using the document's `context`. Emit `citation` events alongside `text` deltas.
4. **Fallback path** (behind `CITATIONS_MODE=inline`): if the citations API is unavailable or misbehaves, instruct the model to emit `[Vol 1, p. 214]` markers and parse them with a regex into the same event shape. Both modes must produce identical output to the UI.
5. Log every call: model, input/output tokens, latency, number of citations, to stdout as one JSON line.

Model: use the current Sonnet-class model for answers by default, configurable via `ANSWER_MODEL`. Enable prompt caching on the system prompt.

**Stop for review.**

## 9. Phase 4 — HTTP API (`packages/api`)

Fastify, TypeScript, port 8080 inside the container.

```
POST /api/chat                 body {messages[], bookIds?[]} → SSE stream of
                               {type:'anchors'|'text'|'citation'|'done'|'error', ...}
GET  /api/books                → [{id, title, pageCount, printedToPdfOffset}]
GET  /api/books/:id/pdf        → the PDF, with Range support (pdf.js needs it)
GET  /api/books/:id/pages/:n/image  → page image (printed page n), cache headers
GET  /api/books/:id/pages/:n   → {markdown, figures, entities, quality} for debugging
GET  /api/entities?q=          → typeahead over entities (trgm), top 10
GET  /api/health
```

- Validate all inputs with zod. Return problem-details JSON on error.
- Multi-turn: the last 6 messages are sent to the model; retrieval runs on the latest user message **plus** the resolved entities from the previous turn (so "how do I get there?" resolves "there").
- CORS only for the web origin in dev; in compose the web is served by the same origin via nginx, so no CORS needed.

## 10. Phase 5 — Web UI (`packages/web`)

Vite + React + TypeScript. Two-pane layout, dark theme by default (it is a game guide), responsive down to a tablet width.

**Left pane — chat**

- Message list with streaming text.
- Citations render as small inline pills `Vol 1 · p. 214`. Hover shows the quoted span; click sends the viewer to that page and highlights the span.
- Above the answer, a collapsible "Understood as" strip showing the resolved entities (from the `anchors` event) as chips; clicking a chip jumps the viewer to the entity's page.
- Below the answer, a "Pages consulted" strip of page thumbnails (from the image endpoint) in page order.
- Input box with entity typeahead (`/api/entities`).

**Right pane — PDF viewer**

- `react-pdf` (pdf.js) rendering the PDF from `/api/books/:id/pdf`. Lazy-load pages, keep the current ±2 rendered.
- Convert printed page → PDF page index using `printedToPdfOffset` from `/api/books`. Show the **printed** page number in the toolbar.
- Toolbar: prev/next, page input (printed numbers), zoom, fit-width, "open page image" toggle that swaps the pdf.js canvas for the original page image (useful when the PDF render is worse than the photo).
- **Highlighting:** when a citation is clicked, find the quoted text in that page's pdf.js text layer and highlight the matching spans. Use a fuzzy match (normalise whitespace, case, and punctuation) because OCR text and cited text will differ slightly. If no match is found, scroll to the page and flash the page border instead of failing silently.
- Deep-linkable: `?book=vol1&page=214` opens at that page.

Keep components small; no state library beyond React context unless it becomes painful. Use a minimal CSS approach (CSS modules or plain CSS with variables); do not pull in a component framework.

## 11. Phase 6 — Docker Compose

```yaml
services:
  db:        pgvector/pgvector:pg16, healthcheck, volume for data,
             init SQL enabling vector + pg_trgm
  migrate:   one-shot, runs db/migrations, depends_on db healthy
  indexer:   profile "index" — one-shot, mounts ./out read-only,
             `indexer ingest --book vol1`; not started by default
  api:       node:22-alpine multi-stage build; mounts the PDF and image
             dir read-only at /data; depends_on migrate completed
  web:       nginx:alpine serving the Vite build, proxying /api → api:8080
             (including SSE — disable buffering for /api/chat)
```

- `docker compose up` → app at `http://localhost:3000`.
- `docker compose --profile index run indexer` → (re)index.
- `docker compose down -v` → clean slate.
- Multi-stage builds; final images contain no dev dependencies or source maps.
- `.dockerignore` excludes the PDF, images, `out/`, `node_modules`.
- A `Makefile` or root `package.json` scripts wrapping the three commands above plus `dev` (run api + web with hot reload against the compose db).

## 12. Acceptance checks (run before declaring done)

1. Clean clone + `.env` + source files → `docker compose up` → UI loads, `/api/health` is green.
2. `docker compose --profile index run indexer` completes on the six fixture pages; row counts match what the summary printed.
3. "Where is the Meteorite Staff?" → answer with ≥ 1 citation; clicking it opens the correct printed page and highlights text.
4. "How do I get from Lenne's Rise to the Meteorite Staff?" → the anchors strip shows both locations; the answer is an ordered list with a citation per waypoint.
5. A question about something not in the fixture pages → the model says the pages do not cover it, and names the nearest pages, rather than inventing an answer.
6. Kill the API mid-stream → UI shows an error state, not a hung spinner.
7. `CITATIONS_MODE=inline` produces the same UI behaviour as the default mode.

## 13. Non-goals for v1

- Authentication, multi-user, hosting outside a LAN.
- Editing or annotating pages.
- Ingesting anything other than the extraction JSON (no direct PDF ingestion).
- Vol 2 — but nothing may assume a single book.

## 14. Working rules

- Stop at the end of each phase and wait for my go-ahead. Do not start the next phase early "to save time."
- If you hit a decision this spec does not cover, list the options with one line each and ask, unless the choice is trivially reversible.
- Do not rewrite `prompts/page-extraction-prompt.md` or the extraction output.
- Commit at the end of each phase with a message `phase N: <summary>`; one PR per phase if I've set up the issue workflow.
- Prefer boring, well-known libraries over clever ones. Fewer dependencies beats fewer lines.