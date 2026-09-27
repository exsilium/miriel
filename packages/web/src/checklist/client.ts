/**
 * Client for /api/checklists and /api/runs (packages/api/src/routes/checklists.ts).
 */
import { noteUnauthorized, problemMessage, WRITE_HEADER } from "../api.js";

export interface ChecklistSummary {
  id: string;
  title: string;
  label: string;
  author: string | null;
  sourceUrl: string | null;
  books: string[];
  items: number;
}

export interface Npc {
  name: string;
  norm: string | null;
  entity?: string;
  match: string;
  chapter: { book: string; title: string; from: number; to: number } | null;
}

export interface Item {
  type: "item";
  id: string;
  ord: number;
  section: string;
  path: string[];
  text: string;
  prompt: string;
  optional: boolean;
  collectible: { name: string; n: number } | null;
  footnote: string | null;
  chain: string | null;
  npcs: Npc[];
  pages: { book: string; page: number; score?: number }[];
}

export interface Heading {
  type: "heading";
  section: string;
  level: number;
  title: string;
  path: string[];
}

export interface Note {
  type: "note";
  section: string;
  text: string;
}

export interface Checklist extends ChecklistSummary {
  outline: (Item | Heading | Note)[];
  chains: { id: string; label: string; items: string[] }[];
  footnotes: { id: string; marker: string; label: string; section: string; items: string[] }[];
  retired: { id: string; text: string; retiredAt: string }[];
}

export interface Run {
  id: string;
  name: string;
  createdAt: string;
  done: Record<string, number>;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { ...WRITE_HEADER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? null : JSON.stringify(body),
  });
  noteUnauthorized(res);
  if (!res.ok) throw new Error(await problemMessage(res));
  return (await res.json()) as T;
}

export const fetchChecklists = async (): Promise<ChecklistSummary[]> => (await call<{ checklists: ChecklistSummary[] }>("/api/checklists")).checklists;
export const fetchChecklist = (id: string): Promise<Checklist> => call("/api/checklists/" + encodeURIComponent(id));
export const fetchRuns = async (): Promise<Run[]> => (await call<{ runs: Run[] }>("/api/runs")).runs;
export const createRun = (name: string): Promise<Run> => call("/api/runs", "POST", { name });
export const renameRun = (id: string, name: string): Promise<Run> => call("/api/runs/" + id, "PATCH", { name });
export const deleteRun = (id: string): Promise<{ ok: true }> => call("/api/runs/" + id, "DELETE");
export const fetchProgress = async (runId: string): Promise<Record<string, string>> =>
  (await call<{ done: Record<string, string> }>("/api/runs/" + runId + "/progress")).done;
export const setDone = (runId: string, itemId: string, done: boolean): Promise<{ doneAt: string | null }> =>
  call("/api/runs/" + runId + "/progress/" + encodeURIComponent(itemId), done ? "PUT" : "DELETE");

/** The question an item's Ask sends (docs/build-spec-checklist.md §3 decision 6). */
export const askText = (item: Item): string => item.prompt + "\n\nExplain how to do this step and exactly where it is.";
