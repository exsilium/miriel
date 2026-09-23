import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchEntities, type TypeaheadHit } from "../api.js";

import type { SearchScope } from "../state.js";

interface Props {
  disabled: boolean;
  /** Restrict the typeahead to this book; undefined = every indexed book. */
  bookId: string | undefined;
  /** Search-scope toggle ("this book | all books"); null hides it (single-book install). */
  scope: { value: SearchScope; bookLabel: string; onChange: (s: SearchScope) => void } | null;
  onSend: (text: string) => void;
  onStop: (() => void) | null;
}

/** The trailing 1-3 words the user is typing, used as the typeahead query. */
export function trailingWords(text: string): { query: string; start: number } | null {
  const m = /(?:^|[\s,.;:!?()"])((?:[\p{L}\p{N}'’\-]+\s+){0,2}[\p{L}\p{N}'’\-]+)$/u.exec(text);
  if (!m || m[1]!.length < 2) return null;
  return { query: m[1]!, start: text.length - m[1]!.length };
}

export function Composer({ disabled, bookId, scope, onSend, onStop }: Props) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<TypeaheadHit[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // debounced entity lookup on the trailing words
  useEffect(() => {
    const tw = trailingWords(text);
    if (!tw) {
      setHits([]);
      setOpen(false);
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetchEntities(tw.query, bookId, controller.signal)
        .then((h) => {
          const filtered = h.filter((x) => x.name.toLowerCase() !== tw.query.toLowerCase());
          setHits(filtered);
          setOpen(filtered.length > 0);
          setActive(filtered.length ? 0 : -1);
        })
        .catch(() => undefined);
    }, 150);
    return () => clearTimeout(timer);
  }, [text, bookId]);

  const accept = useCallback(
    (hit: TypeaheadHit) => {
      const tw = trailingWords(text);
      const next = (tw ? text.slice(0, tw.start) : text) + hit.name + " ";
      setText(next);
      setOpen(false);
      setHits([]);
      areaRef.current?.focus();
    },
    [text],
  );

  const submit = useCallback(() => {
    const q = text.trim();
    if (!q || disabled) return;
    onSend(q);
    setText("");
    setOpen(false);
    setHits([]);
  }, [text, disabled, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && hits.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % hits.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + hits.length) % hits.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && active >= 0 && !e.shiftKey)) {
        const hit = hits[active];
        if (hit) {
          e.preventDefault();
          accept(hit);
          return;
        }
      }
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // grow the textarea with its content
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  return (
    <div className="composer">
      {open && hits.length > 0 && (
        <ul className="suggestions" role="listbox">
          {hits.map((h, i) => (
            <li key={h.book + h.nameNorm} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => accept(h)}>
              <span>{h.name}</span>
              <span className="s-type">{h.types.join("/")}</span>
              <span className="s-pages">p. {h.pages.slice(0, 4).join(", ")}{h.pages.length > 4 ? "…" : ""}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={areaRef}
          rows={1}
          value={text}
          placeholder="Ask about the guide… (Enter to send, Shift+Enter for a new line, Tab to accept a suggestion)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 100)}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {onStop ? (
          <button type="button" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={disabled || !text.trim()}>
            Ask
          </button>
        )}
      </form>
      {scope && (
        <div className="scope-toggle" role="radiogroup" aria-label="Search scope">
          <span className="muted">Search:</span>
          <button type="button" role="radio" aria-checked={scope.value === "book"} onClick={() => scope.onChange("book")}>
            this book ({scope.bookLabel})
          </button>
          <button type="button" role="radio" aria-checked={scope.value === "all"} onClick={() => scope.onChange("all")}>
            all books
          </button>
        </div>
      )}
    </div>
  );
}
