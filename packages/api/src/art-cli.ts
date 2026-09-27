#!/usr/bin/env node
/**
 * Art harness:  npm run art -- "what does Malenia look like"
 * Runs retrieval (for the question's anchor entities) and the art matcher, and prints the strip the chat would
 * show, plus the raw text-search hits with their similarity (for tuning ART_MIN_SIMILARITY). No model call.
 * Options: --json
 */
import { parseArgs } from "node:util";
import { createEmbeddingProvider, loadDotEnv } from "@miriel/shared";
import { createPool } from "@miriel/shared/db";
import { artworksByVector } from "./art.js";
import { APPEARANCE_RE, ART_MIN_SIMILARITY, ART_MIN_SIMILARITY_WITH_NAMES, findArt } from "./art-match.js";
import { resolveEntities, RETRIEVE_DEFAULTS } from "./retrieval/index.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean", default: false } } });
const query = positionals.join(" ").trim();
if (!query) {
  process.stderr.write('usage: art [--json] "<question>"\n');
  process.exit(2);
}

loadDotEnv();
const pool = createPool();
const embedder = createEmbeddingProvider();
const embedQuery = async (text: string): Promise<number[]> => (await embedder.embed([text], "query")).embeddings[0]!;
try {
  const anchors = await resolveEntities(pool, query, { bookIds: undefined, trigramThreshold: RETRIEVE_DEFAULTS.trigramThreshold, routeQuestion: false });
  const items = await findArt({ pool, embedQuery }, query, { anchors });
  if (values.json) {
    process.stdout.write(JSON.stringify({ anchors: anchors.entities.map((e) => e.name), items }, null, 2) + "\n");
  } else {
    const out = ["query: " + query + (APPEARANCE_RE.test(query) ? "   [appearance question: text search on]" : ""), ""];
    out.push("subjects: " + (anchors.entities.map((e) => e.name + (e.match === "trigram" ? " (~" + e.similarity.toFixed(2) + ")" : "")).join(", ") || "(none)"));
    out.push("");
    out.push("strip (" + items.length + "):");
    for (const it of items) {
      out.push(
        "  t" + it.tier + " " + it.book + " pp." + it.folios.join("-") + " #" + it.id + "  " + (it.name ?? "(unnamed)") +
          "  [" + it.source + "/" + it.confidence + ", " + it.kind + "]  " + it.description.slice(0, 90),
      );
    }
    const hits = await artworksByVector(pool, await embedQuery(query), undefined, 8);
    out.push("");
    out.push("text search, top 8 (shown only for appearance questions, similarity >= " + ART_MIN_SIMILARITY_WITH_NAMES + " next to name matches, else " + ART_MIN_SIMILARITY + "):");
    for (const h of hits) out.push("  " + h.similarity.toFixed(3) + "  " + h.book + " pp." + h.folios.join("-") + "  " + (h.names.map((n) => n.name).join("; ") || "(unnamed)") + "  — " + h.description.slice(0, 70));
    process.stdout.write(out.join("\n") + "\n");
  }
} finally {
  await pool.end();
}
