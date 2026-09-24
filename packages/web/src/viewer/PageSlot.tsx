import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "react-pdf";
import { pageImageUrl } from "../api.js";
import { useImageVersions } from "../versions.js";
import { findQuote, markItem, type ItemRange } from "./highlight.js";

export interface Highlight {
  quote: string;
  nonce: number;
}

interface Props {
  bookId: string;
  pdfNo: number;
  printed: number;
  rendered: boolean;
  isCurrent: boolean;
  width: number;
  height: number;
  imageMode: boolean;
  highlight: Highlight | null;
  onAspect: (heightOverWidth: number) => void;
}

/**
 * One page position in the scroll column. Always occupies its full height so
 * scrolling and page tracking work; renders pdf.js (or the page photo) only
 * when within the render window.
 */
export const PageSlot = memo(function PageSlot({ bookId, pdfNo, printed, rendered, isCurrent, width, height, imageMode, highlight, onAspect }: Props) {
  const [items, setItems] = useState<string[] | null>(null);
  const [flash, setFlash] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useImageVersions(); // the photo URL carries the page's version

  const ranges = useMemo<Map<number, ItemRange> | null>(() => {
    if (!highlight || !items || imageMode) return null;
    const found = findQuote(items, highlight.quote);
    return found ? new Map(found.map((r) => [r.item, r])) : null;
  }, [highlight, items, imageMode]);

  // Flash the border when a quote could not be located (or cannot be, in photo mode).
  useEffect(() => {
    if (!highlight) {
      setNoMatch(false);
      return;
    }
    if (imageMode || (items && !ranges)) {
      setFlash(true);
      setNoMatch(true);
      const t = setTimeout(() => setFlash(false), 1300);
      return () => clearTimeout(t);
    }
    setNoMatch(false);
    return;
  }, [highlight, imageMode, items, ranges]);

  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => markItem(str, ranges?.get(itemIndex)),
    [ranges],
  );

  // Once the highlighted text layer is in the DOM, bring the first mark into view.
  const onTextLayerRendered = useCallback(() => {
    if (!ranges) return;
    const mark = rootRef.current?.querySelector("mark");
    mark?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [ranges]);

  useEffect(() => {
    if (!rendered) setItems(null);
  }, [rendered]);

  return (
    <div
      ref={rootRef}
      className={"page-slot" + (isCurrent ? " current" : "") + (flash ? " flash" : "")}
      data-page={pdfNo}
      style={{ width, height }}
      aria-label={"Printed page " + printed}
    >
      {!rendered ? (
        <div className="page-placeholder">{printed}</div>
      ) : imageMode ? (
        <img className="page-image" src={pageImageUrl(bookId, printed)} alt={"Page " + printed} width={width} height={height} />
      ) : (
        <Page
          pageNumber={pdfNo}
          width={width}
          renderAnnotationLayer={false}
          renderTextLayer
          loading={<div className="page-placeholder">{printed}</div>}
          onLoadSuccess={(page) => onAspect(page.originalHeight / page.originalWidth)}
          onGetTextSuccess={(tc) => setItems(tc.items.map((it) => ("str" in it ? it.str : "")))}
          onRenderTextLayerSuccess={onTextLayerRendered}
          {...(ranges ? { customTextRenderer } : {})}
        />
      )}
      {noMatch && highlight && <div className="no-match">Quote not found on this page</div>}
    </div>
  );
});
