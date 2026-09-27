/**
 * The retake worker: validates uploaded photos, runs confirmed retakes and rollbacks through scripts/retake.py,
 * and reports stage, messages and results in retake_jobs / retake_events. The api only inserts and confirms
 * jobs; every write to data/ and out/ happens here (docs/build-spec-retakes.md §4).
 *
 * Serialisation: jobs of one book run one at a time, guarded by a session advisory lock per book (released if
 * the worker dies) and by retake.py's own lock file, which a CLI run also holds. Resume: a job left `running`
 * whose book lock is free belongs to a dead worker; it is re-queued and retake.py --resume continues from its
 * journal's last completed stage.
 */
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { lockHolder, readJournal, spentToday } from "./journals.js";
import { runRetake, type Line, type RetakeEvent } from "./runner.js";

export interface WorkerConfig {
  dataDir: string;
  uploadDir: string;
  python: string;
  script: string;
  cwd: string;
  budgetUsd: number;
  pollMs: number;
  log: (msg: string) => void;
}

export interface JobRow {
  id: string;
  book_id: string;
  page: number | null;
  kind: "retake" | "rollback";
  status: string;
  message: string | null;
  upload_path: string | null;
  upload_name: string | null;
  estimate_usd: string | null;
  txn_id: string | null;
  batch_id: string | null;
  created_at: Date;
}

export interface Group {
  book: string;
  kind: "retake" | "rollback";
  txnId: string | null;
  jobs: JobRow[];
}

/**
 * Confirmed jobs -> units of work, oldest first. A retried job resumes its retake (same txn_id); photos of a
 * batch confirmed together become one retake (one PDF write); a rollback is always its own unit.
 */
