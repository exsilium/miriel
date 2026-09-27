import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBooks, fetchImageVersions, type Book } from "./api.js";
import { AdminUsers } from "./auth/AdminUsers.js";
import { ChecklistPane, pathKeepingBook } from "./checklist/ChecklistPane.js";
import { useAuth } from "./auth/context.js";
import { UserMenu } from "./auth/UserMenu.js";
import { ChatPane } from "./chat/ChatPane.js";
import { BatchUpload } from "./retakes/BatchUpload.js";
import { canApprove } from "./retakes/client.js";
import { openCount, RetakeProvider, useRetakes } from "./retakes/context.js";
import { PageRetake } from "./retakes/PageRetake.js";
import { RetakesView } from "./retakes/RetakesView.js";
import { navigate, useRoute } from "./route.js";
import { AppStateProvider, useAppState } from "./state.js";
import { setBookVersions } from "./versions.js";
import { PdfViewer } from "./viewer/PdfViewer.js";

/** How often the book list (and so each PDF revision) is re-read; also on tab focus. */
const BOOKS_POLL_MS = 60_000;

const sameBooks = (a: Book[] | null, b: Book[]): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

export function App() {
  // a login or logout can change what the api lets this browser read (AUTH_REQUIRED): read the books again
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    fetchBooks()
      .then(setBooks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [attempt, user?.id]);

  // A retake changes a book's pdfRevision: re-read the list now and then, keeping the old array when nothing changed.
  const refreshBooks = useCallback(async () => {
    try {
      const next = await fetchBooks();
      setBooks((prev) => (sameBooks(prev, next) ? prev : next));
    } catch {
      /* keep what we have; the next poll retries */
    }
  }, []);
  const loaded = books !== null;
  useEffect(() => {
    if (!loaded) return;
    const timer = setInterval(() => void refreshBooks(), BOOKS_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refreshBooks();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loaded, refreshBooks]);

  // Photo versions per book, re-read whenever its PDF revision changes (the two change together on a retake).
  const versionsOf = useRef(new Map<string, string | null>());
  useEffect(() => {
    for (const b of books ?? []) {
      if (versionsOf.current.has(b.id) && versionsOf.current.get(b.id) === b.pdfRevision) continue;
      versionsOf.current.set(b.id, b.pdfRevision);
      fetchImageVersions(b.id)
        .then((r) => setBookVersions(b.id, r.pages))
        .catch(() => versionsOf.current.delete(b.id));
    }
  }, [books]);

  if (error) {
    return (
      <div className="centered">
        <div>
          <p>Could not reach the Miriel API.</p>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      </div>
    );
  }
  if (!books) return <div className="centered">Loading…</div>;
  if (books.length === 0) {
    return (
      <div className="centered">
        <p>
          No books are indexed yet. Run <code>docker compose --profile index run indexer</code> and reload.
        </p>
      </div>
    );
  }
  return (
    <AppStateProvider books={books} refreshBooks={refreshBooks}>
      <RetakeProvider>
        <Layout />
      </RetakeProvider>
    </AppStateProvider>
  );
}

function Layout() {
  const { books, book, selectBook } = useAppState();
  const { config } = useRetakes();
  const route = useRoute();
  const [pane, setPane] = useState<"chat" | "book">("chat");
  const admin = route.name === "admin-users";
  const checklist = route.name === "checklist";
  const reader = !admin && (route.name === "reader" || checklist || !config); // retake views exist only when the api has retakes on
  // the checklist stays mounted once opened, so going to the chat and back keeps its scroll and filters
  const [checklistOpened, setChecklistOpened] = useState(checklist);
  useEffect(() => {
    if (checklist) setChecklistOpened(true);
  }, [checklist]);
  const open = openCount(config);
  const toApprove = canApprove(config) ? config?.awaitingApproval ?? 0 : 0;
  return (
    <div className="app" data-pane={pane} data-view={admin ? "admin" : reader ? "reader" : "retakes"} data-left={checklist ? "checklist" : "chat"}>
      <header className="topbar">
        <h1>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/?book=" + encodeURIComponent(book.id));
            }}
          >
            Miriel
          </a>
        </h1>
        {books.length > 1 ? (
          <select className="book-select" value={book.id} onChange={(e) => selectBook(e.target.value)} aria-label="Book" title={book.title}>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
        ) : (
          <span className="book-title" title={book.title}>
            {book.title}
          </span>
        )}
        <span className="spacer" />
        {reader && (
          <a
            className={"retakes-link" + (checklist ? " active" : "")}
            href="/checklist"
            onClick={(e) => {
              e.preventDefault();
              navigate(pathKeepingBook(checklist ? "/" : "/checklist"));
              setPane("chat");
            }}
            title={checklist ? "Back to the chat" : "Quest checklist: NPC steps in play order"}
          >
            {checklist ? "Chat" : "Checklist"}
          </a>
        )}
        {config && (
          <a
            className={"retakes-link" + (reader ? "" : " active")}
            href="/retakes"
            onClick={(e) => {
              e.preventDefault();
              navigate(reader ? "/retakes" : "/?book=" + encodeURIComponent(book.id));
            }}
            title={reader ? open + " page(s) need a new photo" + (toApprove ? ", " + toApprove + " photo(s) wait for your approval" : "") : "Back to the reader"}
          >
            {reader ? "Retakes" : "Reader"}
            {reader && open > 0 && <span className="count">{open}</span>}
            {reader && toApprove > 0 && <span className="count approve">✓ {toApprove}</span>}
          </a>
        )}
        {admin && !config && (
          <a
            className="retakes-link active"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/?book=" + encodeURIComponent(book.id));
            }}
          >
            Reader
          </a>
        )}
        <UserMenu />
        <div className="pane-toggle" role="tablist">
          <button role="tab" aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>
            {checklist ? "List" : "Chat"}
          </button>
          <button role="tab" aria-pressed={pane === "book"} onClick={() => setPane("book")}>
            Book
          </button>
        </div>
      </header>
      {admin ? (
        <main className="retakes-main">
          <AdminUsers />
        </main>
      ) : reader ? (
        <div className="panes">
          <ChatPane onShowBook={() => setPane("book")} />
          {checklistOpened && <ChecklistPane onShowBook={() => setPane("book")} />}
          <PdfViewer />
        </div>
      ) : (
        <main className="retakes-main">
          {route.name === "retake-page" ? (
            <PageRetake key={route.book + ":" + route.page} book={route.book} page={route.page} />
          ) : route.name === "retake-batch" ? (
            <BatchUpload book={route.book} />
          ) : (
            <RetakesView />
          )}
        </main>
      )}
    </div>
  );
}
