#!/usr/bin/env node
/**
 * Retrieval harness:  npm run retrieve -- "how do I get the Meteorite Staff from Lenne's Rise"
 * Options: --book vol1  --rerank  --json  --k 12  --prior "meteorite staff,lennes rise"  --full
 */
import { parseArgs } from "node:util";
import { createEmbeddingProvider, createRerankProvider, envFlag, loadDotEnv } from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { retrieve, type RetrievalResult } from "./retrieval/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    book: { type: "string", multiple: true },
    rerank: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    k: { type: "string" },
    prior: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const query = positionals.join(" ").trim();
if (values.help || !query) {
  process.stderr.write('usage: retrieve [--book vol1] [--rerank] [--json] [--full] [--k 12] [--prior "norm,norm"] "<query>"\n');
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const pool = createPool();
const rerank = values.rerank || envFlag("RERANK_ENABLED", false);
try {
  const result = await retrieve(
    { pool, embedder: createEmbeddingProvider(), reranker: rerank ? createRerankProvider() : undefined },
    query,
    {
      bookIds: values.book,
      rerank,
      topK: values.k ? Number(values.k) : undefined,
      priorEntities: values.prior ? values.prior.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    },
  );
  process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : format(result, values.full) + "\n");
} finally {
  await pool.end();
}

function format(r: RetrievalResult, full: boolean): string {
  const out: string[] = [];
  out.push("query: " + r.query + (r.routeQuestion ? "   [route question]" : ""));
  out.push("");
  out.push("anchors (" + r.anchors.entities.length + " entities, " + r.anchors.pages.length + " pages):");
  for (const e of r.anchors.entities) {
    out.push(
      "  " + e.name + "  [" + e.types.join(",") + "]  " + e.match +
        (e.match === "trigram" ? " " + e.similarity.toFixed(2) : "") +
        '  via "' + e.matchedText + '"  pages ' + e.pages.map((p) => p.page).join(","),
    );
  }
  if (r.anchors.pages.length) out.push("  anchor pages: " + r.anchors.pages.map((p) => p.book + ":" + p.page).join(" "));
  out.push("");
  out.push("chunks (top " + r.chunks.length + "; vector hits " + r.stats.vectorHits + ", lexical hits " + r.stats.lexicalHits + (r.stats.reranked ? ", reranked" : "") + "):");
  r.chunks.forEach((c, i) => {
    const ranks = Object.entries(c.ranks).map(([k, v]) => k.charAt(0) + v).join(" ");
    out.push(
      "  " + String(i + 1).padStart(2) + ". " + c.score.toFixed(4) + "  p." + c.page + " #" + c.chunk_idx + "  " +
        c.why.join("+").padEnd(21) + " " + ranks.padEnd(10) + " " + c.heading_path,
    );
    const preview = full ? c.text : c.text.replace(/\s+/g, " ").slice(0, 160) + (c.text.length > 160 ? " …" : "");
    out.push("      " + preview.split("\n").join("\n      "));
  });
  if (r.pages.length) {
    out.push("");
    out.push("route pages (" + r.pages.length + ", " + r.pages.reduce((n, p) => n + p.tokens, 0) + " tokens):");
    for (const p of r.pages) out.push("  p." + p.page + "  " + p.tokens + " tok  " + (p.region ?? p.chapter ?? ""));
  }
  out.push("");
  out.push("timings ms: " + Object.entries(r.stats.timingsMs).map(([k, v]) => k + "=" + v).join(" ") + "   embedding tokens: " + r.stats.embeddingTokens + (r.stats.reranked ? "   rerank tokens: " + r.stats.rerankTokens : ""));
  return out.join("\n");
}
