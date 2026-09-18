/**
 * One small POST helper for the Voyage API with exponential backoff on 429/5xx,
 * shared by the embedding and rerank providers.
 */
export interface VoyageHttpOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  maxRetries?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";

export async function voyagePost<T>(pathname: string, body: unknown, o: VoyageHttpOptions): Promise<T> {
  const url = (o.baseUrl ?? VOYAGE_BASE_URL).replace(/\/$/, "") + pathname;
  const maxRetries = o.maxRetries ?? 6;
  const fetchImpl = o.fetchImpl ?? fetch;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + o.apiKey },
      body: payload,
    });
    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const text = await res.text().catch(() => "");
      throw new Error("Voyage " + pathname + " failed: HTTP " + res.status + " " + text.slice(0, 500));
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(base + Math.random() * 500, 60_000)));
  }
}
