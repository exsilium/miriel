/**
 * App-wide state: the loaded books, the viewer target (which page to show and
 * which quote to highlight) and the search scope. React context only, per the spec.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Book } from "./api.js";

export interface ViewerTarget {
  book: string;
  page: number;
  quote: string | null;
  /** Changes on every goTo so repeated clicks on the same page still trigger a scroll/highlight. */
  nonce: number;
}

/** "all": retrieval spans every indexed book (default). "book": only the book open in the viewer. */
export type SearchScope = "all" | "book";

interface AppState {
  books: Book[];
  /** The book open in the viewer. */
  book: Book;
  target: ViewerTarget | null;
  goTo: (book: string, page: number, quote?: string | null) => void;
  /** Book selector: open another book at its first printed page. */
  selectBook: (book: string) => void;
  scope: SearchScope;
  setScope: (scope: SearchScope) => void;
  /** Current page as seen in the viewer (for URL and toolbar). */
  viewerPage: number;
  setViewerPage: (page: number) => void;
  /** Re-read the book list now (e.g. the PDF failed to load because a retake replaced it). */
  refreshBooks: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function readDeepLink(books: Book[]): { book: Book; page: number } {
  const params = new URLSearchParams(window.location.search);
  const book = books.find((b) => b.id === params.get("book")) ?? books[0]!;
  const raw = Number(params.get("page"));
  const maxPrinted = book.pageCount - book.printedToPdfOffset;
  const page = Number.isInteger(raw) && raw >= 1 && raw <= maxPrinted ? raw : 1;
  return { book, page };
}

export function writeDeepLink(book: string, page: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("book", book);
  url.searchParams.set("page", String(page));
  window.history.replaceState(null, "", url);
}

export function AppStateProvider({ books, refreshBooks, children }: { books: Book[]; refreshBooks: () => Promise<void>; children: ReactNode }) {
  const initial = readDeepLink(books);
  const [bookId, setBookId] = useState(initial.book.id);
  const [viewerPage, setViewerPageState] = useState(initial.page);
  const [target, setTarget] = useState<ViewerTarget | null>({ book: initial.book.id, page: initial.page, quote: null, nonce: 0 });
  const [scope, setScope] = useState<SearchScope>("all");

  const goTo = useCallback((book: string, page: number, quote: string | null = null) => {
    setBookId(book);
    setTarget((t) => ({ book, page, quote, nonce: (t?.nonce ?? 0) + 1 }));
  }, []);

  const selectBook = useCallback(
    (book: string) => {
      if (book === bookId) return;
      setViewerPageState(1);
      writeDeepLink(book, 1);
      goTo(book, 1);
    },
    [bookId, goTo],
  );

  const setViewerPage = useCallback(
    (page: number) => {
      setViewerPageState(page);
      writeDeepLink(bookId, page);
    },
    [bookId],
  );

  const value = useMemo<AppState>(() => {
    const book = books.find((b) => b.id === bookId) ?? books[0]!;
    return { books, book, target, goTo, selectBook, scope, setScope, viewerPage, setViewerPage, refreshBooks };
  }, [books, bookId, target, goTo, selectBook, scope, viewerPage, setViewerPage, refreshBooks]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAppState outside provider");
  return v;
}
