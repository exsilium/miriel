/**
 * Minimal zip writer and reader for the backup scripts (scripts/backup.mjs). Zero dependencies; Node 22.2+ for
 * zlib.crc32. Writes UTF-8 names, stored or deflated entries and zip64 records whenever a size, offset or the
 * entry count needs them, so archives past 4 GB open in any unzip, 7-Zip, Windows Explorer or macOS Archive
 * Utility. The reader handles what the writer produces (and ordinary zips): it trusts the central directory and
 * checks every entry's CRC-32 and size while extracting.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const STORE = 0;
const DEFLATE = 8;
const UTF8 = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Local headers are written before the data, so zip64 is decided up front: deflate can grow an incompressible file a
// little, hence the margin below 4 GiB.
const LOCAL64_FROM = 0xf0000000;

export function assertZipSupport() {
  if (typeof zlib.crc32 !== "function") {
    throw new Error("Node " + process.versions.node + " has no zlib.crc32; use Node 22.2 or newer");
  }
}

function dosDateTime(date) {
  const d = date.getFullYear() < 1980 ? new Date(1980, 0, 1) : date;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  /** @param {string} file @param {{ forceZip64?: boolean }} [opts] forceZip64 = zip64 records everywhere (tests). */
  static async create(file, opts = {}) {
    return new ZipWriter(await fs.promises.open(file, "w"), !!opts.forceZip64);
  }

  constructor(fh, forceZip64) {
    this.fh = fh;
    this.force = forceZip64;
    this.pos = 0;
    this.entries = [];
  }

  async #write(buf) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.pos);
      this.pos += bytesWritten;
      off += bytesWritten;
    }
  }

  async #patch(buf, position) {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, position + off);
      off += bytesWritten;
    }
  }

  /** Adds a file from disk; `deflate` false stores it as is (JPEG, PDF, already compressed dumps). */
  async addFile(name, srcPath, { deflate = true, mtime } = {}) {
    const st = await fs.promises.stat(srcPath);
    const source = fs.createReadStream(srcPath, { highWaterMark: 1 << 20 });
    return this.#add(name, source, st.size, mtime ?? st.mtime, deflate ? DEFLATE : STORE);
  }

  async addBuffer(name, buf, { deflate = true, mtime = new Date() } = {}) {
    return this.#add(name, Readable.from([buf]), buf.length, mtime, deflate ? DEFLATE : STORE);
  }

  async #add(name, source, size, mtime, method) {
    const nameBuf = Buffer.from(name, "utf8");
    const local64 = this.force || size >= LOCAL64_FROM;
    const { time, date } = dosDateTime(mtime);
    const offset = this.pos;
    const hdr = Buffer.alloc(30);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(local64 ? 45 : 20, 4);
    hdr.writeUInt16LE(UTF8, 6);
    hdr.writeUInt16LE(method, 8);
    hdr.writeUInt16LE(time, 10);
    hdr.writeUInt16LE(date, 12);
    hdr.writeUInt16LE(nameBuf.length, 26);
    hdr.writeUInt16LE(local64 ? 20 : 0, 28);
    const extra = Buffer.alloc(local64 ? 20 : 0);
    if (local64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
    }
    await this.#write(Buffer.concat([hdr, nameBuf, extra]));
    const dataStart = this.pos;

    let crc = 0;
    let usize = 0;
    const steps = [
      source,
      async function* (src) {
        for await (const chunk of src) {
          crc = zlib.crc32(chunk, crc);
          usize += chunk.length;
          yield chunk;
        }
      },
    ];
    if (method === DEFLATE) steps.push(zlib.createDeflateRaw({ level: 6 }));
    steps.push(async (src) => {
      for await (const chunk of src) await this.#write(chunk);
    });
    await pipeline(steps);
    const csize = this.pos - dataStart;
    if (!local64 && (csize >= MAX32 || usize >= MAX32)) throw new Error(name + ": grew past 4 GiB while being written");

    const fix = Buffer.alloc(12);
    fix.writeUInt32LE(crc, 0);
    fix.writeUInt32LE(local64 ? MAX32 : csize, 4);
    fix.writeUInt32LE(local64 ? MAX32 : usize, 8);
    await this.#patch(fix, offset + 14);
    if (local64) {
      const sizes = Buffer.alloc(16);
      sizes.writeBigUInt64LE(BigInt(usize), 0);
      sizes.writeBigUInt64LE(BigInt(csize), 8);
      await this.#patch(sizes, offset + 30 + nameBuf.length + 4);
    }
    this.entries.push({ nameBuf, method, time, date, crc, csize, usize, offset, local64 });
  }

  /** Writes the central directory and closes the file. */
  async close() {
    const cdStart = this.pos;
    for (const e of this.entries) {
      const big = this.force || e.usize >= MAX32 || e.csize >= MAX32 || e.offset >= MAX32;
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(45 | (3 << 8), 4); // made by: zip 4.5, Unix (so the attributes below are file modes)
      c.writeUInt16LE(big || e.local64 ? 45 : 20, 6);
      c.writeUInt16LE(UTF8, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(big ? MAX32 : e.csize, 20);
      c.writeUInt32LE(big ? MAX32 : e.usize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(big ? 28 : 0, 30);
      c.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
      c.writeUInt32LE(big ? MAX32 : e.offset, 42);
      const extra = Buffer.alloc(big ? 28 : 0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.usize), 4);
        extra.writeBigUInt64LE(BigInt(e.csize), 12);
        extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      await this.#write(Buffer.concat([c, e.nameBuf, extra]));
    }
    const cdSize = this.pos - cdStart;
    const n = this.entries.length;
    const big = this.force || n >= MAX16 || cdSize >= MAX32 || cdStart >= MAX32;
    if (big) {
      const z64At = this.pos;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(n), 24);
      r.writeBigUInt64LE(BigInt(n), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(z64At), 8);
      loc.writeUInt32LE(1, 16);
      await this.#write(Buffer.concat([r, loc]));
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(big ? MAX16 : n, 8);
    eocd.writeUInt16LE(big ? MAX16 : n, 10);
    eocd.writeUInt32LE(big ? MAX32 : cdSize, 12);
    eocd.writeUInt32LE(big ? MAX32 : cdStart, 16);
    await this.#write(eocd);
    await this.fh.close();
  }

  /** Closes the file without a central directory (the caller deletes it). */
  async abort() {
    await this.fh.close().catch(() => {});
  }
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) throw new Error("unexpected end of zip file");
    off += bytesRead;
  }
  return buf;
}

