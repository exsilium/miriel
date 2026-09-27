/**
 * Minimal client-side routing (no router dependency): the reader at "/", the retake views under "/retakes",
 * user administration at "/admin/users", the quest checklist at "/checklist[?list=<id>]" (next to the viewer, like chat).
 * nginx and the Vite dev server fall back to index.html for unknown paths.
 */
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "reader" }
  | { name: "retakes" }
  | { name: "retake-batch"; book: string | null }
  | { name: "retake-page"; book: string; page: number }
  | { name: "admin-users" }
  | { name: "checklist"; list: string | null };

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "admin" && parts[1] === "users" && parts.length === 2) return { name: "admin-users" };
  if (parts[0] === "checklist" && parts.length === 1) return { name: "checklist", list: new URLSearchParams(search).get("list") };
  if (parts[0] !== "retakes") return { name: "reader" };
  if (parts.length === 1) return { name: "retakes" };
  if (parts[1] === "batch") return { name: "retake-batch", book: new URLSearchParams(search).get("book") };
  const page = Number(parts[2]);
  if (parts.length === 3 && parts[1] && Number.isInteger(page)) return { name: "retake-page", book: parts[1], page };
  return { name: "retakes" };
}

const listeners = new Set<() => void>();
if (typeof window !== "undefined") window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const href = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => window.location.pathname + window.location.search,
  );
  const url = new URL(href, window.location.origin);
  return parseRoute(url.pathname, url.search);
}

export const retakePagePath = (book: string, page: number): string => "/retakes/" + encodeURIComponent(book) + "/" + page;
export const readerPath = (book: string, page: number): string => "/?book=" + encodeURIComponent(book) + "&page=" + page;
