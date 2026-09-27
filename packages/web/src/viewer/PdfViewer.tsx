import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document } from "react-pdf";
import { isArtBook, pageLabel, pdfUrl, spreadFolios, spreadForFolio } from "../api.js";
import { useRetakes } from "../retakes/context.js";
import { navigate, retakePagePath } from "../route.js";
import { useAppState } from "../state.js";
import { PageSlot, type BoxHighlight, type Highlight } from "./PageSlot.js";

const RENDER_WINDOW = 2; // pages rendered on each side of the current one
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

/**
 * The scanned PDF is ~250 MB. With auto-fetch and streaming off, pdf.js
 * requests only the byte ranges it needs for the pages being rendered
 * instead of downloading the whole file in the background.
 */
const PDF_OPTIONS = { disableAutoFetch: true, disableStream: true };

export function PdfViewer() {
  const { book, target, viewerPage, setViewerPage, goTo, refreshBooks } = useAppState();
  const { config: retakes } = useRetakes();
  const offset = book.printedToPdfOffset;
  const toPdf = useCallback((printed: number) => printed + offset, [offset]);
  const toPrinted = useCallback((pdfNo: number) => pdfNo - offset, [offset]);
  const maxPrinted = book.pageCount - offset;
  /** Art book: pages are spreads (PDF pages); the page box shows and takes printed folios. */
  const art = isArtBook(book);
  const folioOf = useCallback((pdfNo: number) => spreadFolios(book, pdfNo)[0] ?? null, [book]);
  const lastFolio = art ? (spreadFolios(book, book.pageCount)[1] ?? book.pageCount) : maxPrinted;

  const [numPages, setNumPages] = useState(0);
  const [aspect, setAspect] = useState(1.4); // height / width, from the first rendered page
  const [zoom, setZoom] = useState(1); // 1 = fit width
  const [imageMode, setImageMode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState(toPdf(viewerPage));
  const currentPage = useRef(current);
  currentPage.current = current;
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [boxHighlight, setBoxHighlight] = useState<BoxHighlight | null>(null);
  const [pageInput, setPageInput] = useState(String(viewerPage));

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollerWidth, setScrollerWidth] = useState(800);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setScrollerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setScrollerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.max(200, Math.floor((scrollerWidth - 32) * zoom));
  const pageHeight = Math.round(pageWidth * aspect);

  // Every slot changes height when the real page aspect arrives (after the first page loads), on zoom and on
  // resize; keep the current page in place, or the fixed scroll offset lands on a neighbouring page.
  useLayoutEffect(() => {
    scrollerRef.current?.querySelector<HTMLElement>('[data-page="' + currentPage.current + '"]')?.scrollIntoView({ block: "start" });
  }, [pageHeight]);

  // The URL names the PDF revision: after a retake the viewer loads the new file (never byte ranges of both).
  const file = useMemo(() => pdfUrl(book.id, book.pdfRevision), [book.id, book.pdfRevision]);
  useEffect(() => {
    setNumPages(0);
    setLoadError(null);
  }, [file]);

  // Same book, new revision: reopen at the page being read (the target effect scrolls there once loaded).
  const viewerPageRef = useRef(viewerPage);
  viewerPageRef.current = viewerPage;
  const lastDoc = useRef({ id: book.id, revision: book.pdfRevision });
  useEffect(() => {
    const prev = lastDoc.current;
    lastDoc.current = { id: book.id, revision: book.pdfRevision };
    if (prev.id === book.id && prev.revision !== book.pdfRevision) goTo(book.id, viewerPageRef.current);
  }, [book.id, book.pdfRevision, goTo]);

  // A load error may mean the revision is stale (409): re-read the book list once per file.
  const refreshedFor = useRef<string | null>(null);
  const onLoadError = useCallback(
    (err: Error) => {
      setLoadError(err.message);
      if (refreshedFor.current !== file) {
        refreshedFor.current = file;
        void refreshBooks();
      }
    },
    [file, refreshBooks],
  );

  // Navigation target from citations, chips, deep link, toolbar.
  useEffect(() => {
    if (!target || target.book !== book.id || numPages === 0) return;
    const pdfNo = Math.min(Math.max(toPdf(target.page), 1), numPages);
    setCurrent(pdfNo);
    setHighlight(target.quote ? { quote: target.quote, nonce: target.nonce } : null);
    setBoxHighlight(target.box ? { box: target.box, nonce: target.nonce } : null);
    const slot = scrollerRef.current?.querySelector<HTMLElement>('[data-page="' + pdfNo + '"]');
    slot?.scrollIntoView({ block: "start" });
  }, [target, book.id, numPages, toPdf]);

  // Track the page nearest the middle of the viewport while scrolling.
  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const mid = el.getBoundingClientRect().top + el.clientHeight / 2;
      let best = current;
      let bestDist = Infinity;
      el.querySelectorAll<HTMLElement>("[data-page]").forEach((slot) => {
        const r = slot.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = Number(slot.dataset["page"]);
        }
      });
      if (best !== current) setCurrent(best);
    });
  }, [current]);

  useEffect(() => {
    const printed = toPrinted(current);
    setPageInput(art ? String(folioOf(current) ?? "") : String(printed));
    if (printed !== viewerPage) setViewerPage(printed);
  }, [current, toPrinted, viewerPage, setViewerPage, art, folioOf]);

  const goToPrinted = (printed: number): void => {
    const clamped = Math.min(Math.max(printed, 1 - offset), maxPrinted);
    const pdfNo = toPdf(clamped);
    setCurrent(pdfNo);
    setHighlight(null);
    scrollerRef.current?.querySelector<HTMLElement>('[data-page="' + pdfNo + '"]')?.scrollIntoView({ block: "start" });
  };

  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const zoomBy = (dir: 1 | -1): void => {
    const idx = zoomIndex < 0 ? 3 : zoomIndex;
    const next = ZOOM_STEPS[Math.min(Math.max(idx + dir, 0), ZOOM_STEPS.length - 1)]!;
    setZoom(next);
  };

  const slots = useMemo(() => Array.from({ length: numPages }, (_, i) => i + 1), [numPages]);

  return (
    <section className="viewer" aria-label="Book viewer">
      <div className="toolbar">
        <div className="group">
          <button onClick={() => goToPrinted(toPrinted(current) - 1)} disabled={current <= 1} aria-label="Previous page">
            ‹
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(pageInput);
              if (!Number.isInteger(n)) return;
              if (art) {
                const spread = spreadForFolio(book, n);
                if (spread) goToPrinted(spread);
              } else goToPrinted(n);
            }}
          >
            <input className="page-input" value={pageInput} onChange={(e) => setPageInput(e.target.value)} aria-label="Printed page number" inputMode="numeric" placeholder={art ? "page" : undefined} />
          </form>
          <span className="muted">/ {lastFolio}</span>
          <button onClick={() => goToPrinted(toPrinted(current) + 1)} disabled={current >= numPages} aria-label="Next page">
            ›
          </button>
        </div>
        <div className="group">
          <button onClick={() => zoomBy(-1)} aria-label="Zoom out">
            −
          </button>
          <span className="muted" style={{ minWidth: "3.5em", textAlign: "center" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button onClick={() => zoomBy(1)} aria-label="Zoom in">
            +
          </button>
          <button onClick={() => setZoom(1)} aria-pressed={zoom === 1}>
            Fit width
          </button>
        </div>
        <div className="group">
          {!art && (
            <button onClick={() => setImageMode((v) => !v)} aria-pressed={imageMode} title="Show the original page photo instead of the PDF render">
              Page image
            </button>
          )}
          {retakes && !art && (
            <button onClick={() => navigate(retakePagePath(book.id, toPrinted(current)))} title="Upload a new photo of this page">
              Retake this page
            </button>
          )}
        </div>
        <span className="muted" style={{ marginLeft: "auto" }}>
          {book.label} · {art ? pageLabel(book, current) : "PDF page " + current}
        </span>
      </div>

      <div className="pages" ref={scrollerRef} onScroll={onScroll}>
        <Document
          file={file}
          options={PDF_OPTIONS}
          onLoadSuccess={(doc) => setNumPages(doc.numPages)}
          onLoadError={onLoadError}
          loading={<div className="viewer-status">Loading the PDF…</div>}
          error={<div className="viewer-status">Could not load the PDF{loadError ? ": " + loadError : ""}.</div>}
          externalLinkTarget="_blank"
        >
          {slots.map((pdfNo) => (
            <PageSlot
              key={book.id + ":" + (book.pdfRevision ?? "") + ":" + pdfNo}
              bookId={book.id}
              pdfNo={pdfNo}
              printed={toPrinted(pdfNo)}
              label={art ? pageLabel(book, pdfNo) : undefined}
              rendered={Math.abs(pdfNo - current) <= RENDER_WINDOW}
              isCurrent={pdfNo === current}
              width={pageWidth}
              height={pageHeight}
              imageMode={imageMode && !art}
              highlight={highlight && pdfNo === current ? highlight : null}
              boxHighlight={boxHighlight && pdfNo === current ? boxHighlight : null}
              onAspect={(a) => {
                // every slot shares one height: on an art book the portrait cover must not resize the spreads
                if (art && pdfNo < (book.spread?.pdfPage ?? 1)) return;
                setAspect((prev) => (Math.abs(prev - a) > 0.001 ? a : prev));
              }}
            />
          ))}
        </Document>
      </div>
    </section>
  );
}
