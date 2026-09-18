/**
 * retrieve(query, opts): entity resolution -> hybrid search -> RRF -> anchor
 * boost -> optional rerank -> top K, plus full-page context for route
 * questions. See docs/retrieval.md for the flow with a worked example.
 */
import { countTokens, envFlag, type EmbeddingProvider, type RerankProvider } from "@miriel/shared";
import type { Pool } from "@miriel/shared/db";
import { isRouteQuestion } from "./candidates.js";
import { anchorBoost, pageKey, rrfFuse, selectWithinBudget, type RankedList } from "./fuse.js";
import { resolveEntities } from "./resolve.js";
import { chunkKey, fetchPages, lexicalSearch, vectorSearch, type ChunkHit } from "./search.js";
import {
  RETRIEVE_DEFAULTS,
  type PageRef,
  type RetrievalResult,
  type RetrieveOptions,
  type RetrievedChunk,
  type RetrievedPage,
} from "./types.js";

export * from "./types.js";
export { extractCandidates, isRouteQuestion, ROUTE_RE } from "./candidates.js";
export { rrfFuse, anchorBoost, selectWithinBudget } from "./fuse.js";

export interface RetrieverDeps {
  pool: Pool;
  embedder: EmbeddingProvider;
  /** Required only when rerank is requested. */
  reranker?: RerankProvider | undefined;
}

export type Retriever = (query: string, opts?: RetrieveOptions) => Promise<RetrievalResult>;

export function createRetriever(deps: RetrieverDeps): Retriever {
  return (query, opts = {}) => retrieve(deps, query, opts);
}

export async function retrieve(deps: RetrieverDeps, query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
  const d = RETRIEVE_DEFAULTS;
  const topK = opts.topK ?? d.topK;
  const bookIds = opts.bookIds && opts.bookIds.length ? opts.bookIds : null;
  const useRerank = opts.rerank ?? envFlag("RERANK_ENABLED", false);
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };

  const q = query.trim();
  const routeQuestion = isRouteQuestion(q);

  // 7.1 entity resolution runs first; 7.2 first-stage searches are independent of it.
  const [anchors, embedded, lexical] = await Promise.all([
    timed("resolve", () =>
      resolveEntities(deps.pool, q, {
        bookIds: opts.bookIds,
        priorEntities: opts.priorEntities,
        trigramThreshold: opts.trigramThreshold ?? d.trigramThreshold,
        routeQuestion,
      }),
    ),
    timed("embed", () => deps.embedder.embed([q], "query")),
    timed("lexical", () => lexicalSearch(deps.pool, q, opts.lexicalK ?? d.lexicalK, bookIds)),
  ]);
  const vector = await timed("vector", () => vectorSearch(deps.pool, embedded.embeddings[0]!, opts.vectorK ?? d.vectorK, bookIds));

  // 7.2.4-5 fuse and boost
  const lists: RankedList<ChunkHit>[] = [
    { why: "vector", items: vector.map((h) => ({ key: chunkKey(h), item: h })) },
    { why: "lexical", items: lexical.map((h) => ({ key: chunkKey(h), item: h })) },
  ];
  let fused = anchorBoost(rrfFuse(lists, opts.rrfK ?? d.rrfK), anchors.pages, anchors.ownPages, {
    anchor: d.anchorBoost,
    own: d.ownPageBoost,
  });

  // 7.2.6 optional rerank of the top N
  let rerankTokens = 0;
  let reranked = false;
  if (useRerank && fused.length) {
    if (!deps.reranker) throw new Error("rerank requested but no rerank provider configured");
    const head = fused.slice(0, opts.rerankK ?? d.rerankK);
    const tail = fused.slice(head.length);
    const docs = head.map((f) => f.item.heading_path + "\n\n" + f.item.text);
    const res = await timed("rerank", () => deps.reranker!.rerank(q, docs));
    rerankTokens = res.tokens;
    reranked = true;
    const rerankedHead = res.hits.map((hit, i) => {
      const f = head[hit.index]!;
      return { ...f, score: hit.score, why: [...f.why, "rerank" as const], ranks: { ...f.ranks, rerank: i + 1 } };
    });
    // anything the reranker did not return (top_k unset returns all) keeps its place after the reranked head
    const returned = new Set(res.hits.map((h) => h.index));
    fused = [...rerankedHead, ...head.filter((_, i) => !returned.has(i)), ...tail];
  }

  const chunks: RetrievedChunk[] = fused.slice(0, topK).map((f) => ({
    book: f.item.book,
    page: f.item.page,
    chunk_idx: f.item.chunk_idx,
    text: f.item.text,
    heading_path: f.item.heading_path,
    score: f.score,
    why: f.why,
    ranks: f.ranks,
    context_kind: "chunk",
  }));

  // 7.3 route questions: full markdown of anchor pages within a token budget
  let pages: RetrievedPage[] = [];
  const locationEntities = anchors.entities.filter((e) => e.isLocation);
  if (routeQuestion && locationEntities.length >= 2) {
    pages = await timed("pages", () => routePages(deps.pool, anchors.ownPages, anchors.pages, opts.pageTokenBudget ?? d.pageTokenBudget));
  }

  return {
    query: q,
    routeQuestion,
    anchors,
    chunks,
    pages,
    stats: {
      embeddingTokens: embedded.tokens,
      rerankTokens,
      reranked,
      vectorHits: vector.length,
      lexicalHits: lexical.length,
      timingsMs: timings,
    },
  };
}

/** Own pages first, then the remaining anchor pages; fill the budget, then order by page. */
async function routePages(pool: Pool, ownPages: PageRef[], anchorPages: PageRef[], budget: number): Promise<RetrievedPage[]> {
  const own = new Set(ownPages.map(pageKey));
  const prioritised = [...ownPages, ...anchorPages.filter((p) => !own.has(pageKey(p)))];
  const rows = await fetchPages(pool, prioritised);
  const byKey = new Map(rows.map((r) => [r.book_id + ":" + r.page, r]));
  const withTokens = prioritised
    .map((p) => byKey.get(pageKey(p)))
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => ({ row: r, tokens: countTokens(r.markdown) }));
  return selectWithinBudget(withTokens, budget)
    .map(({ row, tokens }) => ({
      context_kind: "page" as const,
      book: row.book_id,
      page: row.page,
      chapter: row.chapter,
      region: row.region,
      markdown: row.markdown,
      tokens,
    }))
    .sort((a, b) => a.book.localeCompare(b.book) || a.page - b.page);
}
