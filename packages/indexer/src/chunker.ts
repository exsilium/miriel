/**
 * Page chunker. Never crosses a page boundary (it only ever sees one page).
 *
 *  1. Split the markdown on headings into sections; the heading stack becomes
 *     the chunk's heading_path (root = page region, else chapter).
 *  2. Inside a section, pack blocks (paragraphs, tables, lists, sidebars)
 *     greedily to ~targetTokens. A section that fits under maxTokens as a
 *     whole is kept whole rather than split at the target.
 *  3. A single block larger than maxTokens is split: tables by rows with the
 *     header rows repeated, sidebars by lines with the bold title repeated,
 *     lists by items, prose by sentences.
 *  4. Figures become their own chunks (description, labels, legend) under
 *     "<root> > Figure n".
 *
 * Chunk text is stored raw; `embeddingInput()` prepends the heading path for
 * the embedding call only.
 */
import { countTokens, type ExtractedPage, type Figure } from "@miriel/shared";

export interface ChunkOptions {
  /** Pack blocks up to about this many tokens. */
  targetTokens: number;
  /** Never exceed this (except for a single unsplittable run of text). */
  maxTokens: number;
  /** A trailing chunk smaller than this is merged into its predecessor if that stays under max. */
  minTailTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 500,
  maxTokens: 800,
  minTailTokens: 80,
};

export interface Chunk {
  text: string;
  headingPath: string;
  tokenCount: number;
}

export const PATH_SEP = " > ";

/** Root of the heading path: the in-game region, else the running chapter header. */
export function headingRoot(page: Pick<ExtractedPage, "region" | "chapter">): string[] {
  const root = (page.region ?? page.chapter ?? "").trim();
  return root ? [root] : [];
}

/** Text handed to the embedding model: heading path, blank line, chunk text. */
export function embeddingInput(chunk: Chunk): string {
  return chunk.headingPath + "\n\n" + chunk.text;
}

export function chunkPage(page: ExtractedPage, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const root = headingRoot(page);
  return [
    ...chunkMarkdown(page.markdown, root, opts, "Page " + page.page),
    ...chunkFigures(page.figures, root, opts),
  ];
}

