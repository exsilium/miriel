/**
 * 7.1 Entity resolution: query -> resolved entities -> anchor pages.
 *
 * Candidates are matched against entities.name_norm (exact, then trigram) and
 * against the distinct pages.region values (exact), because many region names
 * ("Miquella's Haligtree", "Liurnia of the Lakes") only occur as a page's
 * region and not as an entity on that page.
 */
import { LOCATION_ENTITY_TYPES, normalizeName } from "@miriel/shared";
import { withTransaction, type Pool } from "@miriel/shared/db";
import { extractCandidates, type Candidate } from "./candidates.js";
import { pageKey } from "./fuse.js";
import type { Anchors, EntityMatch, PageRef, ResolvedEntity } from "./types.js";

interface EntityRow {
  id: string;
  book_id: string;
  page: number;
  type: string;
  name: string;
  name_norm: string;
  matched: string;
  sim: number;
  match: EntityMatch;
}

const LOCATION_TYPES: ReadonlySet<string> = new Set(LOCATION_ENTITY_TYPES);
const MATCH_RANK: Record<EntityMatch, number> = { exact: 3, prior: 2, trigram: 1 };

const EXACT_SQL = `
  SELECT e.id::text, e.book_id, e.page, e.type, e.name, e.name_norm, c.norm AS matched, 1.0::float8 AS sim, $3::text AS match
  FROM unnest($1::text[]) AS c(norm)
  JOIN entities e ON e.name_norm = c.norm
  WHERE $2::text[] IS NULL OR e.book_id = ANY($2::text[])`;

const TRIGRAM_SQL = `
  SELECT e.id::text, e.book_id, e.page, e.type, e.name, e.name_norm, c.norm AS matched,
         similarity(e.name_norm, c.norm)::float8 AS sim, 'trigram'::text AS match
  FROM unnest($1::text[]) AS c(norm)
  JOIN entities e ON e.name_norm % c.norm
  WHERE e.name_norm <> c.norm AND ($2::text[] IS NULL OR e.book_id = ANY($2::text[]))`;

const REGIONS_SQL = `
  SELECT p.book_id, p.region, array_agg(p.page ORDER BY p.page) AS pages
  FROM pages p
  WHERE p.region IS NOT NULL AND ($1::text[] IS NULL OR p.book_id = ANY($1::text[]))
  GROUP BY p.book_id, p.region`;

/** Pages of entities one hop away via connects_to, in either direction. */
const ONE_HOP_SQL = `
  SELECT DISTINCT e2.book_id, e2.page
  FROM entities e1
  JOIN entity_links l ON l.from_entity = e1.id
  JOIN entities e2 ON e2.book_id = e1.book_id AND e2.name_norm = l.to_name_norm
  WHERE e1.name_norm = ANY($1::text[]) AND ($2::text[] IS NULL OR e1.book_id = ANY($2::text[]))
  UNION
  SELECT DISTINCT e1.book_id, e1.page
  FROM entities e1
  JOIN entity_links l ON l.from_entity = e1.id
  WHERE l.to_name_norm = ANY($1::text[]) AND ($2::text[] IS NULL OR e1.book_id = ANY($2::text[]))`;

/** Pages whose region equals a region the resolved entities live in (or a resolved region entity's own name). */
const REGION_PAGES_SQL = `
  WITH regions AS (
    SELECT DISTINCT p.book_id, p.region
    FROM entities e JOIN pages p ON p.book_id = e.book_id AND p.page = e.page
    WHERE e.name_norm = ANY($1::text[]) AND p.region IS NOT NULL
    UNION
    SELECT DISTINCT e.book_id, e.name FROM entities e WHERE e.name_norm = ANY($1::text[]) AND e.type = 'region'
  )
  SELECT DISTINCT p.book_id, p.page
  FROM pages p JOIN regions r ON r.book_id = p.book_id AND r.region = p.region
  WHERE $2::text[] IS NULL OR p.book_id = ANY($2::text[])`;

export interface ResolveOptions {
  bookIds?: string[] | undefined;
  priorEntities?: string[] | undefined;
  trigramThreshold: number;
  routeQuestion: boolean;
}

