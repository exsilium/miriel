// node --test scripts/backup/
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readEntry, readZip, ZipWriter } from "./zip.mjs";

async function roundTrip(forceZip64) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miriel-zip-"));
  try {
    const big = crypto.randomBytes(3 * 1024 * 1024 + 17); // incompressible, several read chunks
    const text = Buffer.from("{\"page\": 1}\n".repeat(50000));
    fs.writeFileSync(path.join(dir, "big.jpg"), big);
    fs.writeFileSync(path.join(dir, "empty.json"), "");
    const file = path.join(dir, "t.zip");
    const zip = await ZipWriter.create(file, { forceZip64 });
    await zip.addFile("data/Elden Ring Vol 1 - The Lands Between/big.jpg", path.join(dir, "big.jpg"), { deflate: false });
    await zip.addFile("out/vol1/empty.json", path.join(dir, "empty.json"));
    await zip.addBuffer("out/vol1/p001.json", text);
    await zip.addBuffer("out/ünï/cödé.md", Buffer.from("é"));
    await zip.close();

    const read = await readZip(file);
    assert.deepEqual(read.entries.map((e) => e.name), [
      "data/Elden Ring Vol 1 - The Lands Between/big.jpg",
      "out/vol1/empty.json",
      "out/vol1/p001.json",
      "out/ünï/cödé.md",
    ]);
    assert.equal(read.entries[0].method, 0);
    assert.ok(read.entries[2].csize < text.length / 10, "text is deflated");
    assert.deepEqual(await readEntry(read, read.entries[0]), big);
    assert.equal((await readEntry(read, read.entries[1])).length, 0);
    assert.deepEqual(await readEntry(read, read.entries[2]), text);
    assert.equal((await readEntry(read, read.entries[3])).toString(), "é");

    // A flipped byte inside stored data must be caught.
    const fd = fs.openSync(file, "r+");
    fs.writeSync(fd, Buffer.from([big[1000] ^ 0xff]), 0, 1, read.entries[0].localOffset + 30 + Buffer.byteLength(read.entries[0].name) + (forceZip64 ? 20 : 0) + 1000);
    fs.closeSync(fd);
    await assert.rejects(readEntry(read, read.entries[0]), /CRC mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("zip round trip", () => roundTrip(false));
test("zip round trip with zip64 records", () => roundTrip(true));

test("truncated zip is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miriel-zip-"));
  try {
    const file = path.join(dir, "t.zip");
    const zip = await ZipWriter.create(file);
    await zip.addBuffer("a.txt", Buffer.from("hello"));
    await zip.close();
    fs.truncateSync(file, fs.statSync(file).size - 5);
    await assert.rejects(readZip(file), /truncated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
