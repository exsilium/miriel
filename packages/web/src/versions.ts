/**
 * Photo versions per page ("book:page" -> imageVersion), for ?v= on page image and thumbnail URLs. Filled from
 * GET /api/books/:id/image-versions (on load and whenever a book's pdfRevision changes, i.e. after a retake)
 * and from chat events (anchors.imageVersions, citation.imageVersion). A versioned URL is cached as immutable
 * by the browser; a replaced photo gets a new version and so a new URL.
 */
import { useSyncExternalStore } from "react";

const versions = new Map<string, string>();
const listeners = new Set<() => void>();
let tick = 0;

function changed(): void {
  tick += 1;
  for (const l of listeners) l();
}

export function imageVersionOf(book: string, page: number): string | undefined {
  return versions.get(book + ":" + page);
}

/** Merge "book:page" -> version entries (chat events). */
export function rememberVersions(entries: Record<string, string> | undefined | null): void {
  if (!entries) return;
  let any = false;
  for (const [key, v] of Object.entries(entries)) {
    if (v && versions.get(key) !== v) {
      versions.set(key, v);
      any = true;
    }
  }
  if (any) changed();
}

/** Replace every version of one book (printed page -> version). */
export function setBookVersions(book: string, pages: Record<string, string>): void {
  for (const key of [...versions.keys()]) if (key.startsWith(book + ":")) versions.delete(key);
  for (const [page, v] of Object.entries(pages)) versions.set(book + ":" + page, v);
  changed();
}

/** Re-render when versions change (components that build image/thumbnail URLs). */
export function useImageVersions(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => tick,
  );
}
