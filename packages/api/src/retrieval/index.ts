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
import { chunkKey, fetchPages, lexicalSearch, pageChunks, vectorSearch, type ChunkHit } from "./search.js";
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
export { resolveEntities, nearestPages, dropWidespreadTrigram, routeSpan } from "./resolve.js";

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
        trigramMaxPages: opts.trigramMaxPages ?? d.trigramMaxPages,
        regionPageCap: opts.regionPageCap ?? d.regionPageCap,
        routeSpanMax: opts.routeSpanMax ?? d.routeSpanMax,
        routeQuestion,
      }),
    ),
    timed("embed", () => deps.embedder.embed([q], "query")),
    timed("lexical", () => lexicalSearch(deps.pool, q, opts.lexicalK ?? d.lexicalK, bookIds)),
  ]);
  const vector = await timed("vector", () => vectorSearch(deps.pool, embedded.embeddings[0]!, opts.vectorK ?? d.vectorK, bookIds));
  const focusPages = (opts.focusPages ?? []).filter((p) => !bookIds || bookIds.includes(p.book));
  const focus = focusPages.length ? await timed("focus", () => pageChunks(deps.pool, focusPages)) : [];

  // 7.2.4-5 fuse and boost
  const lists: RankedList<ChunkHit>[] = [
    { why: "vector", items: vector.map((h) => ({ key: chunkKey(h), item: h })) },
    { why: "lexical", items: lexical.map((h) => ({ key: chunkKey(h), item: h })) },
  ];
  if (focus.length) lists.push({ why: "focus", items: focus.map((h) => ({ key: chunkKey(h), item: h })) });
  let fused = anchorBoost(rrfFuse(lists, opts.rrfK ?? d.rrfK), anchors.pages, [...anchors.ownPages, ...focusPages], {
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

  // 7.3 route questions: full markdown of anchor pages within a token budget. Two resolved entities of which
  // at least one is a place ("from Lenne's Rise to the Meteorite Staff" names an item as the destination).
  let pages: RetrievedPage[] = [];
  const locationEntities = anchors.entities.filter((e) => e.isLocation);
  if (routeQuestion && anchors.entities.length >= 2 && locationEntities.length >= 1) {
    const pageScore = new Map<string, number>();
    for (const f of fused) {
      const k = pageKey(f.item);
      pageScore.set(k, Math.max(pageScore.get(k) ?? 0, f.score));
    }
    pages = await timed("pages", () =>
      routePages(deps.pool, anchors.ownPages, anchors.spanPages ?? [], anchors.pages, pageScore, opts.pageTokenBudget ?? d.pageTokenBudget),
    );
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

/**
 * Own pages first (by best fused chunk score), then the walkthrough pages between the endpoints in page
 * order, then the remaining anchor pages by score (pages nothing matched come last, by page number); fill
 * the budget, then order by page.
 */
async function routePages(
  pool: Pool,
  ownPages: PageRef[],
  spanPages: PageRef[],
  anchorPages: PageRef[],
  pageScore: Map<string, number>,
  budget: number,
): Promise<RetrievedPage[]> {
  const byRelevance = (a: PageRef, b: PageRef): number =>
    (pageScore.get(pageKey(b)) ?? 0) - (pageScore.get(pageKey(a)) ?? 0) || a.book.localeCompare(b.book) || a.page - b.page;
  // When a walkthrough span exists, its book's own pages and the span itself come before own pages from other
  // books: an item's stat entry in another volume can be several thousand tokens and would crowd out the stops.
  const spanBooks = new Set(spanPages.map((p) => p.book));
  const ownFirst = ownPages.filter((p) => spanBooks.size === 0 || spanBooks.has(p.book)).sort(byRelevance);
  const ownLater = ownPages.filter((p) => spanBooks.size > 0 && !spanBooks.has(p.book)).sort(byRelevance);
  const seen = new Set(ownPages.map(pageKey));
  const span = spanPages.filter((p) => !seen.has(pageKey(p)));
  for (const p of span) seen.add(pageKey(p));
  const prioritised = [...ownFirst, ...span, ...ownLater, ...anchorPages.filter((p) => !seen.has(pageKey(p))).sort(byRelevance)];
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