export function groupConfirmed(rows: JobRow[]): Group[] {
  const groups = new Map<string, Group>();
  const sorted = [...rows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  for (const r of sorted) {
    const key =
      r.kind === "rollback" ? "rb:" + r.id : r.txn_id ? "txn:" + r.txn_id : r.batch_id ? "b:" + r.book_id + ":" + r.batch_id : "j:" + r.id;
    const g = groups.get(key) ?? { book: r.book_id, kind: r.kind, txnId: r.txn_id, jobs: [] };
    g.jobs.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function newTxnId(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + "-" + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  return "rt-" + stamp + "-" + randomBytes(2).toString("hex");
}

const JOB_COLUMNS = "id, book_id, page, kind, status, message, upload_path, upload_name, estimate_usd, txn_id, batch_id, created_at";
const LOCK_PREFIX = "miriel-retake:";

export class RetakeWorker {
  private stopping = false;

  constructor(
    private readonly pool: Pool,
    private readonly cfg: WorkerConfig,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  async loop(): Promise<void> {
    this.cfg.log("retake worker ready (data " + this.cfg.dataDir + ", uploads " + this.cfg.uploadDir + ", budget $" + this.cfg.budgetUsd + "/day)");
    while (!this.stopping) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (err) {
        this.cfg.log("tick failed: " + (err instanceof Error ? err.message : String(err)));
      }
      if (!busy && !this.stopping) await new Promise((r) => setTimeout(r, this.cfg.pollMs));
    }
  }

  /** One unit of work; true if something was done (poll again at once). */
  async tick(): Promise<boolean> {
    return (await this.requeueOrphans()) || (await this.abandonDiscarded()) || (await this.validateOne()) || (await this.runNext());
  }

  // ------------------------------------------------------------------ helpers

  private async event(txnOrId: { txn?: string; id?: string }, stage: string | null, message: string, db: Pool | PoolClient = this.pool): Promise<void> {
    const where = txnOrId.txn ? "txn_id = $1" : "id = $1";
    await db.query(
      "INSERT INTO retake_events (job_id, stage, message) SELECT id, $2, $3 FROM retake_jobs WHERE " + where,
      [txnOrId.txn ?? txnOrId.id, stage, message.slice(0, 2000)],
    );
  }

  private async tryBookLock(book: string): Promise<PoolClient | undefined> {
    const client = await this.pool.connect();
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_PREFIX + book]);
    if (rows[0]?.ok) return client;
    client.release();
    return undefined;
  }

  private async releaseBookLock(client: PoolClient, book: string): Promise<void> {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_PREFIX + book]);
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ orphans and discards

  /** Jobs left `running` by a dead worker (their book lock is free): back to `confirmed` so runNext resumes them. */
  private async requeueOrphans(): Promise<boolean> {
    const { rows } = await this.pool.query<{ book_id: string; txn_id: string }>(
      "SELECT DISTINCT book_id, txn_id FROM retake_jobs WHERE status = 'running' AND txn_id IS NOT NULL",
    );
    let any = false;
    for (const r of rows) {
      const lock = await this.tryBookLock(r.book_id);
      if (!lock) continue;
      try {
        const res = await this.pool.query(
          "UPDATE retake_jobs SET status = 'confirmed', message = 'resuming after a worker restart', updated_at = now() WHERE txn_id = $1 AND status = 'running'",
          [r.txn_id],
        );
        if (res.rowCount) {
          this.cfg.log("re-queued " + r.txn_id + " (" + r.book_id + ") left running by a stopped worker");
          await this.event({ txn: r.txn_id }, null, "worker restarted; resuming from the last completed stage");
          any = true;
        }
      } finally {
        await this.releaseBookLock(lock, r.book_id);
      }
    }
    return any;
  }

  /** A discarded job whose retake never touched the PDF: drop its journal, temp files and the book lock. */
  private async abandonDiscarded(): Promise<boolean> {
    const { rows } = await this.pool.query<{ book_id: string; txn_id: string }>(
      `SELECT DISTINCT j.book_id, j.txn_id FROM retake_jobs j
        WHERE j.status = 'discarded' AND j.txn_id IS NOT NULL AND j.stage IS DISTINCT FROM 'abandoned'
          AND NOT EXISTS (SELECT 1 FROM retake_jobs o WHERE o.txn_id = j.txn_id AND o.status <> 'discarded')`,
    );
    for (const r of rows) {
      const journal = readJournal(this.cfg.dataDir, r.book_id, r.txn_id);
      if (journal && (journal.status === "running" || journal.status === "failed") && !journal.stages["commit_pdf"]) {
        const out = await runRetake(["--book", r.book_id, "--abandon", r.txn_id], this.runOpts(() => undefined));
        this.cfg.log("abandon " + r.txn_id + ": exit " + out.code + (out.tail.length ? " (" + out.tail.at(-1) + ")" : ""));
      }
      await this.pool.query("UPDATE retake_jobs SET stage = 'abandoned', updated_at = now() WHERE txn_id = $1 AND status = 'discarded'", [r.txn_id]);
    }
    return rows.length > 0;
  }

  // ------------------------------------------------------------------ validation

  private async validateOne(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<JobRow>(
        "SELECT " + JOB_COLUMNS + " FROM retake_jobs WHERE status = 'uploaded' AND kind = 'retake' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      const job = rows[0];
      if (!job) {
        await client.query("COMMIT");
        return false;
      }
      this.cfg.log("validating " + job.id + " (" + job.book_id + ", " + (job.upload_name ?? "?") + ")");
      const args = ["--book", job.book_id, "--image", path.join(this.cfg.uploadDir, job.upload_path ?? ""), "--validate-only", "--json"];
      if (job.page !== null) args.push("--page", String(job.page));
      const lines: string[] = [];
      const out = await runRetake(args, this.runOpts((l) => {
        if (l.kind === "log") lines.push(l.line);
      }));
      const plan = out.events.find((e): e is Extract<RetakeEvent, { event: "plan" }> => e.event === "plan");
      const item = plan?.items[0];
      let status = "rejected";
      let error: string | null = null;
      if (!item) {
        error = out.tail.slice(-3).join(" | ") || "validation exited " + out.code;
      } else if (item.errors.length) {
        error = item.errors.join("; ");
      } else {
        const dup = await client.query<{ upload_name: string | null }>(
          `SELECT upload_name FROM retake_jobs WHERE batch_id = $1 AND page = $2 AND id <> $3
             AND status IN ('validated', 'submitted', 'confirmed', 'running')`,
          [job.batch_id, item.printed, job.id],
        );
        if (job.batch_id && dup.rows[0]) {
          error = "printed page " + item.printed + " is also in this batch (" + (dup.rows[0].upload_name ?? "another photo") + ")";
        } else {
          status = "validated";
          const pending = await client.query(
            `SELECT 1 FROM retake_jobs WHERE book_id = $1 AND page = $2 AND id <> $3 AND status IN ('validated', 'submitted', 'confirmed', 'running')
               AND batch_id IS DISTINCT FROM $4`,
            [job.book_id, item.printed, job.id, job.batch_id],
          );
          if (pending.rowCount) item.warnings.push("another retake of this page is pending");
        }
      }
      const folio = item
        ? { folio: item.folio ?? null, match: item.match, imageNo: item.image_no ?? null, size: item.size ?? null, errors: item.errors, warnings: item.warnings, notes: item.notes }
        : null;
      await client.query(
        `UPDATE retake_jobs SET status = $2, page = COALESCE($3, page), image_sha256 = $4, folio_check = $5, estimate_usd = $6,
                before = $7, error = $8, stage = NULL, message = $9, updated_at = now() WHERE id = $1`,
        [job.id, status, item?.printed ?? null, item?.sha256 ?? null, folio, plan?.per_page_usd ?? null, item?.before ?? null, error,
         status === "validated" ? "validated; waiting for confirmation" : "rejected: " + error],
      );
      for (const line of lines.slice(-50)) await this.event({ id: job.id }, "validate", line, client);
      await client.query("COMMIT");
      this.cfg.log("  " + status + (error ? ": " + error : " as printed page " + item?.printed));
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ running

  private async runNext(): Promise<boolean> {
    const client = await this.pool.connect();
    let claimed: { group: Group; txn: string; lock: PoolClient } | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<JobRow>(
        "SELECT " + JOB_COLUMNS + " FROM retake_jobs WHERE status = 'confirmed' ORDER BY created_at FOR UPDATE SKIP LOCKED",
      );
      const spent = spentToday(this.cfg.dataDir);
      const wait = async (g: Group, msg: string): Promise<void> => {
        await client.query("UPDATE retake_jobs SET message = $2, updated_at = now() WHERE id = ANY($1) AND message IS DISTINCT FROM $2", [
          g.jobs.map((j) => j.id),
          msg,
        ]);
      };
      for (const g of groupConfirmed(rows)) {
        const holder = lockHolder(this.cfg.dataDir, g.book);
        if (holder && holder !== g.txnId) {
          await wait(g, "waiting: " + g.book + " is locked by retake " + holder + " (a CLI run, or finish it with --resume)");
          continue;
        }
        const fresh = !g.txnId || !readJournal(this.cfg.dataDir, g.book, g.txnId);
        const estimate = g.jobs.reduce((s, j) => s + Number(j.estimate_usd ?? 0), 0);
        if (g.kind === "retake" && fresh && spent + estimate > this.cfg.budgetUsd) {
          await wait(g, "waiting: daily budget ($" + spent.toFixed(2) + " spent + ~$" + estimate.toFixed(2) + " > RETAKE_DAILY_BUDGET_USD=" + this.cfg.budgetUsd + ")");
          continue;
        }
        const lock = await this.tryBookLock(g.book);
        if (!lock) {
          await wait(g, "waiting: another worker is processing " + g.book);
          continue;
        }
        const txn = g.txnId ?? newTxnId();
        await client.query(
          "UPDATE retake_jobs SET status = 'running', txn_id = $2, stage = NULL, message = 'starting', error = NULL, updated_at = now() WHERE id = ANY($1)",
          [g.jobs.map((j) => j.id), txn],
        );
        // the other photos of a retake being resumed (failed and not retried) are part of the same run
        await client.query("UPDATE retake_jobs SET status = 'running', updated_at = now() WHERE txn_id = $1 AND status = 'failed'", [txn]);
        claimed = { group: g, txn, lock };
        break;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (claimed) await this.releaseBookLock(claimed.lock, claimed.group.book);
      throw err;
    } finally {
      client.release();
    }
    if (!claimed) return false;
    try {
      await this.runGroup(claimed.group, claimed.txn);
    } finally {
      await this.releaseBookLock(claimed.lock, claimed.group.book);
    }
    return true;
  }

  private async runGroup(g: Group, txn: string): Promise<void> {
    const journal = readJournal(this.cfg.dataDir, g.book, txn);
    let args: string[];
    let itemsFile: string | undefined;
    if (journal) {
      args = ["--book", g.book, "--resume", txn, "--json"];
    } else if (g.kind === "rollback") {
      args = ["--book", g.book, "--rollback", "--page", String(g.jobs[0]!.page), "--yes", "--json", "--txn-id", txn];
    } else {
      itemsFile = path.join(os.tmpdir(), "retake-items-" + txn + ".json");
      const items = g.jobs.map((j) => ({ image: path.join(this.cfg.uploadDir, j.upload_path ?? ""), page: j.page }));
      writeFileSync(itemsFile, JSON.stringify(items));
      args = ["--book", g.book, "--items", itemsFile, "--yes", "--json", "--txn-id", txn];
    }
    this.cfg.log((journal ? "resuming " : "running ") + g.kind + " " + txn + " (" + g.book + ", pages " + g.jobs.map((j) => j.page).join(",") + ")");
    let stage: string | null = null;
    const out = await runRetake(args, this.runOpts(async (l: Line) => {
      if (l.kind === "event" && l.event.event === "stage") {
        if (l.event.state === "start") {
          stage = l.event.stage;
          await this.pool.query("UPDATE retake_jobs SET stage = $2, message = $3, updated_at = now() WHERE txn_id = $1", [txn, stage, stage + "…"]);
          await this.event({ txn }, stage, stage + " started");
        } else if (l.event.stage === "commit_pdf") {
          await this.pool.query("UPDATE retake_jobs SET pdf_committed = true, updated_at = now() WHERE txn_id = $1", [txn]);
        }
      } else if (l.kind === "log") {
        await this.pool.query("UPDATE retake_jobs SET message = $2, updated_at = now() WHERE txn_id = $1", [txn, l.line.slice(0, 500)]);
        await this.event({ txn }, stage, l.line);
      }
    }));
    if (itemsFile) rmSync(itemsFile, { force: true });

    const result = out.events.filter((e): e is Extract<RetakeEvent, { event: "result" }> => e.event === "result").at(-1);
    if (result?.status === "done") {
      for (const p of result.pages ?? []) {
        await this.pool.query(
          `UPDATE retake_jobs SET status = 'done', stage = NULL, message = $3, after = $4, cost_usd = $5,
                  before = COALESCE(before, $6), error = NULL, pdf_committed = true, updated_at = now()
            WHERE txn_id = $1 AND page = $2`,
          [txn, p.printed, (p.after?.["retake_recommended"] ? "done; still flagged for a retake" : "done"), p.after, p.cost_usd, p.before],
        );
        if (result.kind === "rollback" && result.rolled_back_txn) {
          await this.pool.query(
            "UPDATE retake_jobs SET status = 'rolled_back', message = $3, updated_at = now() WHERE kind = 'retake' AND txn_id = $1 AND page = $2 AND status = 'done'",
            [result.rolled_back_txn, p.printed, "rolled back by " + txn],
          );
        }
      }
      for (const j of g.jobs) {
        if (j.upload_path) rmSync(path.join(this.cfg.uploadDir, path.dirname(j.upload_path)), { recursive: true, force: true });
      }
      this.cfg.log("  done " + txn + (result.cost_usd ? " ($" + result.cost_usd.toFixed(3) + ")" : ""));
      return;
    }
    if (!result && this.stopping) {
      // killed by our own shutdown: stays `running`; the next worker re-queues and resumes it
      this.cfg.log("  interrupted " + txn + " by shutdown; it resumes on the next start");
      return;
    }
    const committed = result?.pdf_committed ?? Boolean(readJournal(this.cfg.dataDir, g.book, txn)?.stages["commit_pdf"]);
    const error = result?.error ?? (out.tail.slice(-3).join(" | ") || "retake.py exited " + (out.code ?? out.signal));
    await this.pool.query(
      `UPDATE retake_jobs SET status = 'failed', error = $2, message = $3, pdf_committed = pdf_committed OR $4, updated_at = now()
        WHERE txn_id = $1 AND status = 'running'`,
      [txn, error, "failed" + (result?.stage ?? stage ? " in " + (result?.stage ?? stage) : "") + (committed ? "; retry resumes it" : ""), committed],
    );
    this.cfg.log("  failed " + txn + ": " + error);
  }

  private runOpts(onLine: (l: Line) => Promise<void> | void) {
    return { python: this.cfg.python, script: this.cfg.script, cwd: this.cfg.cwd, onLine };
  }
}
