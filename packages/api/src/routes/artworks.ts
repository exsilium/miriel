/**
 * Art book routes (docs/build-spec-artbooks.md §6.3):
 *   GET /api/books/:id/spreads/:n         spread detail (folios, contents, artworks with boxes)
 *   GET /api/artworks/:id                 one artwork
 *   GET /api/artworks/:id/crop?w=&v=      the artwork cut from its spread, fitted inside w x w px, JPEG, cached under THUMB_CACHE_DIR
 *   GET /api/artworks?entity=&q=&book=    search: by guide name (exact name_norm) and/or by text (vector)
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeName } from "@miriel/shared";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { artworksByVector, artworksForEntities, getArtwork, getSpread, type Artwork } from "../art.js";
import { HttpProblem } from "../problem.js";
import type { ServerDeps } from "../server.js";
import { versionedCache } from "../versions.js";
import { parse, requireBook } from "./books.js";

const SpreadParams = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/), n: z.coerce.number().int().min(1).max(99_999) });
const ArtworkParams = z.object({ id: z.coerce.number().int().positive() });
/** Crop widths are snapped to a few sizes so the cache stays small. */
export const CROP_WIDTHS = [240, 480, 960, 1600] as const;
const CropQuery = z.object({ w: z.coerce.number().int().min(1).max(4000).optional(), v: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() });
const SearchQuery = z.object({
  entity: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(500).optional(),
  book: z.union([z.string().regex(/^[a-z0-9_-]+$/), z.array(z.string().regex(/^[a-z0-9_-]+$/))]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
const CROP_MAX_AGE = 31_536_000;
/** Margin around the box, as a share of the box size, so the crop is not cut tight against the art. */
const CROP_MARGIN = 0.02;

export function snapWidth(w: number | undefined): number {
  const want = w ?? 480;
  return CROP_WIDTHS.find((c) => c >= want) ?? 1600;
}

export function registerArtworkRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const cacheDir = path.join(deps.thumbCacheDir ?? path.join(os.tmpdir(), "miriel-thumbs"), "art");
  const inflight = new Map<string, Promise<string>>();

  app.get<{ Params: { id: string; n: string } }>("/api/books/:id/spreads/:n", async (request, reply) => {
    const { id, n } = parse(SpreadParams, request.params);
    const book = await requireBook(deps, id);
    if (book.kind !== "artbook") throw new HttpProblem(400, "Not an art book", id + " is a guide; use /api/books/" + id + "/pages/" + n + ".");
    if (n > book.page_count) throw new HttpProblem(404, "Page out of range", "PDF page " + n + " is not in " + id + ".");
    reply.header("cache-control", "no-cache");
    const spread = await getSpread(deps.pool, id, n);
    if (spread) return spread;
    // not labelled (yet): the folios still come from the config rule
    const s = book.spread;
    const folios = s && n >= s.pdfPage ? [s.leftFolio + 2 * (n - s.pdfPage), s.leftFolio + 2 * (n - s.pdfPage) + 1] : [];
    return { book: id, pdfPage: n, folios, labelled: false, contents: [], sectionHeadingJa: null, imageVersion: null, artworks: [] };
  });

  app.get<{ Params: { id: string } }>("/api/artworks/:id", async (request) => {
    const { id } = parse(ArtworkParams, request.params);
    const art = await getArtwork(deps.pool, id);
    if (!art) throw new HttpProblem(404, "Unknown artwork", "No artwork " + id + ".");
    const { imageDir: _d, imagePattern: _p, ...out } = art;
    return out;
  });

  app.get<{ Params: { id: string } }>("/api/artworks/:id/crop", async (request, reply) => {
    const { id } = parse(ArtworkParams, request.params);
    const { w, v } = parse(CropQuery, request.query);
    const art = await getArtwork(deps.pool, id);
    if (!art) throw new HttpProblem(404, "Unknown artwork", "No artwork " + id + ".");
    const width = snapWidth(w);
    const source = path.join(deps.dataDir, art.imageDir, art.imagePattern.replace("{n}", String(art.pdfPage)));
    // keyed by spread, box and spread version: re-ingesting (new ids) or a changed box never serves a stale file
    const boxKey = createHash("sha1").update(art.bbox.join(",")).digest("hex").slice(0, 8);
    const version = art.imageVersion ?? "nov";
    const target = path.join(cacheDir, art.book, "s" + art.pdfPage + "-" + boxKey + ".sq" + width + "." + version + ".jpg");
    const etag = '"' + boxKey + "-" + width + "-" + version + '"';
    reply.header("cache-control", versionedCache(v, art.imageVersion, CROP_MAX_AGE));
    reply.header("etag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    const file = await crop(source, target, art.bbox, width, inflight);
    reply.type("image/jpeg");
    return reply.send(createReadStream(file));
  });

  app.get("/api/artworks", async (request) => {
    const q = parse(SearchQuery, request.query);
    if (!q.entity && !q.q) throw new HttpProblem(400, "Invalid request", "Give entity=<name> and/or q=<text>.");
    const books = q.book === undefined ? undefined : Array.isArray(q.book) ? q.book : [q.book];
    const byEntity: Artwork[] = q.entity ? await artworksForEntities(deps.pool, [normalizeName(q.entity)], books, q.limit) : [];
    let byText: (Artwork & { similarity: number })[] = [];
    if (q.q) {
      if (!deps.embedQuery) throw new HttpProblem(503, "Search unavailable", "No embedding provider is configured.");
      byText = await artworksByVector(deps.pool, await deps.embedQuery(q.q), books, q.limit);
    }
    return { entity: byEntity, text: byText };
  });
}

/** Cut the box (plus a small margin) out of the spread and scale it to `width`; one generation per target file. */
async function crop(source: string, target: string, bbox: number[], width: number, inflight: Map<string, Promise<string>>): Promise<string> {
  if (await exists(target)) return target;
  let job = inflight.get(target);
  if (!job) {
    job = (async () => {
      if (!(await exists(source))) throw new HttpProblem(404, "Spread image missing", "No spread image at " + path.basename(source) + " (run scripts/art_export.py).");
      const img = sharp(source);
      const meta = await img.metadata();
      const W = meta.width ?? 0;
      const H = meta.height ?? 0;
      const [x0, y0, x1, y1] = bbox as [number, number, number, number];
      const mx = (x1 - x0) * CROP_MARGIN;
      const my = (y1 - y0) * CROP_MARGIN;
      const left = Math.max(0, Math.floor((x0 - mx) * W));
      const top = Math.max(0, Math.floor((y0 - my) * H));
      const right = Math.min(W, Math.ceil((x1 + mx) * W));
      const bottom = Math.min(H, Math.ceil((y1 + my) * H));
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = target + "." + process.pid + "." + Date.now() + ".tmp";
      await img
        .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(tmp);
      await rename(tmp, target);
      return target;
    })().finally(() => inflight.delete(target));
    inflight.set(target, job);
  }
  return job;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
