# @miriel/indexer

Reads `out/<book>/pNNNN.json` (one extracted page per file, schema in
`prompts/page-extraction-prompt.md`) and writes pages, chunks, figures,
entities and entity links to Postgres.

## Commands

Run from the repo root after `npm install && npm run build`
(or `npx indexer …` once installed; Node 22+).

```
node packages/indexer/dist/cli.js migrate
node packages/indexer/dist/cli.js ingest --book vol1 [--out ./out/vol1] [--pages 33,73] [--dry-run] [--provider fake]
node packages/indexer/dist/cli.js reset  --book vol1
node packages/indexer/dist/cli.js dump   --book vol1 --page 159      # chunks as stored
node packages/indexer/dist/cli.js dump   --file out/vol1/p0159.json  # chunker output, no database
```

Environment: `DATABASE_URL`, `VOYAGE_API_KEY`, optional `EMBEDDINGS_PROVIDER`
(`voyage` | `fake`), `EMBEDDING_MODEL` (default `voyage-4`), `DATA_DIR`.
Read from the nearest `.env` walking up from the working directory.

Book configuration (title, source paths, printed-page to PDF offset) lives in
`config/books.json`; `ingest` upserts it into the `books` table.

## What ingest does per page

1. Validate with the shared zod `PageSchema`; check the `page` field matches the
   file name and the `book` field matches the configured `sourceBook`. Invalid
   files are logged and skipped, and the process exits 1 at the end.
2. Chunk the markdown (`src/chunker.ts`):
   - split on headings; the heading stack, rooted at the page's `region`
     (else `chapter`), becomes `heading_path`
   - inside a section, pack blocks to about 500 tokens, hard max 800; a section
     that fits under 800 as a whole is kept whole
   - over-size tables split by rows with the header rows repeated; sidebars by
     lines with the bold title repeated; lists by items; prose by sentences
   - repeated identical headings (one table printed in several columns) are one
     section
   - each figure becomes its own chunk (`description`, `Labels: …`,
     `Legend: …`) under `<root> > Figure n`
3. Embed `heading_path + "\n\n" + text` in batches through the shared
   `EmbeddingProvider`; the stored `text` has no prefix.
4. In one transaction: delete the page's old rows (cascades), insert `pages`,
   `figures`, `entities` (+ `entity_links` from `connects_to`) and `chunks`.
   `tsv` is a generated column (heading path weighted A, text weighted B).

Token counts use cl100k_base as an approximation of Voyage's tokenizer and are
stored in `chunks.token_count` for inspection.

## Tests

```
npm test            # builds, then runs node:test suites in every workspace
```
