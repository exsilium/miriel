/**
 * Fuzzy location of a cited quote inside a page's pdf.js text items. Pure.
 *
 * OCR text and the cited text differ in whitespace, case, punctuation and
 * the odd character, so both sides are normalised to lowercase alphanumerics
 * separated by single spaces before searching. If the whole quote is not
 * found, progressively shorter head and tail fragments are tried.
 */
export interface ItemRange {
  /** Index into the text items array. */
  item: number;
  /** Character range inside that item's string (end exclusive). */
  start: number;
  end: number;
}

interface Normalised {
  text: string;
  /** For each normalised char: [itemIndex, charIndexWithinItem]. Spaces map to the preceding char. */
  map: [number, number][];
}

const isWord = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

function normaliseItems(items: string[]): Normalised {
  let text = "";
  const map: [number, number][] = [];
  let pendingSpace = false;
  items.forEach((item, itemIndex) => {
    for (let i = 0; i < item.length; i++) {
      const ch = item[i]!;
      if (isWord(ch)) {
        if (pendingSpace && text.length) {
          text += " ";
          map.push(map[map.length - 1] ?? [itemIndex, i]);
        }
        pendingSpace = false;
        text += ch.toLowerCase();
        map.push([itemIndex, i]);
      } else {
        pendingSpace = true;
      }
    }
    pendingSpace = true; // item boundary always separates words
  });
  return { text, map };
}

export function normaliseQuote(quote: string): string {
  return normaliseItems([quote]).text;
}

/** Candidate search strings from longest to shortest, so partial matches still land near the claim. */
export function quoteCandidates(quote: string): string[] {
  const words = normaliseQuote(quote).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [words.join(" ")];
  const push = (ws: string[]): void => {
    const s = ws.join(" ");
    if (s.length >= 12 && !out.includes(s)) out.push(s);
  };
  if (words.length > 8) {
    push(words.slice(0, Math.ceil(words.length * 0.6)));
    push(words.slice(0, 8));
    push(words.slice(-8));
  } else if (words.length > 4) {
    push(words.slice(0, 5));
    push(words.slice(-4));
  }
  return out;
}

/** Ranges to highlight, one per touched item, or null when nothing matched. */
export function findQuote(items: string[], quote: string): ItemRange[] | null {
  const page = normaliseItems(items);
  if (!page.text) return null;
  for (const candidate of quoteCandidates(quote)) {
    const at = page.text.indexOf(candidate);
    if (at < 0) continue;
    const first = page.map[at]!;
    const last = page.map[at + candidate.length - 1]!;
    const ranges: ItemRange[] = [];
    for (let item = first[0]; item <= last[0]; item++) {
      const len = items[item]!.length;
      ranges.push({
        item,
        start: item === first[0] ? first[1] : 0,
        end: item === last[0] ? last[1] + 1 : len,
      });
    }
    return ranges.filter((r) => r.end > r.start);
  }
  return null;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** HTML for one text item with its highlighted range wrapped in <mark>. */
export function markItem(str: string, range: ItemRange | undefined): string {
  if (!range) return escapeHtml(str);
  return escapeHtml(str.slice(0, range.start)) + "<mark>" + escapeHtml(str.slice(range.start, range.end)) + "</mark>" + escapeHtml(str.slice(range.end));
}
