#!/usr/bin/env node
/**
 * `npm run export` / `npm run import`: the whole installation in one backups/miriel_YYYYMMDD.zip and back
 * (README: Backup and restore). The zip holds a database dump (db/miriel.dump, pg_dump -Fc), data/, out/, the
 * retake photos waiting in the `uploads` volume (uploads.tar) and, with --with-env, .env; manifest.json describes
 * it. Zero dependencies (Node 22.2+); every Postgres and volume step runs in the compose containers, so the same
 * script works on Windows, WSL2, macOS and Linux with only Docker and Node on the host.
 *
 *   node scripts/backup.mjs export [--out <dir>] [--with-env] [--force]
 *   node scripts/backup.mjs import [<file.zip>] [--dir <dir>] [--yes] [--force]
 *
 * Import extracts and CRC-checks the whole zip before it touches anything, then stops the stack, saves what it
 * replaces to backups/pre-import-<time>/ in the repo (database dump, data/, out/, uploads), restores the database into a
 * fresh `miriel` database and swaps the folders in. The stack is started again if it was running.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { assertZipSupport, extractEntry, extractToFile, readEntry, readZip, ZipWriter } from "./backup/zip.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAT = "miriel-backup";
const FORMAT_VERSION = 1;
const DB = { user: "miriel", name: "miriel" };
const TREES = ["data", "out"];
const NAME_RE = /^miriel_(\d{8})(?:-(\d+))?\.zip$/;
// Already compressed: stored as is, deflating them only costs time.
const STORED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".zip", ".gz", ".dump", ".tar"]);
const JUNK = new Set(["Thumbs.db", "desktop.ini", ".DS_Store"]);
// Relative to the repo root on purpose: `docker compose cp` would read a Windows drive letter as a container name.
const TMP = ".miriel-tmp";

// ---------------------------------------------------------------------------------------------------------- helpers

function fail(msg) {
  const err = new Error(msg);
  err.userFacing = true;
  throw err;
}

function log(msg) {
  process.stdout.write(msg + "\n");
}

function plural(n, word) {
  return n + " " + word + (Number(n) === 1 ? "" : "s");
}

/** A path for messages: relative to the current folder when inside it, else absolute. */
function shown(p) {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

function gb(bytes) {
  return (bytes / 1e9).toFixed(2) + " GB";
}

/**
 * Runs a command in the repo root. `capture` returns stdout as a string; `stdoutFd` / `stdinFd` connect a file
 * (binary safe, unlike a shell redirect in Windows PowerShell).
 */
function run(cmd, args, { capture = false, quiet = false, allowFail = false, stdinFd, stdoutFd } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = stdoutFd ?? (capture ? "pipe" : quiet ? "ignore" : "inherit");
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: [stdinFd ?? "ignore", stdout, capture || quiet ? "pipe" : "inherit"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (e.code === "ENOENT") reject(Object.assign(new Error(cmd + " not found on PATH"), { userFacing: true }));
      else reject(e);
    });
    child.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, stdout: out, stderr: err });
      else {
        const detail = err.trim() ? "\n" + err.trim() : "";
        reject(Object.assign(new Error(cmd + " " + args.join(" ") + " failed (exit " + code + ")" + detail), { userFacing: true }));
      }
    });
  });
}

const compose = (args, opts) => run("docker", ["compose", ...args], opts);

