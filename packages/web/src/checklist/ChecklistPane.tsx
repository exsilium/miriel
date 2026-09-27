/**
 * The quest checklist next to the viewer (docs/build-spec-checklist.md §6 Phase E): one tab per list, sections in
 * play order (collapsible, done / total), notes in place, and per item a checkbox, the NPC names linked to their
 * guide chapters, the item's guide pages and Ask (the chat answers it from those pages). Ticks belong to the
 * selected run and are saved at once (optimistic; undone if the request fails). Logged out, the list is readable
 * and the checkboxes are off.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/context.js";
import { navigate } from "../route.js";
import { useAppState } from "../state.js";
import {
  askText,
  createRun,
  deleteRun,
  fetchChecklist,
  fetchChecklists,
  fetchProgress,
  fetchRuns,
  renameRun,
  setDone,
  type Checklist,
  type ChecklistSummary,
  type Heading,
  type Item,
  type Note,
  type Run,
} from "./client.js";

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* private mode: remembered for this page view only */
    }
  },
};

interface Section {
  heading: Heading | null;
  rows: (Item | Heading | Note)[];
  items: Item[];
}

/** Top-level (##) sections with everything under them, in file order. */
function sectionsOf(c: Checklist): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: null, rows: [], items: [] };
  for (const r of c.outline) {
    if (r.type === "heading" && r.level <= 2) {
      if (cur.heading || cur.rows.length) out.push(cur);
      cur = { heading: r, rows: [], items: [] };
      continue;
    }
    cur.rows.push(r);
    if (r.type === "item") cur.items.push(r);
  }
  if (cur.heading || cur.rows.length) out.push(cur);
  return out;
}

const plain = (s: string): string => s.replace(/\*+/g, "").toLowerCase();

/** A reader path that keeps the viewer's ?book=&page= (and drops the checklist's ?list=). */
export function pathKeepingBook(path: string, list?: string | null): string {
  const params = new URLSearchParams(window.location.search);
  params.delete("list");
  if (list) params.set("list", list);
  const q = params.toString();
  return path + (q ? "?" + q : "");
}

/** One filter entry per person: names that lead to the same guide chapter ("D", "D, Hunter of the Dead") are one. */
const npcKey = (n: Item["npcs"][number]): string | null =>
  n.chapter ? "c:" + n.chapter.book + ":" + n.chapter.title : n.norm ? "n:" + n.norm : null;

/** The page lies in the chapter of one of the item's NPCs (the guide's own write-up of the quest step). */
const chapterPage = (item: Item, p: { book: string; page: number }): boolean =>
  item.npcs.some((n) => n.chapter && n.chapter.book === p.book && p.page >= n.chapter.from && p.page <= n.chapter.to);

