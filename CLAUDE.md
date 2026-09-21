# Miriel

RAG chat layer over digitized Elden Ring strategy guides, with page citations.

- Source books: OCR PDF + one image per page, at repo root (see prompts/page-extraction-prompt.md for paths)
- Per-page extraction prompt: prompts/page-extraction-prompt.md — treat it as the spec for the model call, do not rewrite it without asking
- Extraction output: out/vol1/p{PAGE:04d}.json, one file per page, schema defined in the prompt
- Python 3.12, uv for deps, Anthropic SDK. Never commit the PDF, images, or out/.
- Check the source PDF page index vs printed page number offset before anything else.
## Node stack (Phase 1+)

- npm workspaces: packages/shared (zod schema, normalizeName, embedding provider), packages/indexer (CLI). Build with `npm run build` (tsc -b), tests with `npm test` (node:test).
- Book config incl. printed-page to PDF offset: config/books.json (vol1 offset = 1). Migrations: db/migrations/*.sql, applied by `indexer migrate`.
- Dev database: `docker compose up -d db`, then `node packages/indexer/dist/cli.js migrate|ingest|reset|dump`.
- Retrieval harness: `npm run retrieve -- "<query>"` (packages/api, see docs/retrieval.md). Answer harness: `npm run answer -- [--inline] "<question>"`; system prompt in packages/api/prompts/answer.md (+ answer-citations.md / answer-inline.md per mode).
- HTTP API: `npm run api` (Fastify on PORT 8080; routes in packages/api/src/routes, SSE chat at POST /api/chat). Dev with hot reload: `npm run dev:api` with CORS_ORIGIN set to the Vite origin.
- Web UI: packages/web (Vite + React + react-pdf). `npm run dev:web` (port 5173, proxies /api to 8080), `npm run build:web` (typecheck + bundle to packages/web/dist). Fuzzy quote highlighting in src/viewer/highlight.ts.
- Docker: `npm run up` (compose up --build, app at http://localhost:3000), `npm run index` (one-shot indexer, profile "index"), `npm run down` (drops the db volume), `npm run dev` (api + web hot reload against the compose db). Dockerfile targets: runtime (node) and web (nginx); docker/nginx.conf proxies /api with SSE buffering off.
- Never commit node_modules, dist, .env. Chunk dumps contain book text; keep them out of the repo.