async function psql(sql, { db = DB.name, allowFail = false } = {}) {
  const r = await compose(["exec", "-T", "db", "psql", "-U", DB.user, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], {
    capture: true,
    allowFail,
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

async function checkDocker() {
  const r = await run("docker", ["compose", "version"], { capture: true, allowFail: true }).catch(() => null);
  if (!r || r.code !== 0) fail("docker compose is not available: install Docker (Desktop) with Compose v2 and start it");
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true, allowFail: true });
  if (info.code !== 0) fail("the Docker engine is not running: start Docker Desktop / the docker service");
}

async function startDb() {
  log("starting the database container …");
  await compose(["up", "-d", "--wait", "db"], { quiet: true });
}

async function runningServices() {
  const r = await compose(["ps", "--status", "running", "--services"], { capture: true, allowFail: true });
  return r.code === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

/** pg_dump inside the db container, then `docker compose cp` out (both binary safe on every OS). */
async function dumpDatabase(destRel) {
  const inContainer = "/tmp/miriel-backup.dump";
  await compose(["exec", "-T", "db", "pg_dump", "-U", DB.user, "-Fc", "-f", inContainer, DB.name]);
  await compose(["exec", "-T", "db", "pg_restore", "-l", inContainer], { quiet: true }); // readable table of contents
  await compose(["cp", "db:" + inContainer, destRel], { quiet: true });
  await compose(["exec", "-T", "db", "rm", "-f", inContainer], { quiet: true });
}

async function uploadsToTar(destAbs) {
  const fd = fs.openSync(destAbs, "w");
  try {
    await compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "api", "-C", "/uploads", "-cf", "-", "."], {
      stdoutFd: fd,
      quiet: true,
    });
  } finally {
    fs.closeSync(fd);
  }
  return countTarFiles(destAbs);
}

/** Regular files in a tar archive (headers only; GNU long-name and pax headers are skipped over). */
function countTarFiles(file) {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(h.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    if (h[156] === 0x30 || h[156] === 0) n++;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return n;
}

/** Every regular file under ROOT/<tree>, as posix paths relative to ROOT, sorted. */
function walk(tree, { skip = () => false } = {}) {
  const out = [];
  const visit = (rel) => {
    const abs = path.join(ROOT, rel);
    for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel + "/" + d.name;
      if (JUNK.has(d.name) || skip(r)) continue;
      if (d.isDirectory()) visit(r);
      else if (d.isFile()) out.push(r);
    }
  };
  if (fs.existsSync(path.join(ROOT, tree))) visit(tree);
  return out;
}