/**
 * Reads the central directory. Returns { file, entries: [{ name, method, crc, csize, usize, localOffset }] }.
 */
export async function readZip(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new Error("not a zip file (too short)");
    const tailLen = Math.min(size, 22 + MAX16 + 20);
    const tailAt = size - tailLen;
    const tail = await readAt(fh, tailAt, tailLen);
    let i = tail.length - 22;
    while (i >= 0 && !(tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length)) i--;
    if (i < 0) throw new Error("not a zip file, or truncated (no end of central directory)");
    let n = tail.readUInt16LE(i + 10);
    let cdSize = tail.readUInt32LE(i + 12);
    let cdStart = tail.readUInt32LE(i + 16);
    if (n === MAX16 || cdSize === MAX32 || cdStart === MAX32) {
      const locAt = tailAt + i - 20;
      const loc = await readAt(fh, locAt, 20);
      if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error("zip64 end of central directory locator missing");
      const r = await readAt(fh, Number(loc.readBigUInt64LE(8)), 56);
      if (r.readUInt32LE(0) !== 0x06064b50) throw new Error("zip64 end of central directory record missing");
      n = Number(r.readBigUInt64LE(32));
      cdSize = Number(r.readBigUInt64LE(40));
      cdStart = Number(r.readBigUInt64LE(48));
    }
    const cd = await readAt(fh, cdStart, cdSize);
    const entries = [];
    let p = 0;
    for (let k = 0; k < n; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory at entry " + k);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === MAX32) (usize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (csize === MAX32) (csize = Number(cd.readBigUInt64LE(q)), (q += 8));
          if (localOffset === MAX32) localOffset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      if (flags & 1) throw new Error(name + ": encrypted zip entries are not supported");
      if (method !== STORE && method !== DEFLATE) throw new Error(name + ": unsupported compression method " + method);
      entries.push({ name, method, crc, csize, usize, localOffset });
      p = xEnd + commentLen;
    }
    return { file, entries };
  } finally {
    await fh.close();
  }
}

async function dataRange(zip, entry) {
  const fh = await fs.promises.open(zip.file, "r");
  try {
    const h = await readAt(fh, entry.localOffset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(entry.name + ": local header missing");
    return entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

/** Streams one entry into `sink` (a Writable), checking its CRC-32 and size. */
export async function extractEntry(zip, entry, sink) {
  const start = await dataRange(zip, entry);
  let crc = 0;
  let usize = 0;
  const steps = [
    entry.csize > 0 ? fs.createReadStream(zip.file, { start, end: start + entry.csize - 1, highWaterMark: 1 << 20 }) : Readable.from([]),
  ];
  if (entry.method === DEFLATE) steps.push(zlib.createInflateRaw());
  steps.push(async function* (src) {
    for await (const chunk of src) {
      crc = zlib.crc32(chunk, crc);
      usize += chunk.length;
      yield chunk;
    }
  });
  steps.push(sink);
  await pipeline(steps);
  if (usize !== entry.usize) throw new Error(entry.name + ": size " + usize + " instead of " + entry.usize + " (damaged zip)");
  if (crc !== entry.crc) throw new Error(entry.name + ": CRC mismatch (damaged zip)");
}

export async function extractToFile(zip, entry, dest) {
  await extractEntry(zip, entry, fs.createWriteStream(dest));
}

export async function readEntry(zip, entry) {
  const chunks = [];
  await extractEntry(zip, entry, async (src) => {
    for await (const c of src) chunks.push(c);
  });
  return Buffer.concat(chunks);
}
