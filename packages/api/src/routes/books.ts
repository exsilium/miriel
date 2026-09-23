import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { listBooks } from "../books.js";
import { HttpProblem } from "../problem.js";
import { getBook, getPage } from "../queries.js";
import type { ServerDeps } from "../server.js";

const BookParams = z.object({ id: z.string().regex(/^[a-z0-9_-]+$/) });
const PageParams = BookParams.extend({ n: z.coerce.number().int().min(0).max(99_999) });

const IMAGE_CACHE = "public, max-age=2592000, immutable";
const PDF_CACHE = "public, max-age=86400";
const THUMB_CACHE = "public, max-age=31536000, immutable";
/** Width of the "Pages consulted" thumbnails. Height follows the page aspect. */
export const THUMB_WIDTH = 240;

export function registerBookRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/api/books", async () => {
    const books = await listBooks(deps.pool);
    return books.map((b) => ({
      id: b.id,
      title: b.title,
      label: b.label,
      pageCount: b.page_count,
      printedToPdfOffset: b.printed_to_pdf_offset,
    }));
  });

  app.get<{ Params: { id: string } }>("/api/books/:id/pdf", async (request, reply) => {
    const { id } = parse(BookParams, request.params);
    const book = await requireBook(deps, id);
    reply.header("cache-control", PDF_CACHE);
    reply.header("content-disposition", 'inline; filename="' + id + '.pdf"');
    // @fastify/static handles Range, ETag and Last-Modified; root is DATA_DIR.
    return reply.sendFile(book.pdf_path);
  });

  app.get<{ Params: { id: string; n: string } }>("/api/books/:id/pages/:n/image", async (request, reply) => {
    const { id, n } = parse(PageParams, request.params);
    const book = await requireBook(deps, id);
    const imageNo = n + book.printed_to_pdf_offset;
    if (imageNo < 1 || imageNo > book.page_count) {
      throw new HttpProblem(404, "Page out of range", "Printed page " + n + " is not in " + id + ".");
    }
    reply.header("cache-control", IMAGE_CACHE);
    return reply.sendFile(path.posix.join(book.image_dir, book.image_pattern.replace("{n}", String(imageNo))));
  });

  const thumbDir = deps.thumbCacheDir ?? path.join(os.tmpdir(), "miriel-thumbs");
  const inflight = new Map<string, Promise<string>>();
  app.get<{ Params: { id: string; n: string } }>("/api/books/:id/pages/:n/thumb", async (request, reply) => {
    const { id, n } = parse(PageParams, request.params);
    const book = await requireBook(deps, id);
    const imageNo = n + book.printed_to_pdf_offset;
    if (imageNo < 1 || imageNo > book.page_count) {
      throw new HttpProblem(404, "Page out of range", "Printed page " + n + " is not in " + id + ".");
    }
    const source = path.join(deps.dataDir, book.image_dir, book.image_pattern.replace("{n}", String(imageNo)));
    const file = await thumbnail(source, path.join(thumbDir, id, "p" + n + ".jpg"), inflight);
    reply.header("cache-control", THUMB_CACHE);
    reply.type("image/jpeg");
    return reply.send(createReadStream(file));
  });

  app.get<{ Params: { id: string; n: string } }>("/api/books/:id/pages/:n", async (request) => {
    const { id, n } = parse(PageParams, request.params);
    await requireBook(deps, id);
    const page = await getPage(deps.pool, id, n);
    if (!page) throw new HttpProblem(404, "Page not indexed", "Printed page " + n + " of " + id + " has not been ingested.");
    return page;
  });
}

/**
 * Return the cached thumbnail path, generating it from the page photo on first request. Concurrent requests
 * for the same page share one generation; the file is written to a temp name and renamed so a reader never
 * sees a partial JPEG.
 */
async function thumbnail(source: string, target: string, inflight: Map<string, Promise<string>>): Promise<string> {
  if (await exists(target)) return target;
  let job = inflight.get(target);
  if (!job) {
    job = (async () => {
      if (!(await exists(source))) throw new HttpProblem(404, "Page image missing", "No page image at " + path.basename(source) + ".");
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = target + "." + process.pid + "." + Date.now() + ".tmp";
      await sharp(source).rotate().resize({ width: THUMB_WIDTH }).jpeg({ quality: 72, mozjpeg: true }).toFile(tmp);
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

export async function requireBook(deps: ServerDeps, id: string) {
  const book = await getBook(deps.pool, id);
  if (!book) throw new HttpProblem(404, "Unknown book", 'No book with id "' + id + '".');
  return book;
}

export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new HttpProblem(400, "Invalid request", "Request parameters failed validation.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}