function nonEmptyDir(abs) {
  try {
    return fs.readdirSync(abs).length > 0;
  } catch {
    return false;
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return stamp(d) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function makeProgress(label, totalBytes) {
  let last = 0;
  const tty = process.stdout.isTTY;
  return (doneFiles, totalFiles, doneBytes, final = false) => {
    const now = Date.now();
    if (!final && now - last < (tty ? 250 : 5000)) return;
    last = now;
    const line = label + ": " + doneFiles + "/" + totalFiles + " files, " + gb(doneBytes) + " of " + gb(totalBytes);
    if (tty) process.stdout.write("\r" + line + (final ? "\n" : ""));
    else log(line);
  };
}

/** Renames with a few retries: on Windows an indexer or virus scanner briefly holding a file gives EPERM/EBUSY. */
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        if (["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
          fail("cannot move " + from + " (" + e.code + "): close programs using it (Explorer, an editor, a terminal cd'd into it) and run the import again");
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

function parseArgs(argv, spec) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (!(key in spec)) fail("unknown option " + a);
    if (spec[key] === "string") {
      if (i + 1 >= argv.length) fail(a + " needs a value");
      opts[key] = argv[++i];
    } else opts[key] = true;
  }
  return opts;
}

async function gitInfo() {
  const head = await run("git", ["rev-parse", "HEAD"], { capture: true, allowFail: true }).catch(() => null);
  if (!head || head.code !== 0) return null;
  const st = await run("git", ["status", "--porcelain"], { capture: true, allowFail: true });
  return { commit: head.stdout.trim(), dirty: st.stdout.trim().length > 0 };
}

function localMigrations() {
  const dir = path.join(ROOT, "db", "migrations");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
}

// ----------------------------------------------------------------------------------------------------------- export

async function exportBackup(argv) {
  const opts = parseArgs(argv, { out: "string", "with-env": "flag", force: "flag" });
  const outDir = path.resolve(ROOT, opts.out ?? "backups");
  const locks = walk("data", { skip: (r) => !r.startsWith("data/_versions") }).filter((r) => r.endsWith(".lock"));
  if (locks.length && !opts.force) {
    fail("a retake is running (" + locks.join(", ") + "): wait for it to finish, or pass --force if the lock is stale");
  }
  await checkDocker();

  const started = Date.now();
  const tmpRel = TMP + "/export-" + process.pid;
  const tmp = path.join(ROOT, tmpRel);
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  let seq = 1;
  let name = "miriel_" + stamp() + ".zip";
  while (fs.existsSync(path.join(outDir, name))) name = "miriel_" + stamp() + "-" + ++seq + ".zip";
  const target = path.join(outDir, name);
  const partial = target + ".partial";
  let zip = null;

  try {
    await startDb();
    const serverVersion = await psql("SHOW server_version");
    const migrations = ((await psql("SELECT name FROM schema_migrations ORDER BY name", { allowFail: true })) ?? "")
      .split(/\r?\n/)
      .filter(Boolean);
    const users = await psql("SELECT count(*) FROM users", { allowFail: true });
    log("dumping the database (Postgres " + serverVersion + ", " + migrations.length + " migrations) …");
    await dumpDatabase(tmpRel + "/miriel.dump");

    let uploadFiles = null;
    const tarPath = path.join(tmp, "uploads.tar");
    try {
      log("saving pending retake uploads …");
      uploadFiles = await uploadsToTar(tarPath);
    } catch (e) {
      log("warning: pending retake uploads not included (" + e.message.split("\n")[0] + ")");
      fs.rmSync(tarPath, { force: true });
    }

    const files = TREES.flatMap((t) => walk(t, { skip: (r) => r.endsWith(".lock") && r.startsWith("data/_versions") }));
    const sizes = files.map((f) => fs.statSync(path.join(ROOT, f)));
    const totalBytes = sizes.reduce((s, st) => s + st.size, 0);
    log("writing " + name + " (" + files.length + " files, " + gb(totalBytes) + ") …");

    zip = await ZipWriter.create(partial);
    await zip.addFile("db/miriel.dump", path.join(tmp, "miriel.dump"), { deflate: false });
    if (uploadFiles !== null) await zip.addFile("uploads.tar", tarPath, { deflate: false });
    const withEnv = !!opts["with-env"] && fs.existsSync(path.join(ROOT, ".env"));
    if (opts["with-env"] && !withEnv) log("warning: --with-env given but there is no .env");
    if (withEnv) await zip.addFile("env/.env", path.join(ROOT, ".env"));

    const progress = makeProgress("export", totalBytes);
    const list = [];
    let done = 0;
    for (let i = 0; i < files.length; i++) {
      const rel = files[i];
      const st = sizes[i];
      await zip.addFile(rel, path.join(ROOT, rel), { deflate: !STORED_EXT.has(path.extname(rel).toLowerCase()), mtime: st.mtime });
      list.push([rel, st.size, Math.round(st.mtimeMs)]);
      done += st.size;
      progress(i + 1, files.length, done);
    }
    progress(files.length, files.length, done, true);

    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      host: os.hostname(),
      platform: process.platform,
      git: await gitInfo(),
      database: {
        dump: "db/miriel.dump",
        serverVersion,
        migrations,
        users: users === null ? null : Number(users),
      },
      uploads: uploadFiles === null ? null : { tar: "uploads.tar", files: uploadFiles },
      env: withEnv,
      trees: TREES,
      bytes: totalBytes,
      files: list,
    };
    await zip.addBuffer("manifest.json", Buffer.from(JSON.stringify(manifest, null, 1)));
    await zip.close();
    zip = null;
    fs.renameSync(partial, target);

    const secs = Math.round((Date.now() - started) / 1000);
    log("");
    log("backup written: " + shown(target) + " (" + gb(fs.statSync(target).size) + ", " + secs + " s)");
    log("  database: " + migrations.length + " migrations" + (users !== null ? ", " + plural(users, "user account") : ""));
    log("  files: " + files.length + " from " + TREES.join("/, ") + "/" + (uploadFiles ? ", " + plural(uploadFiles, "pending upload") : ""));
    log(withEnv ? "  .env included: the zip holds your API keys, keep it private" : "  .env not included (--with-env adds it)");
    log("It contains the book text and user password hashes: keep it out of git and off public shares.");
  } finally {
    if (zip) {
      await zip.abort();
      fs.rmSync(partial, { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    removeIfEmpty(path.join(ROOT, TMP));
  }
}

function removeIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch {}
}

// ----------------------------------------------------------------------------------------------------------- import

function findNewest(dirs) {
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = NAME_RE.exec(f);
      if (m) found.push({ file: path.join(dir, f), date: m[1], seq: Number(m[2] ?? 1), mtime: fs.statSync(path.join(dir, f)).mtimeMs });
    }
  }
  found.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.mtime - b.mtime);
  return found.at(-1)?.file ?? null;
}

