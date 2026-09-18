/**
 * Rerank provider interface (optional second-stage scoring). Voyage only for
 * now; RERANK_MODEL defaults to the production-recommended rerank-2.5.
 */
import { voyagePost } from "./voyage-http.js";

export interface RerankHit {
  /** Index into the `documents` array passed to rerank(). */
  index: number;
  /** Provider relevance score, higher is better. */
  score: number;
}

export interface RerankResult {
  hits: RerankHit[];
  tokens: number;
}

export interface RerankProvider {
  readonly name: string;
  readonly model: string;
  rerank(query: string, documents: string[], topK?: number): Promise<RerankResult>;
}

export interface RerankProviderOptions {
  provider?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
}

export function createRerankProvider(opts: RerankProviderOptions = {}): RerankProvider {
  const provider = (opts.provider ?? process.env["RERANK_PROVIDER"] ?? "voyage").toLowerCase();
  switch (provider) {
    case "voyage": {
      const apiKey = opts.apiKey ?? process.env["VOYAGE_API_KEY"];
      if (!apiKey) throw new Error("VOYAGE_API_KEY is not set (or pass apiKey)");
      return new VoyageRerank({ apiKey, model: opts.model ?? process.env["RERANK_MODEL"] ?? "rerank-2.5" });
    }
    default:
      throw new Error("Unknown RERANK_PROVIDER: " + provider);
  }
}

interface VoyageRerankResponse {
  data: { index: number; relevance_score: number }[];
  model: string;
  usage: { total_tokens: number };
}

export class VoyageRerank implements RerankProvider {
  readonly name = "voyage";
  readonly model: string;
  private readonly http: { apiKey: string; baseUrl?: string | undefined; fetchImpl?: typeof fetch | undefined };

  constructor(o: { apiKey: string; model: string; baseUrl?: string | undefined; fetchImpl?: typeof fetch | undefined }) {
    this.model = o.model;
    this.http = o;
  }

  async rerank(query: string, documents: string[], topK?: number): Promise<RerankResult> {
    if (documents.length === 0) return { hits: [], tokens: 0 };
    const json = await voyagePost<VoyageRerankResponse>(
      "/rerank",
      { query, documents, model: this.model, top_k: topK ?? null, return_documents: false, truncation: true },
      this.http,
    );
    const hits = json.data
      .map((d) => ({ index: d.index, score: d.relevance_score }))
      .sort((a, b) => b.score - a.score);
    return { hits, tokens: json.usage?.total_tokens ?? 0 };
  }
}