// ------------------------------------------------------------------ blocks

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "table"; header: string[]; rows: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "para"; lines: string[] };

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_RE = /^\s*\|/;
const TABLE_SEP_RE = /^\s*\|?(\s*:?-{2,}:?\s*\|)*\s*:?-{2,}:?\s*\|?\s*$/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FENCE_RE = /^\s*(```|~~~)/;

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = (): void => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (const line of lines) {
    if (cur?.kind === "code") {
      cur.lines.push(line);
      if (FENCE_RE.test(line)) flush();
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1]!.length, text: h[2]! });
      continue;
    }
    if (FENCE_RE.test(line)) {
      flush();
      cur = { kind: "code", lines: [line] };
      continue;
    }
    if (TABLE_RE.test(line)) {
      if (cur?.kind !== "table") {
        flush();
        cur = { kind: "table", header: [], rows: [] };
      }
      const t = cur as Extract<Block, { kind: "table" }>;
      if (t.header.length === 0 && t.rows.length === 1 && TABLE_SEP_RE.test(line)) {
        t.header = [t.rows[0]!, line];
        t.rows = [];
      } else {
        t.rows.push(line);
      }
      continue;
    }
    if (QUOTE_RE.test(line)) {
      if (cur?.kind !== "quote") {
        flush();
        cur = { kind: "quote", lines: [] };
      }
      (cur as Extract<Block, { kind: "quote" }>).lines.push(line);
      continue;
    }
    if (LIST_RE.test(line)) {
      if (cur?.kind !== "list") {
        flush();
        cur = { kind: "list", items: [] };
      }
      (cur as Extract<Block, { kind: "list" }>).items.push(line);
      continue;
    }
    if (cur?.kind === "list" && /^\s+\S/.test(line)) {
      // indented continuation of the previous list item
      const l = cur as Extract<Block, { kind: "list" }>;
      l.items[l.items.length - 1] += "\n" + line;
      continue;
    }
    if (cur?.kind !== "para") {
      flush();
      cur = { kind: "para", lines: [] };
    }
    (cur as Extract<Block, { kind: "para" }>).lines.push(line);
  }
  flush();
  return blocks;
}

export function renderBlock(b: Block): string {
  switch (b.kind) {
    case "heading":
      return "#".repeat(b.level) + " " + b.text;
    case "table":
      return [...b.header, ...b.rows].join("\n");
    case "quote":
    case "code":
    case "para":
      return b.lines.join("\n");
    case "list":
      return b.items.join("\n");
  }
}

// ------------------------------------------------------------------ packing

/**
 * Greedy packer. `prefix` (table header rows, sidebar title, "Legend: ") is
 * repeated at the start of every part and counted toward its size.
 * Pieces are joined with `sep`. Packs to targetTokens, but if the remaining
 * pieces all fit under maxTokens together with the current part, finishes
 * them in one part instead of leaving a fragment.
 */
export function packPieces(pieces: string[], sep: string, prefix: string | null, opts: ChunkOptions): string[] {
  const clean = pieces.filter((p) => p.trim() !== "");
  if (clean.length === 0) return [];
  const prefixTok = prefix ? countTokens(prefix) : 0;
  const sizes = clean.map((p) => countTokens(p));
  const suffixSum: number[] = new Array<number>(clean.length + 1).fill(0);
  for (let i = clean.length - 1; i >= 0; i--) suffixSum[i] = suffixSum[i + 1]! + sizes[i]!;

  const out: string[] = [];
  let cur: string[] = [];
  let curTok = prefixTok;
  const flush = (): void => {
    if (cur.length) out.push((prefix ?? "") + cur.join(sep));
    cur = [];
    curTok = prefixTok;
  };

  for (let i = 0; i < clean.length; i++) {
    const t = sizes[i]!;
    if (cur.length && curTok + t > opts.targetTokens) {
      const finishesUnderMax = curTok + suffixSum[i]! <= opts.maxTokens;
      if (!finishesUnderMax) flush();
    }
    cur.push(clean[i]!);
    curTok += t;
  }
  flush();
  return out;
}

function splitProse(text: string, opts: ChunkOptions): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const pieces = sentences.flatMap((s) =>
    countTokens(s) > opts.maxTokens ? packPieces(s.split(/\s+/), " ", null, opts) : [s],
  );
  return packPieces(pieces, " ", null, opts);
}

/** Split one over-size block into parts that each fit under maxTokens (or as close as its structure allows). */
export function splitBlock(b: Block, opts: ChunkOptions): string[] {
  switch (b.kind) {
    case "heading":
      return [renderBlock(b)];
    case "table": {
      const prefix = b.header.length ? b.header.join("\n") + "\n" : null;
      return packPieces(b.rows, "\n", prefix, opts);
    }
    case "quote": {
      const [first, ...rest] = b.lines;
      const hasTitle = first !== undefined && /^\s*>\s*\*\*/.test(first) && rest.length > 0;
      return hasTitle ? packPieces(rest, "\n", first + "\n", opts) : packPieces(b.lines, "\n", null, opts);
    }
    case "list": {
      const items = b.items.flatMap((it) => (countTokens(it) > opts.maxTokens ? splitProse(it, opts) : [it]));
      return packPieces(items, "\n", null, opts);
    }
    case "code":
      return packPieces(b.lines, "\n", null, opts);
    case "para":
      return splitProse(b.lines.join("\n"), opts);
  }
}

function mergeSmallTail(parts: string[], sep: string, opts: ChunkOptions): string[] {
  if (parts.length < 2) return parts;
  const last = parts[parts.length - 1]!;
  const prev = parts[parts.length - 2]!;
  if (countTokens(last) >= opts.minTailTokens) return parts;
  const merged = prev + sep + last;
  if (countTokens(merged) > opts.maxTokens) return parts;
  return [...parts.slice(0, -2), merged];
}

// ------------------------------------------------------------------ markdown

export function chunkMarkdown(
  markdown: string,
  root: string[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  fallbackPath = "Page",
): Chunk[] {
  const blocks = parseBlocks(markdown);
  const chunks: Chunk[] = [];
  const stack: { level: number; text: string }[] = [];
  let pending: Block[] = [];

  const pathOf = (): string => {
    const segs = [...root, ...stack.map((s) => s.text)];
    return segs.length ? segs.join(PATH_SEP) : fallbackPath;
  };

  const flushSection = (): void => {
    if (pending.length === 0) return;
    const headingPath = pathOf();
    const pieces = pending.flatMap((b) => {
      const text = renderBlock(b);
      return countTokens(text) > opts.maxTokens ? splitBlock(b, opts) : [text];
    });
    const parts = mergeSmallTail(packPieces(pieces, "\n\n", null, opts), "\n\n", opts);
    for (const text of parts) chunks.push({ text, headingPath, tokenCount: countTokens(text) });
    pending = [];
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      const before = pathOf();
      const nextStack = stack.filter((s) => s.level < b.level);
      nextStack.push({ level: b.level, text: b.text });
      const after = [...root, ...nextStack.map((s) => s.text)].join(PATH_SEP);
      // A repeated heading (e.g. "## Items" once per printed column of one
      // table) is the same section; only flush when the path really changes.
      if (after !== before) flushSection();
      stack.splice(0, stack.length, ...nextStack);
    } else {
      pending.push(b);
    }
  }
  flushSection();
  return chunks;
}

// ------------------------------------------------------------------ figures

function splitLegend(legend: string, opts: ChunkOptions): string[] {
  // "1 = Site of Grace, 2 = Meteorite Staff, ..." -> split before each "N =" so
  // names that contain commas stay intact.
  const entries = legend.split(/,\s*(?=[A-Za-z0-9]{1,4}\s*=)/);
  if (entries.length >= 2) return packPieces(entries, ", ", "Legend: ", opts);
  return packPieces(splitProse(legend, opts), " ", "Legend: ", opts);
}

export function chunkFigures(figures: Figure[], root: string[], opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const out: Chunk[] = [];
  figures.forEach((f, i) => {
    const headingPath = [...root, "Figure " + (i + 1)].join(PATH_SEP);
    const pieces: string[] = [];

    const desc = f.description.trim();
    if (desc) pieces.push(desc);

    if (f.labels.length) {
      const labels = "Labels: " + f.labels.join("; ");
      pieces.push(...(countTokens(labels) > opts.maxTokens ? packPieces(f.labels, "; ", "Labels: ", opts) : [labels]));
    }

    const legend = f.legend?.trim();
    if (legend) {
      const text = "Legend: " + legend;
      pieces.push(...(countTokens(text) > opts.maxTokens ? splitLegend(legend, opts) : [text]));
    }

    for (const text of packPieces(pieces, "\n\n", null, opts)) {
      out.push({ text, headingPath, tokenCount: countTokens(text) });
    }
  });
  return out;
}
