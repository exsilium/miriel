/**
 * Reciprocal rank fusion and anchor boosting. Pure functions.
 */
import type { PageRef, Why } from "./types.js";

export interface RankedList<T> {
  why: Why;
  /** Items in rank order (index 0 = rank 1). */
  items: { key: string; item: T }[];
}

export interface Fused<T> {
  key: string;
  item: T;
  score: number;
  why: Why[];
  ranks: Partial<Record<Why, number>>;
}

/** score = sum over lists of 1 / (k + rank). Output sorted by score desc, then key for stability. */
export function rrfFuse<T>(lists: RankedList<T>[], k = 60): Fused<T>[] {
  const byKey = new Map<string, Fused<T>>();
  for (const list of lists) {
    list.items.forEach(({ key, item }, i) => {
      const rank = i + 1;
      const f = byKey.get(key) ?? { key, item, score: 0, why: [], ranks: {} };
      f.score += 1 / (k + rank);
      if (!f.why.includes(list.why)) f.why.push(list.why);
      f.ranks[list.why] = rank;
      byKey.set(key, f);
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export const pageKey = (p: PageRef): string => p.book + ":" + p.page;

/**
 * Multiply scores of chunks on anchor pages by `anchor`, and on the resolved
 * entities' own pages by `own` instead (own pages are always anchor pages).
 */
export function anchorBoost<T extends PageRef>(
  fused: Fused<T>[],
  anchorPages: Iterable<PageRef>,
  ownPages: Iterable<PageRef>,
  boosts: { anchor: number; own: number },
): Fused<T>[] {
  const anchors = new Set([...anchorPages].map(pageKey));
  const own = new Set([...ownPages].map(pageKey));
  if (anchors.size === 0 && own.size === 0) return fused;
  const out = fused.map((f) => {
    const key = pageKey(f.item);
    const factor = own.has(key) ? boosts.own : anchors.has(key) ? boosts.anchor : 1;
    if (factor === 1) return f;
    return { ...f, score: f.score * factor, why: f.why.includes("anchor") ? f.why : [...f.why, "anchor" as Why] };
  });
  return out.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Greedy pick in priority order, skipping items that do not fit, until the budget is used. */
export function selectWithinBudget<T extends { tokens: number }>(prioritised: T[], budget: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const p of prioritised) {
    if (used + p.tokens > budget) continue;
    out.push(p);
    used += p.tokens;
  }
  return out;
}
