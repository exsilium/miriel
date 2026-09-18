/**
 * Candidate entity names from a query: word n-grams (1-4) plus the whole
 * query. Pure; no database.
 *
 * Spec 7.1 asks for capitalised n-grams. Users type lowercase, so every
 * n-gram (not starting/ending with a stopword) is a candidate for the cheap
 * exact match, while trigram matching is limited to capitalised n-grams,
 * multi-word n-grams and the whole query to keep noise down.
 */
import { normalizeName } from "@miriel/shared";

export interface Candidate {
  /** Query text as typed. */
  text: string;
  norm: string;
  /** Character span in the query. */
  start: number;
  end: number;
  words: number;
  capitalised: boolean;
  whole: boolean;
  /** Eligible for trigram (fuzzy) matching, not only exact. */
  fuzzy: boolean;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;

export const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "from", "in", "on", "at", "by", "for", "with", "into", "onto", "and", "or", "but",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "can", "could", "should", "would", "will",
  "i", "you", "we", "they", "he", "she", "it", "me", "my", "your", "our", "its", "his", "her", "their", "there",
  "this", "that", "these", "those", "what", "which", "where", "when", "who", "whom", "how", "why",
  "get", "got", "find", "reach", "go", "going", "way", "path", "route", "please", "tell", "show", "need", "want",
  "any", "all", "some", "each", "every", "many", "much", "as", "if", "then", "than", "so", "not", "no", "yes",
  "about", "after", "before", "near", "next", "up", "down", "out", "over", "under", "through", "between",
]);

/** Lowercase words allowed inside a capitalised name: "Academy of Raya Lucaria", "Queen of the Full Moon". */
const CONNECTIVES = new Set(["of", "the", "and", "in", "on", "at", "for", "to", "de", "du", "la", "le"]);

interface Word {
  text: string;
  start: number;
  end: number;
}

const isCap = (w: Word): boolean => /^\p{Lu}/u.test(w.text);
const isStop = (w: Word): boolean => STOPWORDS.has(w.text.toLowerCase());

export function extractCandidates(query: string, maxN = 4): Candidate[] {
  const words: Word[] = [];
  for (const m of query.matchAll(WORD_RE)) {
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }

  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate): void => {
    if (!c.norm || seen.has(c.norm)) return;
    seen.add(c.norm);
    out.push(c);
  };

  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const slice = words.slice(i, i + n);
      const first = slice[0]!;
      const last = slice[n - 1]!;
      // Names may start with a capitalised stopword ("The Four Belfries") but never end with one.
      const startsBadly = isStop(first) && !(isCap(first) && n >= 2 && isCap(slice[1]!));
      if (startsBadly || isStop(last)) continue;

      const text = query.slice(first.start, last.end);
      const norm = normalizeName(text);
      if (!norm) continue;
      if (n === 1 && norm.length < 3) continue;

      const capitalised =
        isCap(first) && isCap(last) && slice.slice(1, -1).every((w) => isCap(w) || CONNECTIVES.has(w.text.toLowerCase()));
      const fuzzy = capitalised || (n >= 2 && norm.length >= 8);
      push({ text, norm, start: first.start, end: last.end, words: n, capitalised, whole: false, fuzzy });
    }
  }

  const wholeNorm = normalizeName(query);
  if (words.length > 0 && wholeNorm) {
    push({
      text: query.trim(),
      norm: wholeNorm,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      words: words.length,
      capitalised: false,
      whole: true,
      fuzzy: true,
    });
  }
  return out;
}

/**
 * Route questions ask how to get somewhere. Bare "to" is deliberately not a
 * signal ("how to use Moonveil" is not a route), and neither is "how do I get
 * it"; "from", "get to", "go to", "path", "route", "way" are.
 */
export const ROUTE_RE = /\b(from|route|path|way|get to|go to|travel to|reach|head to)\b/i;

export function isRouteQuestion(query: string): boolean {
  return ROUTE_RE.test(query);
}

/**
 * Lexical query text: content words joined with " or ". Plain
 * websearch_to_tsquery ANDs every word, so a natural-language question
 * ("where is the Giant Rat Ashes and how do I get it") matches nothing;
 * OR-ing lets ts_rank_cd reward chunks that match more of the words.
 */
export function buildLexicalQuery(query: string): string {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const m of query.matchAll(WORD_RE)) {
    const w = m[0].replace(/['’]s$/i, "");
    const lower = w.toLowerCase();
    if (lower.length < 2 || STOPWORDS.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    words.push(w);
  }
  return words.length ? words.join(" or ") : query;
}
