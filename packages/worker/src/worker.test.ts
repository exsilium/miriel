import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localDate, lockHolder, spentToday } from "./journals.js";
import { EMIT_PREFIX, parseLine, runRetake, type Line } from "./runner.js";
import { groupConfirmed, newTxnId, type JobRow } from "./worker.js";

function row(over: Partial<JobRow>): JobRow {
  return {
    id: "j" + Math.random().toString(16).slice(2),
    book_id: "vol1",
    page: 1,
    kind: "retake",
    status: "confirmed",
    message: null,
    upload_path: null,
    upload_name: null,
    estimate_usd: "0.14",
    txn_id: null,
    batch_id: null,
    created_at: new Date("2026-09-24T10:00:00Z"),
    ...over,
  };
}

test("parseLine: events, log lines, blanks, broken events", () => {
  assert.deepEqual(parseLine(EMIT_PREFIX + '{"event":"stage","stage":"build","state":"start"}'), {
    kind: "event",
    event: { event: "stage", stage: "build", state: "start" },
  });
  assert.deepEqual(parseLine("  ocrmypdf over 1 page(s)\r"), { kind: "log", line: "  ocrmypdf over 1 page(s)" });
  assert.equal(parseLine("   "), undefined);
  assert.deepEqual(parseLine(EMIT_PREFIX + "{not json"), { kind: "log", line: EMIT_PREFIX + "{not json" });
});

test("groupConfirmed: batches together, rollbacks alone, retries by txn, oldest first", () => {
  const t = (m: number): Date => new Date(Date.UTC(2026, 8, 24, 10, m));
  const rows = [
    row({ id: "b2", batch_id: "B", page: 24, created_at: t(2) }),
    row({ id: "rb", kind: "rollback", page: 12, created_at: t(1) }),
    row({ id: "b1", batch_id: "B", page: 22, created_at: t(3) }),
    row({ id: "other-book", book_id: "vol2", batch_id: "B", created_at: t(4) }),
    row({ id: "single", created_at: t(5) }),
    row({ id: "retry1", txn_id: "rt-x", batch_id: "C", created_at: t(0) }),
    row({ id: "retry2", txn_id: "rt-x", batch_id: "C", created_at: t(6) }),
  ];
  const groups = groupConfirmed(rows).map((g) => [g.kind, g.book, g.txnId, g.jobs.map((j) => j.id)]);
  assert.deepEqual(groups, [
    ["retake", "vol1", "rt-x", ["retry1", "retry2"]],
    ["rollback", "vol1", null, ["rb"]],
    ["retake", "vol1", null, ["b2", "b1"]],
    ["retake", "vol2", null, ["other-book"]],
    ["retake", "vol1", null, ["single"]],
  ]);
});

test("newTxnId has the shape retake.py accepts", () => {
  assert.match(newTxnId(new Date(2026, 8, 24, 9, 5, 7)), /^rt-20260924-090507-[0-9a-f]{4}$/);
});

test("spentToday sums today's journals of every book; lockHolder reads the lock file", () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "worker-test-"));
  const now = new Date(2026, 8, 24, 12, 0, 0);
  const today = localDate(now);
  for (const [book, id, created, cost] of [
    ["vol1", "rt-a", today + "T09:00:00+00:00", 0.12],
    ["vol1", "rt-b", "2026-09-23T23:00:00+00:00", 5],
    ["vol2", "rt-c", today + "T10:00:00+00:00", 0.3],
  ] as const) {
    mkdirSync(path.join(data, "_versions", "retakes", book), { recursive: true });
    writeFileSync(path.join(data, "_versions", "retakes", book, id + ".json"), JSON.stringify({ id, book, created, cost_usd: cost }));
  }
  writeFileSync(path.join(data, "_versions", "retakes", "vol1", "broken.json"), "{");
  assert.equal(Math.round(spentToday(data, now) * 100) / 100, 0.42);
  assert.equal(lockHolder(data, "vol1"), undefined);
  writeFileSync(path.join(data, "_versions", "vol1.lock"), "rt-a\n");
  assert.equal(lockHolder(data, "vol1"), "rt-a");
});

test("runRetake streams log lines and events in order and reports the exit code", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-run-"));
  const script = path.join(dir, "fake.mjs");
  writeFileSync(
    script,
    [
      "console.log('validating 1 photo(s)');",
      `console.log(${JSON.stringify(EMIT_PREFIX)} + JSON.stringify({ event: 'stage', stage: 'build', state: 'start' }));`,
      "console.error('a warning on stderr');",
      `console.log(${JSON.stringify(EMIT_PREFIX)} + JSON.stringify({ event: 'result', txn: 'rt-x', kind: 'retake', status: 'failed', error: 'boom' }));`,
      "process.exit(3);",
    ].join("\n"),
  );
  const seen: Line[] = [];
  const out = await runRetake(["--x"], {
    python: process.execPath,
    script,
    cwd: dir,
    onLine: async (l) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(l);
    },
  });
  assert.equal(out.code, 3);
  assert.deepEqual(out.events.map((e) => e.event), ["stage", "result"]);
  assert.deepEqual(out.tail.sort(), ["a warning on stderr", "validating 1 photo(s)"]);
  assert.equal(seen.length, 4);
  assert.equal(seen[0]!.kind, "log");
});
