/**
 * The one place that defines `name_norm`. The indexer writes it and retrieval
 * queries with it; both must use this function so exact matches line up.
 *
 *   "Oridys's Rise"                  -> "oridyss rise"
 *   "Roots of the Haligtree–Floor 3"  -> "roots of the haligtree floor 3"
 *   "Demi-Human Forest Ruins"         -> "demi human forest ruins"
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    // apostrophes (straight and curly) are deleted, not spaced: "lenne's" -> "lennes"
    .replace(/['’‘]/g, "")
    // everything that is not a letter, digit or whitespace becomes a space
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
