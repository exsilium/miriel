import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "@miriel/shared/db";
import type { AnswerEvent, AnswerInput } from "./answer/index.js";
import type { RetrievalResult } from "./retrieval/types.js";
import { consultedPages } from "./routes/chat.js";
import { buildServer, type ServerDeps } from "./server.js";
import { encodeSse } from "./sse.js";

// ---------------------------------------------------------------- fakes

const BOOK = {
  id: "vol1",
  title: "Elden Ring Vol 1 - The Lands Between",
  label: "Vol 1",
  page_count: 513,
  printed_to_pdf_offset: 1,
  pdf_path: "vol1.pdf",
  image_dir: "vol1-images",
  image_pattern: "page - {n}.jpg",
};

const PHOTO_SHA = "abcdef0123456789".repeat(4);
const PHOTO_V = PHOTO_SHA.slice(0, 12);
const PDF_BYTES = Buffer.from("%PDF-1.4\n" + "x".repeat(2000));
const PDF_V = createHash("sha256").update(PDF_BYTES).digest("hex").slice(0, 12);

/** A Pool whose query() answers by matching SQL fragments. */
function fakePool(healthy = true): Pool {
  return {
    async query(text: string, params?: unknown[]) {
      if (text.includes("image_sha256")) {
        if (text.includes("unnest")) return { rows: [{ book_id: "vol1", page: 159, image_sha256: PHOTO_SHA }] };
        if (text.includes("AND page = $2")) return { rows: params?.[1] === 159 ? [{ image_sha256: PHOTO_SHA }] : [] };
        return { rows: [{ page: 159, image_sha256: PHOTO_SHA }] };
      }
      if (text.includes("SELECT 1")) {
        if (!healthy) throw new Error("connect ECONNREFUSED");
        return { rows: [{ "?column?": 1 }] };
      }
      if (text.includes("FROM books WHERE id")) return { rows: params?.[0] === "vol1" ? [BOOK] : [] };
      if (text.includes("FROM books")) return { rows: [BOOK] };
      if (text.includes("FROM pages WHERE")) {
        return { rows: params?.[1] === 159 ? [{ chapter: "C", region: "Altus Plateau", page_type: "walkthrough", markdown: "# md", quality: { image_quality: "usable" } }] : [] };
      }
      if (text.includes("FROM figures")) return { rows: [{ figure_idx: 1, kind: "screenshot", description: "d", labels: [], legend: null }] };
      if (text.includes("FROM entities e")) return { rows: [{ name: "Giant Rat Ashes", name_norm: "giant rat ashes", types: ["consumable"], book_id: "vol1", pages: [159], score: 1 }] };
      if (text.includes("FROM entities")) return { rows: [] };
      if (text.includes("FROM chunks")) return { rows: [] };
      throw new Error("fakePool: unexpected query " + text.slice(0, 60));
    },
  } as unknown as Pool;
}

const retrieval: RetrievalResult = {
  query: "q",
  routeQuestion: false,
  anchors: {
    entities: [{ name: "Giant Rat Ashes", nameNorm: "giant rat ashes", types: ["consumable"], pages: [{ book: "vol1", page: 159 }], match: "exact", similarity: 1, matchedText: "Giant Rat Ashes", isLocation: false }],
    pages: [{ book: "vol1", page: 159 }],
    ownPages: [{ book: "vol1", page: 159 }],
  },
  chunks: [{ book: "vol1", page: 159, chunk_idx: 0, text: "t", heading_path: "h", score: 1, why: ["vector"], ranks: {}, context_kind: "chunk" }],
  pages: [],
  stats: { embeddingTokens: 0, rerankTokens: 0, reranked: false, vectorHits: 1, lexicalHits: 0, timingsMs: {} },
};

async function* fakeAnswer(input: AnswerInput): AsyncIterable<AnswerEvent> {
  // A real answer starts well after the request body was consumed; the writer must still be open then.
  await new Promise((r) => setTimeout(r, 80));
  yield { type: "text", text: "It is in the shack" };
  yield { type: "citation", citation: { book: "vol1", page: 159, quote: "Inside the shack", chunk_idx: 0, heading_path: "h", title: "Vol 1 — p. 159", documentIndex: 0 } };
  yield { type: "text", text: " (history: " + (input.history?.length ?? 0) + ")" };
  yield { type: "done", stats: { model: "fake", mode: "citations", fellBack: false, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, latencyMs: 1, firstTokenMs: 1, citations: 1, documents: 1, stopReason: "end_turn" } };
}

function tempDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "miriel-api-"));
  writeFileSync(path.join(dir, "vol1.pdf"), PDF_BYTES);
  mkdirSync(path.join(dir, "vol1-images"));
  writeFileSync(path.join(dir, "vol1-images", "page - 160.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return dir;
}

async function makeApp(overrides: Partial<ServerDeps> = {}) {
  const calls: { retrieve: unknown[]; prior: unknown[] } = { retrieve: [], prior: [] };
  const app = await buildServer({
    pool: fakePool(),
    dataDir: tempDataDir(),
    logger: false,
    retrieve: async (q, opts) => {
      calls.retrieve.push([q, opts]);
      return retrieval;
    },
    answer: fakeAnswer,
    resolvePrior: async (text) => {
      calls.prior.push(text);
      return ["castle morne"];
    },
    ...overrides,
  });
  return { app, calls };
}

// ---------------------------------------------------------------- tests

test("health reports ok, and 503 problem details when the database is down", async () => {
  const { app } = await makeApp();
  const ok = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { status: "ok", db: "ok" });

  const { app: sick } = await makeApp({ pool: fakePool(false) });
  const res = await sick.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 503);
  assert.match(res.headers["content-type"] as string, /application\/problem\+json/);
  assert.equal(res.json().title, "Database unavailable");
});

test("any route answers 503 Database unavailable when Postgres refuses connections", async () => {
  const down = {
    async query() {
      const e = new Error("connect ECONNREFUSED 172.19.0.2:5432") as NodeJS.ErrnoException;
      e.code = "ECONNREFUSED";
      throw new AggregateError([e], "");
    },
  } as unknown as Pool;
  const { app } = await makeApp({ pool: down });
  const res = await app.inject({ method: "GET", url: "/api/books" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().title, "Database unavailable");
  assert.match(res.headers["content-type"] as string, /problem\+json/);
});

test("GET /api/books returns the public book shape", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/books" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), [{ id: "vol1", title: BOOK.title, label: "Vol 1", pageCount: 513, printedToPdfOffset: 1, pdfRevision: PDF_V }]);
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("PDF revision: ?v of the current revision is immutable, an old one is a 409, none revalidates", async () => {
  const { app } = await makeApp();
  const cur = await app.inject({ method: "GET", url: "/api/books/vol1/pdf?v=" + PDF_V, headers: { range: "bytes=0-3" } });
  assert.equal(cur.statusCode, 206);
  assert.equal(cur.headers["cache-control"], "public, max-age=31536000, immutable");
  const plain = await app.inject({ method: "GET", url: "/api/books/vol1/pdf" });
  assert.equal(plain.headers["cache-control"], "no-cache");
  const old = await app.inject({ method: "GET", url: "/api/books/vol1/pdf?v=000000000000", headers: { range: "bytes=0-3" } });
  assert.equal(old.statusCode, 409);
  assert.equal(old.json().revision, PDF_V);
  const versions = await app.inject({ method: "GET", url: "/api/books/vol1/image-versions" });
  assert.deepEqual(versions.json(), { book: "vol1", pdfRevision: PDF_V, pages: { "159": PHOTO_V } });
});

test("thumbnail cache file and ETag follow the photo version", async () => {
  const dataDir = tempDataDir();
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width: 300, height: 390, channels: 3, background: "#888" } }).jpeg().toFile(path.join(dataDir, "vol1-images", "page - 160.jpg"));
  const thumbCacheDir = mkdtempSync(path.join(os.tmpdir(), "miriel-thumbs-"));
  const { app } = await makeApp({ dataDir, thumbCacheDir });
  const res = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159/thumb?v=" + PHOTO_V });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["etag"], '"' + PHOTO_V + '"');
  assert.deepEqual(readdirSync(path.join(thumbCacheDir, "vol1")), ["p159." + PHOTO_V + ".jpg"]);
  const again = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159/thumb", headers: { "if-none-match": '"' + PHOTO_V + '"' } });
  assert.equal(again.statusCode, 304);
  assert.equal(again.headers["cache-control"], "no-cache");
  assert.ok(existsSync(path.join(thumbCacheDir, "vol1", "p159." + PHOTO_V + ".jpg")));
});

