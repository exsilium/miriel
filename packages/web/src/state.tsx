/**
 * App-wide state: the loaded books, the viewer target (which page to show and
 * which quote to highlight) and the search scope. React context only, per the spec.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { isArtBook, spreadFolios, spreadForFolio, type Book } from "./api.js";

export interface ViewerTarget {
  book: string;
  page: number;
  quote: string | null;
  /** Art book: the artwork's box on the spread ([x0, y0, x1, y1] fractions), outlined briefly on arrival. */
  box?: [number, number, number, number] | null;
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
  goTo: (book: string, page: number, quote?: string | null, box?: [number, number, number, number] | null) => void;
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

/**
 * ?book=<id>&page=<printed page>. For an art book the link carries a printed folio (either page of a spread) and
 * the viewer page is the PDF page of that spread.
 */
export function readDeepLink(books: Book[]): { book: Book; page: number } {
  const params = new URLSearchParams(window.location.search);
  const book = books.find((b) => b.id === params.get("book")) ?? books[0]!;
  const raw = Number(params.get("page"));
  if (isArtBook(book)) {
    return { book, page: (Number.isInteger(raw) && spreadForFolio(book, raw)) || 1 };
  }
  const maxPrinted = book.pageCount - book.printedToPdfOffset;
  const page = Number.isInteger(raw) && raw >= 1 && raw <= maxPrinted ? raw : 1;
  return { book, page };
}

export function writeDeepLink(book: Book, page: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("book", book.id);
  if (isArtBook(book)) {
    const folios = spreadFolios(book, page);
    if (folios.length) url.searchParams.set("page", String(folios[0]));
    else url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  window.history.replaceState(null, "", url);
}

export function AppStateProvider({ books, refreshBooks, children }: { books: Book[]; refreshBooks: () => Promise<void>; children: ReactNode }) {
  const initial = readDeepLink(books);
  const [bookId, setBookId] = useState(initial.book.id);
  const [viewerPage, setViewerPageState] = useState(initial.page);
  const [target, setTarget] = useState<ViewerTarget | null>({ book: initial.book.id, page: initial.page, quote: null, nonce: 0 });
  const [scope, setScope] = useState<SearchScope>("all");

  const goTo = useCallback((book: string, page: number, quote: string | null = null, box: [number, number, number, number] | null = null) => {
    setBookId(book);
    setTarget((t) => ({ book, page, quote, box, nonce: (t?.nonce ?? 0) + 1 }));
  }, []);

  const selectBook = useCallback(
    (book: string) => {
      if (book === bookId) return;
      setViewerPageState(1);
      const b = books.find((x) => x.id === book);
      if (b) writeDeepLink(b, 1);
      goTo(book, 1);
    },
    [bookId, books, goTo],
  );

  const setViewerPage = useCallback(
    (page: number) => {
      setViewerPageState(page);
      const b = books.find((x) => x.id === bookId);
      if (b) writeDeepLink(b, page);
    },
    [bookId, books],
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
