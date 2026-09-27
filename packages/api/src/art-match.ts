/**
 * Art next to answers (docs/build-spec-artbooks.md §7): which artworks to show under a chat answer.
 *
 * Subjects are the question's anchor entities (retrieval resolves them against the guides' entity names). An
 * artwork matches a subject when one of its names is that subject, either the name itself or the guide spelling
 * it was verified to (a plural "s" on the last word ignored). A subject that is a person (npc, boss, merchant in
 * the guides) also matches titled forms of its name, ranked after exact matches of the same tier: "Malenia, Blade of
 * Miquella", "Godrick the Grafted", "Radagon of the Golden Order", "Starscourge Radahn" (not "Radahn Soldier"). Tiers:
 *   0  caption name (translated from the printed caption)
 *   1  visual name, confidence high
 *   2  visual name, confidence medium            (low-confidence visual names never match)
 *   3  text search ("what does … look like"): nearest artwork descriptions above ART_MIN_SIMILARITY(_WITH_NAMES)
 * At most PER_SUBJECT artworks per subject, one per spread and subject, ART_LIMIT in total. The answer model never
 * sees any of this; the strip is shown next to its answer.
 */
import { normalizeName } from "@miriel/shared";
import type { Pool } from "@miriel/shared/db";
import { artworksByVector, artworksForEntities, type Artwork } from "./art.js";
import type { RetrievalResult } from "./retrieval/types.js";

export const ART_LIMIT = 6;
export const PER_SUBJECT = 2;
/**
 * Cosine similarity of question and artwork text below which a text-search hit is not shown: stricter when name
 * matches already fill the strip (Melina scored 0.515 for "what does Malenia look like"), looser when there are none.
 */
export const ART_MIN_SIMILARITY = 0.55;
export const ART_MIN_SIMILARITY_WITH_NAMES = 0.58;

/** Last word without a plural "s", so the guides' "crucible knights" meets the art's "crucible knight". */
export function singular(norm: string): string {
  const i = norm.lastIndexOf(" ") + 1;
  const last = norm.slice(i);
  return last.length > 3 && last.endsWith("s") && !last.endsWith("ss") ? norm.slice(0, i) + last.slice(0, -1) : norm;
}

/** Questions about how something looks get the text search on top of the name matches. */
export const APPEARANCE_RE =
  /\b(look(s|ed)? like|what does .{1,60} look|appearance|show me|picture|image|artwork|art of|concept art|design(s|ed)?|illustration|drawing|painting)\b/i;

export interface ArtItem {
  id: number;
  book: string;
  pdfPage: number;
  folios: number[];
  bbox: [number, number, number, number];
  kind: string;
  /** Name shown under the crop: the matched name, else the first name, else null (text-search hits). */
  name: string | null;
  source: "caption" | "visual" | "search";
  confidence: "high" | "medium" | "low";
  captionJa: string | null;
  description: string;
  imageVersion: string | null;
  /** name_norm of the subject this artwork was matched for; null for text-search hits. */
  subject: string | null;
  tier: number;
}

export interface Subject {
  nameNorm: string;
  /** npc / boss / merchant in the guides: titled forms of the name also match. */
  person?: boolean;
}

const PERSON_TYPES = new Set(["npc", "boss", "merchant"]);

/** "Malenia, Blade of Miquella" / "Godrick the Grafted" / "Radagon of the Golden Order" / "Starscourge Radahn" for a person. */
export function titledForm(rawName: string, subject: string): boolean {
  const norm = normalizeName(rawName);
  if (normalizeName(rawName.split(",")[0]!) === subject && rawName.includes(",")) return true;
  if (norm.startsWith(subject + " the ") || norm.startsWith(subject + " of ")) return true;
  return norm.endsWith(" " + subject) && !norm.includes(" of ");
}

