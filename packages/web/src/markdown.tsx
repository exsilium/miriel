/**
 * Tiny Markdown renderer for model answers: headings, paragraphs, bullet and
 * numbered lists, pipe tables, bold, inline code. Citation pills are carried
 * through the text as private-use sentinels so they render inline exactly
 * where the citation event arrived.
 */
import { Fragment, type ReactNode } from "react";

const PILL_OPEN = "";
const PILL_CLOSE = "";

export const pillToken = (index: number): string => PILL_OPEN + index + PILL_CLOSE;

const TOKEN_RE = /(\d+)/g;

export function renderMarkdown(source: string, renderPill: (index: number) => ReactNode): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = (): number => key++;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6); // answers start at h3 visually
      const Tag = ("h" + level) as "h3" | "h4" | "h5" | "h6";
      out.push(<Tag key={nextKey()}>{inline(heading[2]!, renderPill)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(lines[i++]!);
      out.push(table(rows, renderPill, nextKey()));
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[2]!);
          i++;
        } else if (lines[i]!.trim() !== "" && /^\s+/.test(lines[i]!) && items.length) {
          items[items.length - 1] += " " + lines[i]!.trim();
          i++;
        } else break;
      }
      const ListTag = ordered ? "ol" : "ul";
      out.push(
        <ListTag key={nextKey()}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, renderPill)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,6}\s|\s*\||\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    out.push(<p key={nextKey()}>{inline(para.join(" "), renderPill)}</p>);
  }
  return out;
}

function table(rows: string[], renderPill: (i: number) => ReactNode, key: number): ReactNode {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
  const [head, ...rest] = body;
  return (
    <table key={key}>
      {head && (
        <thead>
          <tr>
            {cells(head).map((c, n) => (
              <th key={n}>{inline(c, renderPill)}</th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rest.map((r, n) => (
          <tr key={n}>
            {cells(r).map((c, m) => (
              <td key={m}>{inline(c, renderPill)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Bold, inline code, and pill tokens. */
export function inline(text: string, renderPill: (i: number) => ReactNode): ReactNode {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\d+)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else {
      TOKEN_RE.lastIndex = 0;
      const idx = Number(TOKEN_RE.exec(tok)?.[1]);
      parts.push(<Fragment key={k++}>{renderPill(idx)}</Fragment>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
