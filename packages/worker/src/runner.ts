/**
 * Runs scripts/retake.py with --json and turns its output into events. The script prints ordinary progress lines
 * plus "::retake:: {json}" lines (stage start/done, the validation plan, the final result).
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

export const EMIT_PREFIX = "::retake:: ";

export interface PlanItem {
  source: string;
  printed: number | null;
  image_no?: number;
  match: string;
  folio?: string;
  errors: string[];
  warnings: string[];
  notes: string[];
  sha256?: string;
  size?: [number, number];
  before?: Record<string, unknown> | null;
}

export interface ResultPage {
  printed: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  text_chars: [number, number] | null;
  cost_usd: number;
}

export type RetakeEvent =
  | { event: "stage"; stage: string; state: "start" | "done" }
  | { event: "plan"; per_page_usd: number; items: PlanItem[] }
  | {
      event: "result";
      txn: string;
      kind: "retake" | "rollback";
      status: "done" | "failed";
      stage?: string;
      error?: string;
      pdf_committed?: boolean;
      cost_usd?: number;
      rolled_back_txn?: string | null;
      pages?: ResultPage[];
    };

export type Line = { kind: "event"; event: RetakeEvent } | { kind: "log"; line: string };

/** One output line of retake.py: an event, a log line, or nothing (blank / unparseable event). */
export function parseLine(raw: string): Line | undefined {
  const line = raw.replace(/\s+$/, "");
  if (!line.trim()) return undefined;
  if (line.startsWith(EMIT_PREFIX)) {
    try {
      const event = JSON.parse(line.slice(EMIT_PREFIX.length)) as RetakeEvent;
      if (event && typeof event === "object" && typeof event.event === "string") return { kind: "event", event };
    } catch {
      /* fall through: report it as a log line */
    }
  }
  return { kind: "log", line };
}

export interface RunOptions {
  python: string;
  script: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called in output order; the next line waits for the previous callback. */
  onLine: (line: Line) => Promise<void> | void;
}

export interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  events: RetakeEvent[];
  /** Last log lines, for error messages. */
  tail: string[];
}

let current: ReturnType<typeof spawn> | undefined;

/** Terminate the running retake.py (worker shutdown); its journal lets the next worker resume. */
export function killCurrent(): void {
  current?.kill("SIGTERM");
}

export function runRetake(args: string[], opts: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.python, [opts.script, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    current = child;
    const events: RetakeEvent[] = [];
    const tail: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    let failed: unknown;
    const feed = (raw: string): void => {
      const parsed = parseLine(raw);
      if (!parsed) return;
      if (parsed.kind === "event") events.push(parsed.event);
      else {
        tail.push(parsed.line);
        if (tail.length > 20) tail.shift();
      }
      chain = chain.then(() => opts.onLine(parsed)).catch((err: unknown) => {
        failed ??= err;
      });
    };
    let open = 2;
    const closed = (): void => {
      open -= 1;
    };
    for (const stream of [child.stdout, child.stderr]) {
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", feed);
      rl.on("close", closed);
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      current = undefined;
      const finish = (): void => {
        void chain.then(() => (failed ? reject(failed) : resolve({ code, signal, events, tail })));
      };
      // readline may still flush its last lines after "close" on the process
      if (open <= 0) finish();
      else setImmediate(finish);
    });
  });
}
