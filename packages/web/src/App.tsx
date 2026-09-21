import { useEffect, useState } from "react";
import { fetchBooks, type Book } from "./api.js";
import { ChatPane } from "./chat/ChatPane.js";
import { AppStateProvider, useAppState } from "./state.js";
import { PdfViewer } from "./viewer/PdfViewer.js";

export function App() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    fetchBooks()
      .then(setBooks)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [attempt]);

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
    <AppStateProvider books={books}>
      <Layout />
    </AppStateProvider>
  );
}

function Layout() {
  const { book } = useAppState();
  const [pane, setPane] = useState<"chat" | "book">("chat");
  return (
    <div className="app" data-pane={pane}>
      <header className="topbar">
        <h1>Miriel</h1>
        <span className="book-title" title={book.title}>
          {book.title}
        </span>
        <span className="spacer" />
        <div className="pane-toggle" role="tablist">
          <button role="tab" aria-pressed={pane === "chat"} onClick={() => setPane("chat")}>
            Chat
          </button>
          <button role="tab" aria-pressed={pane === "book"} onClick={() => setPane("book")}>
            Book
          </button>
        </div>
      </header>
      <div className="panes">
        <ChatPane onShowBook={() => setPane("book")} />
        <PdfViewer />
      </div>
    </div>
  );
}
