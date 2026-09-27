export interface PageRef {
  book: string;
  page: number;
}

export type EntityMatch = "exact" | "trigram" | "prior";

export interface ResolvedEntity {
  /** Name as printed (first spelling seen). */
  name: string;
  nameNorm: string;
  /** Distinct entity types this name carries across pages. */
  types: string[];
  /** Pages the entity appears on, sorted by book then page. */
  pages: PageRef[];
  match: EntityMatch;
  /** 1 for exact / prior, trigram similarity otherwise. */
  similarity: number;
  /** The query span that matched. */
  matchedText: string;
  isLocation: boolean;
}

export interface Anchors {
  entities: ResolvedEntity[];
  /** Own pages + one hop via connects_to + (route questions) same-region pages. */
  pages: PageRef[];
  /** Pages the resolved entities themselves appear on (get the x2 boost). */
  ownPages: PageRef[];
  /**
   * Route questions: the walkthrough pages between the endpoints' own pages (the guide numbers its stops
   * in traversal order, so these hold the waypoints). Subset of `pages`.
   */
  spanPages?: PageRef[];
}

/** focus: a chunk of a page the caller named (a checklist item's guide pages). */
export type Why = "vector" | "lexical" | "anchor" | "rerank" | "focus";

export interface RetrievedChunk {
  book: string;
  page: number;
  chunk_idx: number;
  text: string;
  heading_path: string;
  score: number;
  why: Why[];
  /** 1-based ranks in the individual retrievers, when present. */
  ranks: { vector?: number; lexical?: number; rerank?: number; focus?: number };
  context_kind: "chunk";
}

export interface RetrievedPage {
  context_kind: "page";
  book: string;
  page: number;
  chapter: string | null;
  region: string | null;
  markdown: string;
  tokens: number;
}

export interface RetrievalResult {
  query: string;
  routeQuestion: boolean;
  anchors: Anchors;
  chunks: RetrievedChunk[];
  /** Full-page context for route questions (7.3); empty otherwise. */
  pages: RetrievedPage[];
  stats: {
    embeddingTokens: number;
    rerankTokens: number;
    reranked: boolean;
    vectorHits: number;
    lexicalHits: number;
    timingsMs: Record<string, number>;
  };
}

export interface RetrieveOptions {
  /** Restrict to these book ids (default: all). */
  bookIds?: string[] | undefined;
  /** Drop trigram (fuzzy) matches on names that appear on more than this many pages ("Golden Rune"). */
  trigramMaxPages?: number | undefined;
  /** Route questions: keep at most this many same-region pages, the nearest to the entities' own pages. */
  regionPageCap?: number | undefined;
  /** Route questions: fill in the pages between two endpoints' own pages when they lie within this many pages. */
  routeSpanMax?: number | undefined;
  /** name_norm values resolved in the previous turn ("how do I get there?"). */
  priorEntities?: string[] | undefined;
  /**
   * Pages the question is about (a checklist item's guide pages, docs/build-spec-checklist.md §3 decision 6): their
   * chunks join the search as a ranked list of their own and get the own-page boost, so they are in the answer's
   * context even when no name in the question matches them.
   */
  focusPages?: PageRef[] | undefined;
  /** Run the rerank stage (default: RERANK_ENABLED env). */
  rerank?: boolean | undefined;
  topK?: number | undefined;
  vectorK?: number | undefined;
  lexicalK?: number | undefined;
  rerankK?: number | undefined;
  rrfK?: number | undefined;
  trigramThreshold?: number | undefined;
  pageTokenBudget?: number | undefined;
}

export const RETRIEVE_DEFAULTS = {
  topK: 12,
  vectorK: 40,
  lexicalK: 40,
  rerankK: 30,
  rrfK: 60,
  trigramThreshold: 0.6,
  trigramMaxPages: 40,
  regionPageCap: 12,
  routeSpanMax: 24,
  pageTokenBudget: 12_000,
  anchorBoost: 1.5,
  ownPageBoost: 2,
} as const;