/** Best tier at which an artwork shows `subject`, with the name that matched; null when it does not qualify. */
export function matchTier(art: Artwork, subject: string, person = false): { tier: number; exact: boolean; name: string; source: "caption" | "visual" } | null {
  let best: { tier: number; exact: boolean; name: string; source: "caption" | "visual" } | null = null;
  for (const n of art.names) {
    const raws = [n.name, ...(n.verified && n.entity !== null ? [n.entity] : [])];
    const forms = raws.map(normalizeName);
    const exact = forms.includes(subject) || forms.some((f) => singular(f) === singular(subject));
    if (!exact && !(person && raws.some((r) => titledForm(r, subject)))) continue;
    // a visual guess stays a guess even when it spells a guide name exactly
    const tier = n.source === "caption" ? 0 : art.confidence === "high" ? 1 : art.confidence === "medium" ? 2 : -1;
    if (tier < 0) continue;
    if (!best || tier < best.tier || (tier === best.tier && exact && !best.exact)) best = { tier, exact, name: n.name, source: n.source };
  }
  return best;
}

/** Pick and order the strip from name-matched candidates and text-search hits. */
export function rankArt(subjects: Subject[], candidates: Artwork[], searchHits: (Artwork & { similarity: number })[] = []): ArtItem[] {
  const scored: { item: ArtItem; order: number; exact: boolean }[] = [];
  subjects.forEach((s, order) => {
    for (const art of candidates) {
      const m = matchTier(art, s.nameNorm, s.person);
      if (m) scored.push({ item: toItem(art, m.name, m.source, s.nameNorm, m.tier), order, exact: m.exact });
    }
  });
  // tier first, exact before word-prefix matches, then the order the subjects appear in the question, then book order
  scored.sort(
    (a, b) =>
      a.item.tier - b.item.tier || Number(b.exact) - Number(a.exact) || a.order - b.order ||
      a.item.book.localeCompare(b.item.book) || a.item.pdfPage - b.item.pdfPage,
  );

  const out: ArtItem[] = [];
  const perSubject = new Map<string, number>();
  const seenSpread = new Set<string>();
  const seenArt = new Set<number>();
  for (const { item } of scored) {
    if (out.length >= ART_LIMIT) break;
    const subject = item.subject!;
    const spreadKey = subject + "|" + item.book + ":" + item.pdfPage;
    if (seenArt.has(item.id) || seenSpread.has(spreadKey) || (perSubject.get(subject) ?? 0) >= PER_SUBJECT) continue;
    out.push(item);
    seenArt.add(item.id);
    seenSpread.add(spreadKey);
    perSubject.set(subject, (perSubject.get(subject) ?? 0) + 1);
  }
  const minSimilarity = out.length ? ART_MIN_SIMILARITY_WITH_NAMES : ART_MIN_SIMILARITY;
  for (const hit of searchHits) {
    if (out.length >= ART_LIMIT) break;
    if (hit.similarity < minSimilarity || seenArt.has(hit.id)) continue;
    // show a name only when it is not a low-confidence guess
    const named = hit.names.find((n) => n.source === "caption" || hit.confidence !== "low");
    out.push(toItem(hit, named?.name ?? null, "search", null, 3));
    seenArt.add(hit.id);
  }
  return out;
}

function toItem(a: Artwork, name: string | null, source: ArtItem["source"], subject: string | null, tier: number): ArtItem {
  return {
    id: a.id,
    book: a.book,
    pdfPage: a.pdfPage,
    folios: a.folios,
    bbox: a.bbox,
    kind: a.kind,
    name,
    source,
    confidence: a.confidence,
    captionJa: a.captionJa,
    description: a.description,
    imageVersion: a.imageVersion,
    subject,
    tier,
  };
}

export interface FindArtDeps {
  pool: Pool;
  embedQuery?: ((text: string) => Promise<number[]>) | undefined;
}

/** The artworks to show for a question and its retrieval result (empty when no art book is indexed). */
export async function findArt(deps: FindArtDeps, query: string, retrieval: Pick<RetrievalResult, "anchors">): Promise<ArtItem[]> {
  const subjects = retrieval.anchors.entities
    .filter((e) => e.match !== "prior")
    .map((e) => ({ nameNorm: e.nameNorm, person: e.types.some((t) => PERSON_TYPES.has(t)) }));
  const norms = [...new Set(subjects.flatMap((s) => [s.nameNorm, singular(s.nameNorm)]))];
  const candidates = await artworksForEntities(deps.pool, norms, undefined, 200);
  const hits = APPEARANCE_RE.test(query) && deps.embedQuery ? await artworksByVector(deps.pool, await deps.embedQuery(query), undefined, 8) : [];
  return rankArt(subjects, candidates, hits);
}