export function ChecklistPane({ onShowBook }: { onShowBook: () => void }) {
  const { books, goTo, ask } = useAppState();
  const { user, showLogin } = useAuth();
  const [lists, setLists] = useState<ChecklistSummary[] | null>(null);
  const [listId, setListId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("list") ?? store.get("miriel.checklist.list"));
  const [list, setList] = useState<Checklist | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [done, setDoneMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(() => store.get("miriel.checklist.hideDone") === "1");
  const [query, setQuery] = useState("");
  const [npc, setNpc] = useState("");
  const [chain, setChain] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const bookLabel = useCallback((id: string) => books.find((b) => b.id === id)?.label ?? id, [books]);

  useEffect(() => {
    fetchChecklists()
      .then((l) => {
        setLists(l);
        setListId((cur) => (cur && l.some((x) => x.id === cur) ? cur : l[0]?.id ?? null));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!listId) return;
    store.set("miriel.checklist.list", listId);
    const url = new URL(window.location.href);
    if (url.pathname.startsWith("/checklist")) {
      url.searchParams.set("list", listId);
      window.history.replaceState(null, "", url);
    }
    setList(null);
    setNpc("");
    setChain("");
    setCollapsed(new Set(JSON.parse(store.get("miriel.checklist.collapsed." + listId) ?? "[]") as string[]));
    fetchChecklist(listId)
      .then(setList)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [listId]);

  // runs of the logged-in user; the selected one is remembered per user
  useEffect(() => {
    if (!user) {
      setRuns([]);
      setRunId(null);
      setDoneMap({});
      return;
    }
    fetchRuns()
      .then((r) => {
        setRuns(r);
        const saved = store.get("miriel.run." + user.id);
        setRunId(r.find((x) => x.id === saved)?.id ?? r[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [user]);

  useEffect(() => {
    if (!runId || !user) return;
    store.set("miriel.run." + user.id, runId);
    fetchProgress(runId)
      .then(setDoneMap)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [runId, user]);

  const toggle = useCallback(
    (item: Item) => {
      if (!runId) return;
      const was = done[item.id];
      const now = !was;
      setDoneMap((d) => {
        const next = { ...d };
        if (now) next[item.id] = new Date().toISOString();
        else delete next[item.id];
        return next;
      });
      setDone(runId, item.id, now).catch((e: unknown) => {
        setDoneMap((d) => {
          const next = { ...d };
          if (was) next[item.id] = was;
          else delete next[item.id];
          return next;
        });
        setError("Not saved: " + (e instanceof Error ? e.message : String(e)));
      });
    },
    [done, runId],
  );

  const setCollapsedSaved = (next: Set<string>): void => {
    setCollapsed(next);
    if (listId) store.set("miriel.checklist.collapsed." + listId, JSON.stringify([...next]));
  };

  const sections = useMemo(() => (list ? sectionsOf(list) : []), [list]);
  const allItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const npcOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of allItems) {
      for (const n of i.npcs) {
        const k = npcKey(n);
        if (k) m.set(k, n.chapter?.title ?? n.entity ?? n.name);
      }
    }
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allItems]);

  const filtering = hideDone || query.trim() !== "" || npc !== "" || chain !== "";
  const q = query.trim().toLowerCase();
  const visible = (i: Item): boolean =>
    (!hideDone || !done[i.id]) && (!q || plain(i.text).includes(q)) && (!npc || i.npcs.some((n) => npcKey(n) === npc)) && (!chain || i.chain === chain);

  const doneCount = allItems.filter((i) => done[i.id]).length;
  const retiredDone = (list?.retired ?? []).filter((r) => done[r.id]);

  const openPage = (book: string, page: number): void => {
    goTo(book, page);
    onShowBook();
  };
  const askItem = (item: Item): void => {
    ask(askText(item), item.pages.map((p) => ({ book: p.book, page: p.page })), list?.books);
    navigate(pathKeepingBook("/"));
  };
  const jumpToSection = (slug: string): void => {
    const top = slug.split("/")[0]!;
    if (collapsed.has(top)) {
      const next = new Set(collapsed);
      next.delete(top);
      setCollapsedSaved(next);
    }
    setTimeout(() => document.getElementById("sec-" + slug)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const run = runs.find((r) => r.id === runId) ?? null;
  const runAction = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const renderText = (item: Item): ReactNode => {
    const parts = item.text.split(/(\*\*[^*]+?\*\*)/g);
    return parts.map((p, k) => {
      const m = /^\*\*([^*]+?)\*\*$/.exec(p);
      if (!m) return <Fragment key={k}>{p.replace(/\*/g, "")}</Fragment>;
      const span = m[1]!;
      const who = item.npcs.find((n) => n.chapter && n.match !== "text" && span.includes(n.name));
      return who?.chapter ? (
        <button
          key={k}
          className="npc-link"
          title={"Open " + who.chapter.title + " (" + bookLabel(who.chapter.book) + " p. " + who.chapter.from + ")"}
          onClick={() => openPage(who.chapter!.book, who.chapter!.from)}
        >
          {span}
        </button>
      ) : (
        <strong key={k}>{span}</strong>
      );
    });
  };

  const chainOf = (id: string | null) => list?.chains.find((c) => c.id === id) ?? null;
  const footnoteOf = (id: string | null) => list?.footnotes.find((f) => f.id === id) ?? null;
  const multiBook = (list?.books.length ?? 0) > 1;

  const renderItem = (item: Item): ReactNode => {
    const c = chainOf(item.chain);
    const f = footnoteOf(item.footnote);
    const isDone = Boolean(done[item.id]);
    return (
      <li key={item.id} className={"cl-item" + (isDone ? " done" : "")}>
        <input
          type="checkbox"
          checked={isDone}
          disabled={!runId}
          onChange={() => toggle(item)}
          aria-label={"Done: " + plain(item.text).slice(0, 60)}
          title={runId ? undefined : "Log in to tick items"}
        />
        <div className="cl-body">
          <div className="cl-text">{renderText(item)}</div>
          <div className="cl-meta">
            {item.optional && <span className="chip-s">optional</span>}
            {item.collectible && (
              <span className="chip-s">
                {item.collectible.name} {item.collectible.n}
              </span>
            )}
            {f && (
              <button className="chip-s footnote" onClick={() => jumpToSection(f.section)} title={"See " + f.label}>
                ✱ {f.label}
              </button>
            )}
            {c && (
              <button className={"chip-s chain" + (chain === c.id ? " on" : "")} onClick={() => setChain(chain === c.id ? "" : c.id)} title="Linked steps: show only these">
                ⛓ {c.label} {c.items.filter((x) => done[x]).length}/{c.items.length}
              </button>
            )}
            <span className="cl-pages">
              {item.pages.map((p) => (
                <button key={p.book + p.page} className={"page-chip" + (chapterPage(item, p) ? " chapter" : "")} onClick={() => openPage(p.book, p.page)} title={chapterPage(item, p) ? "The NPC's quest chapter" : "Guide page"}>
                  {(multiBook ? bookLabel(p.book) + " " : "") + "p. " + p.page}
                  {chapterPage(item, p) ? " ◆" : ""}
                </button>
              ))}
            </span>
            <button className="ask" onClick={() => askItem(item)} title="Ask the guide how to do this and where it is">
              Ask
            </button>
          </div>
        </div>
      </li>
    );
  };

  if (error && !list) return <section className="checklist"><div className="error-box">{error}</div></section>;
  if (!lists) return <section className="checklist muted cl-pad">Loading…</section>;
  if (lists.length === 0) {
    return (
      <section className="checklist cl-pad">
        <p className="muted">No checklists are indexed yet. Run <code>npm run index</code>.</p>
      </section>
    );
  }

  return (
    <section className="checklist" aria-label="Checklist">
      <div className="cl-head">
        <div className="cl-tabs" role="tablist">
          {lists.map((l) => (
            <button key={l.id} role="tab" aria-pressed={l.id === listId} onClick={() => setListId(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        {list && (
          <>
            {list.author && (
              <p className="cl-credit muted">
                Checklist by{" "}
                {list.sourceUrl ? (
                  <a href={list.sourceUrl} target="_blank" rel="noreferrer">
                    {list.author}
                  </a>
                ) : (
                  list.author
                )}{" "}
                (Reddit)
              </p>
            )}
            <div className="cl-progress">
              <div className="bar" aria-hidden="true">
                <span style={{ width: (allItems.length ? (100 * doneCount) / allItems.length : 0) + "%" }} />
              </div>
              <span>
                {doneCount} / {allItems.length} done
              </span>
            </div>
            <div className="cl-controls">
              {user ? (
                <span className="run-picker">
                  <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)} aria-label="Run (character)">
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  <button
                    title="New run (another character or NG+)"
                    onClick={() => {
                      const name = window.prompt("Name of the new run (a character or NG+):", "Tarnished " + (runs.length + 1));
                      if (name?.trim())
                        void runAction(async () => {
                          const r = await createRun(name.trim());
                          setRuns((rs) => [...rs, r]);
                          setRunId(r.id);
                        });
                    }}
                  >
                    +
                  </button>
                  {run && (
                    <button
                      title="Rename this run"
                      onClick={() => {
                        const name = window.prompt("New name:", run.name);
                        if (name?.trim() && name.trim() !== run.name)
                          void runAction(async () => {
                            const r = await renameRun(run.id, name.trim());
                            setRuns((rs) => rs.map((x) => (x.id === r.id ? r : x)));
                          });
                      }}
                    >
                      ✎
                    </button>
                  )}
                  {run && runs.length > 1 && (
                    <button
                      title="Delete this run and its ticks"
                      onClick={() => {
                        if (window.confirm("Delete the run " + run.name + " and all its ticks?"))
                          void runAction(async () => {
                            await deleteRun(run.id);
                            const rest = runs.filter((x) => x.id !== run.id);
                            setRuns(rest);
                            setRunId(rest[0]?.id ?? null);
                          });
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              ) : (
                <span className="cl-login">
                  <button className="primary" onClick={showLogin}>
                    Log in
                  </button>
                  <span className="muted">to tick items and keep your progress</span>
                </span>
              )}
              <label className="cl-check">
                <input
                  type="checkbox"
                  checked={hideDone}
                  onChange={(e) => {
                    setHideDone(e.target.checked);
                    store.set("miriel.checklist.hideDone", e.target.checked ? "1" : "0");
                  }}
                />
                Hide done
              </label>
            </div>
            <div className="cl-filters">
              <input type="search" placeholder="Search steps…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search steps" />
              <select value={npc} onChange={(e) => setNpc(e.target.value)} aria-label="NPC">
                <option value="">All NPCs</option>
                {npcOptions.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
              {list.chains.length > 0 && (
                <select value={chain} onChange={(e) => setChain(e.target.value)} aria-label="Linked steps">
                  <option value="">All steps</option>
                  {list.chains.map((c) => (
                    <option key={c.id} value={c.id}>
                      ⛓ {c.label}
                    </option>
                  ))}
                </select>
              )}
              {filtering && (
                <button
                  onClick={() => {
                    setQuery("");
                    setNpc("");
                    setChain("");
                    setHideDone(false);
                    store.set("miriel.checklist.hideDone", "0");
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="cl-scroll" ref={scrollRef}>
        {!list ? (
          <p className="muted cl-pad">Loading…</p>
        ) : (
          <>
            {sections.map((s) => {
              const slug = s.heading?.section ?? "top";
              const shown = s.items.filter(visible);
              if (filtering && shown.length === 0) return null;
              const isCollapsed = !filtering && collapsed.has(slug);
              const sDone = s.items.filter((i) => done[i.id]).length;
              return (
                <div key={slug} className="cl-section" id={"sec-" + slug}>
                  {s.heading && (
                    <button
                      className="cl-section-head"
                      aria-expanded={!isCollapsed}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (next.has(slug)) next.delete(slug);
                        else next.add(slug);
                        setCollapsedSaved(next);
                      }}
                    >
                      <span className="caret">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="title">{s.heading.title}</span>
                      <span className={"count" + (sDone === s.items.length && s.items.length ? " complete" : "")}>
                        {sDone}/{s.items.length}
                      </span>
                    </button>
                  )}
                  {!isCollapsed && (
                    <ul className="cl-rows">
                      {s.rows.map((r, k) => {
                        if (r.type === "item") return visible(r) ? renderItem(r) : null;
                        if (filtering) return null;
                        if (r.type === "heading") {
                          return (
                            <li key={"h" + k} className={"cl-sub level-" + r.level} id={"sec-" + r.section}>
                              {r.title}
                            </li>
                          );
                        }
                        return (
                          <li key={"n" + k} className="cl-note">
                            {r.text.replace(/\*\*/g, "")}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
            {retiredDone.length > 0 && !filtering && (
              <div className="cl-section">
                <div className="cl-sub">Steps you ticked that are no longer in the list</div>
                <ul className="cl-rows">
                  {retiredDone.map((r) => (
                    <li key={r.id} className="cl-note">
                      {r.text.replace(/\*\*/g, "")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="muted cl-credit cl-foot">
              {list.title}. Page buttons open the guide; ◆ marks the NPC&apos;s quest chapter. Ask sends the step to the
              chat, which answers from those pages.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