test("PDF is served with Range support; unknown book is a 404 problem", async () => {
  const { app } = await makeApp();
  const full = await app.inject({ method: "GET", url: "/api/books/vol1/pdf" });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.match(full.headers["content-type"] as string, /application\/pdf/);

  const part = await app.inject({ method: "GET", url: "/api/books/vol1/pdf", headers: { range: "bytes=0-3" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, "%PDF");
  assert.equal(part.headers["content-range"], "bytes 0-3/2009");

  const missing = await app.inject({ method: "GET", url: "/api/books/vol9/pdf" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().title, "Unknown book");
});

test("page image maps printed page through the offset; immutable only for the current ?v", async () => {
  const { app } = await makeApp();
  const img = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159/image" });
  assert.equal(img.statusCode, 200);
  assert.match(img.headers["content-type"] as string, /image\/jpeg/);
  assert.equal(img.headers["cache-control"], "no-cache");
  const versioned = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159/image?v=" + PHOTO_V });
  assert.equal(versioned.headers["cache-control"], "public, max-age=2592000, immutable");
  const stale = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159/image?v=0123456789ab" });
  assert.equal(stale.headers["cache-control"], "no-cache");

  const out = await app.inject({ method: "GET", url: "/api/books/vol1/pages/9000/image" });
  assert.equal(out.statusCode, 404);
  assert.equal(out.json().title, "Page out of range");

  const bad = await app.inject({ method: "GET", url: "/api/books/vol1/pages/abc/image" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().title, "Invalid request");
});

test("page detail returns markdown, figures, entities; unindexed page is 404", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/books/vol1/pages/159" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.region, "Altus Plateau");
  assert.equal(body.imageVersion, PHOTO_V);
  assert.equal(body.figures.length, 1);
  const none = await app.inject({ method: "GET", url: "/api/books/vol1/pages/7" });
  assert.equal(none.statusCode, 404);
});

test("entity typeahead validates q and returns hits", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/entities?q=giant" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()[0].name, "Giant Rat Ashes");
  const bad = await app.inject({ method: "GET", url: "/api/entities" });
  assert.equal(bad.statusCode, 400);
});

test("unknown routes and bad chat bodies return problem details", async () => {
  const { app } = await makeApp();
  const nf = await app.inject({ method: "GET", url: "/nope" });
  assert.equal(nf.statusCode, 404);
  assert.match(nf.headers["content-type"] as string, /problem\+json/);

  const bad = await app.inject({ method: "POST", url: "/api/chat", payload: { messages: [] } });
  assert.equal(bad.statusCode, 400);
  assert.ok(Array.isArray(bad.json().errors));

  const lastNotUser = await app.inject({ method: "POST", url: "/api/chat", payload: { messages: [{ role: "assistant", content: "hi" }] } });
  assert.equal(lastNotUser.statusCode, 400);
});

test("POST /api/chat streams anchors, text, citation and done over SSE", async () => {
  const { app, calls } = await makeApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch("http://127.0.0.1:" + port + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Where is Castle Morne?" },
          { role: "assistant", content: "On the Weeping Peninsula." },
          { role: "user", content: "Where is the Giant Rat Ashes?" },
        ],
        bookIds: ["vol1"],
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => {
        const [e, d] = b.split("\n");
        return { event: e!.slice(7), data: JSON.parse(d!.slice(6)) as Record<string, unknown> };
      });
    assert.deepEqual(events.map((e) => e.event), ["anchors", "text", "citation", "text", "done"]);
    const anchors = events[0]!.data as { entities: unknown[]; consulted: unknown[]; imageVersions: Record<string, string> };
    assert.equal(anchors.entities.length, 1);
    assert.deepEqual(anchors.consulted, [{ book: "vol1", page: 159 }]);
    assert.deepEqual(anchors.imageVersions, { "vol1:159": PHOTO_V });
    assert.equal((events[2]!.data as { citation: { imageVersion: string } }).citation.imageVersion, PHOTO_V);
    assert.equal((events[3]!.data as { text: string }).text, " (history: 2)");
    // prior entities were derived from the previous user message and passed to retrieval
    assert.deepEqual(calls.prior, ["Where is Castle Morne?"]);
    assert.deepEqual((calls.retrieve[0] as unknown[])[1], { bookIds: ["vol1"], priorEntities: ["castle morne"] });
  } finally {
    await app.close();
  }
});

test("encodeSse and consultedPages", () => {
  assert.equal(encodeSse("text", { type: "text", text: "a\nb" }), 'event: text\ndata: {"type":"text","text":"a\\nb"}\n\n');
  const pages = consultedPages({
    ...retrieval,
    pages: [{ context_kind: "page", book: "vol1", page: 73, chapter: null, region: null, markdown: "", tokens: 0 }],
  });
  assert.deepEqual(pages, [{ book: "vol1", page: 73 }, { book: "vol1", page: 159 }]);
});
