# Miriel

Chat with digitized Elden Ring strategy guides. Every claim in an answer carries a page citation; clicking it opens that page of the original PDF next to the chat, with the cited text highlighted.

## Run it (Docker)

1. Put the source files under `./data/`: for each book in `config/books.json`, the OCR PDF and the page-image directory it names. Extraction output goes to `out/<book>/` (see `prompts/page-extraction-prompt.md` and `scripts/extract.py`). Verify a new book's page offset with `uv run python scripts/check_offset.py --book <id>`.
2. `cp .env.example .env` and fill in `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` (Voyage is a separate account: https://dashboard.voyageai.com).
3. `docker compose up --build -d` then open http://localhost:3000.
4. `docker compose --profile index run --rm indexer` to (re)index every configured book from `out/<book>/` (`… indexer ingest --book vol2` for one).
5. `docker compose down -v` for a clean slate.

## Develop

```
npm install
docker compose up -d db
npm run migrate
npm run indexer -- ingest --all         # or: ingest --book vol1
npm run dev                 # api (8080, hot reload) + web (5173, proxies /api)
npm test
```

Harnesses: `npm run retrieve -- "<query>"`, `npm run answer -- [--inline] "<question>"`.
See `CLAUDE.md` for the layout, `docs/build-spec.md` for the design, `docs/retrieval.md` for how a query flows.