export async function resolveEntities(pool: Pool, query: string, o: ResolveOptions): Promise<Anchors> {
  const candidates = extractCandidates(query);
  const byNorm = new Map<string, Candidate>(candidates.map((x) => [x.norm, x]));
  const books = o.bookIds && o.bookIds.length ? o.bookIds : null;

  const { rows, regionRows } = await withTransaction(pool, async (c) => {
    await c.query("SELECT set_config('pg_trgm.similarity_threshold', $1, true)", [String(o.trigramThreshold)]);
    const exact = await c.query<EntityRow>(EXACT_SQL, [candidates.map((x) => x.norm), books, "exact"]);
    const exactNorms = new Set(exact.rows.map((r) => r.matched));
    const fuzzyNorms = candidates.filter((x) => x.fuzzy && !exactNorms.has(x.norm)).map((x) => x.norm);
    const trigram = fuzzyNorms.length ? await c.query<EntityRow>(TRIGRAM_SQL, [fuzzyNorms, books]) : { rows: [] as EntityRow[] };
    const prior =
      o.priorEntities && o.priorEntities.length
        ? await c.query<EntityRow>(EXACT_SQL, [o.priorEntities, books, "prior"])
        : { rows: [] as EntityRow[] };
    const regions = await c.query<{ book_id: string; region: string; pages: number[] }>(REGIONS_SQL, [books]);
    return { rows: [...exact.rows, ...trigram.rows, ...prior.rows], regionRows: regions.rows };
  });

  // Regions: exact match on the normalized region name, presented as a synthetic region entity.
  for (const r of regionRows) {
    const norm = normalizeName(r.region);
    if (!byNorm.has(norm)) continue;
    for (const page of r.pages) {
      rows.push({ id: "", book_id: r.book_id, page, type: "region", name: r.region, name_norm: norm, matched: norm, sim: 1, match: "exact" });
    }
  }

  // Decide which query spans count. Exact spans beat trigram spans that contain
  // them ("godskin apostle" over "godskin apostle drop"); among equals, longest wins.
  const kindOf = new Map<string, EntityMatch>();
  for (const r of rows) {
    if (r.match === "prior") continue;
    const cur = kindOf.get(r.matched);
    if (!cur || MATCH_RANK[r.match] > MATCH_RANK[cur]) kindOf.set(r.matched, r.match);
  }
  const matched = [...kindOf.keys()].map((n) => byNorm.get(n)).filter((x): x is Candidate => x !== undefined);
  const keptNorms = new Set(selectSpans(matched, kindOf).map((x) => x.norm));

  const grouped = new Map<string, ResolvedEntity>();
  for (const r of rows) {
    if (r.match !== "prior" && !keptNorms.has(r.matched)) continue;
    let e = grouped.get(r.name_norm);
    if (!e) {
      e = {
        name: r.name,
        nameNorm: r.name_norm,
        types: [],
        pages: [],
        match: r.match,
        similarity: r.sim,
        matchedText: r.match === "prior" ? r.name : (byNorm.get(r.matched)?.text ?? r.matched),
        isLocation: false,
      };
      grouped.set(r.name_norm, e);
    }
    if (!e.types.includes(r.type)) e.types.push(r.type);
    if (!e.pages.some((p) => p.book === r.book_id && p.page === r.page)) e.pages.push({ book: r.book_id, page: r.page });
    if (MATCH_RANK[r.match] > MATCH_RANK[e.match] || (r.match === e.match && r.sim > e.similarity)) {
      e.match = r.match;
      e.similarity = r.sim;
      if (r.match !== "prior") e.matchedText = byNorm.get(r.matched)?.text ?? r.matched;
    }
  }

  const entities = [...grouped.values()].map((e) => ({
    ...e,
    isLocation: e.types.some((t) => LOCATION_TYPES.has(t)),
    pages: e.pages.sort(cmpPage),
  }));
  entities.sort(
    (a, b) => MATCH_RANK[b.match] - MATCH_RANK[a.match] || b.similarity - a.similarity || b.matchedText.length - a.matchedText.length || a.name.localeCompare(b.name),
  );

  const ownPages = dedupePages(entities.flatMap((e) => e.pages));
  const norms = entities.map((e) => e.nameNorm);
  const anchorPages = [...ownPages];
  if (norms.length) {
    const hop = await pool.query<{ book_id: string; page: number }>(ONE_HOP_SQL, [norms, books]);
    anchorPages.push(...hop.rows.map((r) => ({ book: r.book_id, page: r.page })));
    if (o.routeQuestion) {
      const region = await pool.query<{ book_id: string; page: number }>(REGION_PAGES_SQL, [norms, books]);
      anchorPages.push(...region.rows.map((r) => ({ book: r.book_id, page: r.page })));
    }
  }

  return { entities, pages: dedupePages(anchorPages), ownPages };
}

/**
 * Keep a matched span unless (a) it lies inside a kept span of at least its
 * match quality, or (b) it is a trigram span that contains an exact span.
 */
export function selectSpans<T extends { norm: string; start: number; end: number }>(
  matched: T[],
  kindOf: Map<string, EntityMatch>,
): T[] {
  const len = (x: T): number => x.end - x.start;
  const rank = (x: T): number => MATCH_RANK[kindOf.get(x.norm) ?? "trigram"];
  const contains = (outer: T, inner: T): boolean => outer.start <= inner.start && inner.end <= outer.end && len(outer) > len(inner);

  const exactSpans = matched.filter((x) => rank(x) === MATCH_RANK.exact);
  const withoutShadowing = matched.filter((x) => rank(x) === MATCH_RANK.exact || !exactSpans.some((e) => contains(x, e)));

  const sorted = withoutShadowing.slice().sort((a, b) => rank(b) - rank(a) || len(b) - len(a));
  const kept: T[] = [];
  for (const x of sorted) {
    const nested = kept.some((k) => contains(k, x) && rank(k) >= rank(x));
    if (!nested) kept.push(x);
  }
  return kept;
}

const cmpPage = (a: PageRef, b: PageRef): number => a.book.localeCompare(b.book) || a.page - b.page;

export function dedupePages(pages: PageRef[]): PageRef[] {
  const seen = new Set<string>();
  const out: PageRef[] = [];
  for (const p of pages) {
    const k = pageKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.sort(cmpPage);
}