function safeEntryName(name) {
  const parts = name.split("/");
  const ok =
    !name.includes("\\") &&
    !name.startsWith("/") &&
    !/^[A-Za-z]:/.test(name) &&
    parts.every((p) => p !== "" && p !== "." && p !== "..") &&
    (name === "manifest.json" || name === "uploads.tar" || name === "db/miriel.dump" || name === "env/.env" || TREES.includes(parts[0]));
  if (!ok) fail("unexpected entry in the zip: " + JSON.stringify(name) + " (not a Miriel backup?)");
  return name;
}

async function confirm(question) {
  if (!process.stdin.isTTY) fail("the import replaces existing data: run it again with --yes to confirm");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question + " Type yes to continue: ")).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function importBackup(argv) {
  const opts = parseArgs(argv, { dir: "string", yes: "flag", force: "flag" });
  const file = opts._[0]
    ? path.resolve(process.cwd(), opts._[0])
    : findNewest([path.resolve(ROOT, opts.dir ?? "backups"), ROOT]);
  if (!file) fail("no backup found: put a miriel_YYYYMMDD.zip into backups/ or pass its path");
  if (!fs.existsSync(file)) fail(file + " does not exist");
  log("backup: " + shown(file) + " (" + gb(fs.statSync(file).size) + ")");

  const zip = await readZip(file);
  const byName = new Map(zip.entries.map((e) => [safeEntryName(e.name), e]));
  const mEntry = byName.get("manifest.json");
  if (!mEntry) fail("manifest.json missing: not a Miriel backup, or an export that did not finish");
  const manifest = JSON.parse((await readEntry(zip, mEntry)).toString("utf8"));
  if (manifest.format !== FORMAT) fail("not a Miriel backup (format " + JSON.stringify(manifest.format) + ")");
  if (manifest.version > FORMAT_VERSION) fail("backup format " + manifest.version + " is newer than this script: update the code (git pull)");
  if (!byName.has("db/miriel.dump")) fail("the backup has no database dump");

  const fileEntries = zip.entries.filter((e) => TREES.includes(e.name.split("/")[0]));
  const totalBytes = fileEntries.reduce((s, e) => s + e.usize, 0);
  log(
    "  made " + manifest.createdAt + " on " + manifest.host + " (" + manifest.platform + ")" +
      (manifest.git ? ", code " + manifest.git.commit.slice(0, 7) + (manifest.git.dirty ? "+changes" : "") : ""),
  );
  log(
    "  " + fileEntries.length + " files (" + gb(totalBytes) + "), database with " + manifest.database.migrations.length + " migrations" +
      (manifest.database.users !== null ? " and " + plural(manifest.database.users, "user account") : "") +
      (manifest.uploads?.files ? ", " + plural(manifest.uploads.files, "pending upload") : "") + (manifest.env ? ", .env" : ""),
  );

  const known = new Set(localMigrations());
  const unknown = manifest.database.migrations.filter((m) => !known.has(m));
  if (unknown.length && !opts.force) {
    fail("the backup's database has migrations this checkout does not know (" + unknown.join(", ") + "): update the code first (git pull), or pass --force");
  }

  if (typeof fs.statfsSync === "function") {
    const s = fs.statfsSync(ROOT);
    const free = Number(s.bavail) * Number(s.bsize);
    const need = totalBytes + (byName.get("db/miriel.dump")?.usize ?? 0) + 500e6;
    if (free < need) fail("not enough disk space: the import needs about " + gb(need) + ", " + gb(free) + " free");
  }

  await checkDocker();

  // .env first: compose refuses to load the project without the env_file its services name.
  const envPath = path.join(ROOT, ".env");
  const envEntry = byName.get("env/.env");
  let envNote = null;
  if (!fs.existsSync(envPath)) {
    if (envEntry) {
      await extractToFile(zip, envEntry, envPath);
      envNote = ".env restored from the backup";
    } else {
      fs.copyFileSync(path.join(ROOT, ".env.example"), envPath);
      envNote = ".env created from .env.example: fill in ANTHROPIC_API_KEY and VOYAGE_API_KEY";
    }
  } else if (envEntry) {
    const current = fs.readFileSync(envPath);
    const saved = await readEntry(zip, envEntry);
    if (!current.equals(saved)) {
      fs.writeFileSync(envPath + ".from-backup", saved);
      envNote = "your .env was kept; the backup's copy is in .env.from-backup";
    }
  }

  const before = await runningServices();
  await startDb();
  const tables = Number((await psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")) ?? 0);
  const replacing = [];
  if (tables > 0) replacing.push("the database (" + tables + " tables)");
  for (const t of TREES) if (nonEmptyDir(path.join(ROOT, t))) replacing.push(t + "/");
  const restoreUploads = !!manifest.uploads?.files && byName.has("uploads.tar");
  if (restoreUploads) replacing.push("pending retake uploads");
  // Always under the repo root: same drive as data/ (moving it there is a rename) and a relative path for docker cp.
  const prevRel = "backups/pre-import-" + timeStamp();
  const prev = path.join(ROOT, prevRel);
  if (replacing.length > 0) {
    log("");
    log("This replaces " + replacing.join(", ") + ".");
    log("The current state is moved to " + prevRel + "/ first (delete it once the restore looks right).");
    if (!opts.yes && !(await confirm("Replace it?"))) fail("import cancelled; nothing was changed");
  }

  // 1. Extract everything into a staging folder next to data/ (same drive: the swap is a rename) and check it.
  const stageRel = TMP + "/import-" + process.pid;
  const stage = path.join(ROOT, stageRel);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const mtimes = new Map((manifest.files ?? []).map(([p, , m]) => [p, m]));
  const progress = makeProgress("extract", totalBytes);
  let done = 0;
  let n = 0;
  try {
    const toExtract = zip.entries.filter((e) => e.name !== "manifest.json" && e.name !== "env/.env");
    for (const e of toExtract) {
      const dest = path.join(stage, ...e.name.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await extractEntry(zip, e, fs.createWriteStream(dest));
      const m = mtimes.get(e.name);
      if (m) fs.utimesSync(dest, new Date(m), new Date(m));
      if (TREES.includes(e.name.split("/")[0])) {
        done += e.usize;
        progress(++n, fileEntries.length, done);
      }
    }
    progress(n, fileEntries.length, done, true);
    for (const t of TREES) fs.mkdirSync(path.join(stage, t), { recursive: true });
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  log("all entries verified (CRC-32 and size)");

  // 2. Stop the stack; only the database runs from here on.
  log("stopping the stack …");
  await compose(["down"], { quiet: true });
  await startDb();

  // 3. Save what is being replaced.
  if (replacing.length > 0) {
    fs.mkdirSync(prev, { recursive: true });
    if (tables > 0) {
      log("saving the current database to " + prevRel + "/miriel.dump …");
      await dumpDatabase(prevRel + "/miriel.dump");
    }
    if (restoreUploads) {
      try {
        const kept = await uploadsToTar(path.join(prev, "uploads.tar"));
        if (kept === 0) fs.rmSync(path.join(prev, "uploads.tar"), { force: true });
      } catch (e) {
        log("warning: could not save the current uploads (" + e.message.split("\n")[0] + ")");
      }
    }
  }

  // 4. Database: a fresh `miriel` database, then the dump.
  log("restoring the database …");
  await psql("DROP DATABASE IF EXISTS " + DB.name + " WITH (FORCE)", { db: "postgres" });
  await psql("CREATE DATABASE " + DB.name + " OWNER " + DB.user, { db: "postgres" });
  const inContainer = "/tmp/miriel-restore.dump";
  await compose(["cp", stageRel + "/db/miriel.dump", "db:" + inContainer], { quiet: true });
  await compose(["exec", "-T", "db", "pg_restore", "-U", DB.user, "-d", DB.name, "--no-owner", "--exit-on-error", "--single-transaction", inContainer]);
  await compose(["exec", "-T", "db", "rm", "-f", inContainer], { quiet: true });
  const restored = Number((await psql("SELECT count(*) FROM schema_migrations", { allowFail: true })) ?? 0);
  if (restored !== manifest.database.migrations.length) {
    fail("database restored with " + restored + " migrations instead of " + manifest.database.migrations.length);
  }

  // 5. Uploads volume.
  if (restoreUploads) {
    log("restoring " + plural(manifest.uploads.files, "pending upload") + " …");
    await compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "api", "-c", "find /uploads -mindepth 1 -delete"], { quiet: true });
    const fd = fs.openSync(path.join(stage, "uploads.tar"), "r");
    try {
      await compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "api", "-C", "/uploads", "-xf", "-"], { stdinFd: fd, quiet: true });
    } finally {
      fs.closeSync(fd);
    }
  }

  // 6. Swap the folders in.
  for (const t of TREES) {
    const live = path.join(ROOT, t);
    if (fs.existsSync(live)) {
      if (nonEmptyDir(live)) await rename(live, path.join(prev, t));
      else fs.rmSync(live, { recursive: true, force: true });
    }
    await rename(path.join(stage, t), live);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  removeIfEmpty(path.join(ROOT, TMP));

  log("");
  log("restored " + fileEntries.length + " files and the database (" + restored + " migrations) from " + path.basename(file));
  if (envNote) log(envNote);
  if (replacing.length > 0) log("previous state: " + prevRel + "/");
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 1000) {
    log("Linux: retakes and extraction run as uid 1000 in the containers; if they need to write: sudo chown -R 1000:1000 data out");
  }
  const app = ["api", "web"].some((s) => before.includes(s));
  if (app) {
    log("starting the stack again …");
    await compose(["up", "-d"], { quiet: true });
    log("app at http://localhost:3000");
  } else {
    log("next: npm run up (app at http://localhost:3000)");
  }
}

// ------------------------------------------------------------------------------------------------------------- main

const USAGE = `usage:
  node scripts/backup.mjs export [--out <dir>] [--with-env] [--force]     (npm run export -- …)
  node scripts/backup.mjs import [<file.zip>] [--dir <dir>] [--yes] [--force]   (npm run import -- …)`;

async function main() {
  assertZipSupport();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "export") await exportBackup(rest);
  else if (cmd === "import") await importBackup(rest);
  else {
    log(USAGE);
    process.exitCode = cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

main().catch((e) => {
  process.stderr.write((e.userFacing ? "error: " + e.message : e.stack ?? String(e)) + "\n");
  process.exitCode = 1;
});
