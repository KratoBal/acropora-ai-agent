import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGGREGATE_RATINGS_SQL,
  DEFAULT_RETENTION_DAYS,
  DELETE_CONVERSATIONS_SQL,
  DELETE_MESSAGES_SQL,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_DAYS_ENV,
  RETENTION_ENV,
  retentionConfig,
  retentionPass,
  runRetentionOnce,
  type RetentionClient,
  type RetentionPool
} from "./retention.js";
import { SCHEMA_SQL } from "./db.js";

/*
  THE RETENTION JOB WITHOUT A DATABASE (plan rows S1-S3, S10, S15, K1 of slice 4b): the setting, the order of the statements, the
  cutoff, the transaction, the log line. The SQL itself is measured against a real Postgres in `retention.db.spec.ts` (skipped without
  one, like the other database spec).
*/
const on = (days?: string): NodeJS.ProcessEnv => ({
  [RETENTION_ENV]: "true",
  ...(days === undefined ? {} : { [RETENTION_DAYS_ENV]: days })
});

describe("the retention setting (rows S4 and S10: a value it does not trust makes the job skip, never guess)", () => {
  it("is off unless the switch is exactly `true`", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", " true"])
      assert.deepEqual(retentionConfig({ [RETENTION_ENV]: value }), { run: false, reason: "switch_off" }, String(value));
  });

  it("empty days mean the proposed default, a legal number is taken as given", () => {
    assert.deepEqual(retentionConfig(on()), { run: true, days: DEFAULT_RETENTION_DAYS });
    assert.deepEqual(retentionConfig(on("")), { run: true, days: DEFAULT_RETENTION_DAYS });
    assert.deepEqual(retentionConfig(on("365")), { run: true, days: 365 });
    assert.deepEqual(retentionConfig(on(" 30 ")), { run: true, days: 30 });
    assert.equal(DEFAULT_RETENTION_DAYS, 180);
  });

  it("an illegal number SKIPS the run: not clamped, not rounded", () => {
    for (const value of ["0", "6", "366", "1000", "-30", "30.5", "abc", "30d", "1e2"])
      assert.deepEqual(retentionConfig(on(value)), { run: false, reason: "invalid_days" }, value);
    assert.equal(MIN_RETENTION_DAYS, 7);
    assert.equal(MAX_RETENTION_DAYS, 365);
  });
});

interface Call {
  text: string;
  values?: unknown[];
}

function recordingPool(options: { locked?: boolean; failAt?: string; rowCounts?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  let released = 0;
  const client: RetentionClient = {
    async query(text, values) {
      calls.push({ text, values });
      if (options.failAt && text.includes(options.failAt)) throw Object.assign(new Error("boom: secret-row-value"), { code: "23503" });
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: options.locked ?? true }], rowCount: 1 };
      const count = Object.entries(options.rowCounts ?? {}).find(([needle]) => text.includes(needle))?.[1] ?? 0;
      return { rows: [], rowCount: count };
    },
    release() {
      released += 1;
    }
  };
  const pool: RetentionPool = { async connect() { return client; } };
  return { pool, calls, released: () => released };
}

const NOW = new Date("2026-11-11T10:00:00.000Z");

describe("one run of the retention job", () => {
  it("S1 (the cutoff): exactly N days before `now`, the same value in all three statements", async () => {
    const { pool, calls } = recordingPool();
    await runRetentionOnce(pool, NOW, 180);
    const cutoff = new Date("2026-05-15T10:00:00.000Z");
    const statements = calls.filter((c) => c.values && c.values[0] instanceof Date);
    assert.equal(statements.length, 3);
    for (const call of statements) assert.equal((call.values![0] as Date).getTime(), cutoff.getTime());
  });

  it("the ratings are counted BEFORE their messages are deleted, all in one transaction", async () => {
    const { pool, calls } = recordingPool();
    await runRetentionOnce(pool, NOW, 30);
    const order = calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(" "));
    assert.deepEqual(order, [
      "BEGIN",
      "SELECT pg_try_advisory_xact_lock($1)",
      "INSERT INTO",
      "DELETE FROM",
      "DELETE FROM",
      "COMMIT"
    ]);
    assert.ok(calls[2].text.includes("rating_aggregates"));
    assert.ok(calls[3].text.includes("messages"));
    assert.ok(calls[4].text.includes("conversations"));
  });

  it("the delete compares with `<`, never `<=`: a row exactly N days old stays", () => {
    for (const sql of [AGGREGATE_RATINGS_SQL, DELETE_MESSAGES_SQL, DELETE_CONVERSATIONS_SQL]) {
      assert.match(sql, /< \$1/);
      assert.equal(/<= \$1/.test(sql), false);
    }
  });

  it("S2: it returns the row counts, and an empty database is no error", async () => {
    const { pool } = recordingPool({ rowCounts: { "INSERT INTO": 2, "FROM messages WHERE": 7, "FROM conversations": 3 } });
    assert.deepEqual(await runRetentionOnce(pool, NOW, 30), { messages: 7, conversations: 3, ratingsAggregated: 2 });
    assert.deepEqual(await runRetentionOnce(recordingPool().pool, NOW, 30), { messages: 0, conversations: 0, ratingsAggregated: 0 });
  });

  it("another instance holds the lock: nothing is deleted, the transaction is rolled back, the answer is null", async () => {
    const { pool, calls } = recordingPool({ locked: false });
    assert.equal(await runRetentionOnce(pool, NOW, 30), null);
    assert.equal(calls.some((c) => c.text.includes("DELETE")), false);
    assert.equal(calls.at(-1)?.text, "ROLLBACK");
  });

  it("a failure rolls back (the aggregate does not stay without the delete) and the client is released", async () => {
    const { pool, calls, released } = recordingPool({ failAt: "DELETE FROM messages" });
    await assert.rejects(() => runRetentionOnce(pool, NOW, 30));
    assert.equal(calls.at(-1)?.text, "ROLLBACK");
    assert.equal(calls.some((c) => c.text === "COMMIT"), false);
    assert.equal(released(), 1);
  });
});

describe("the pass the scheduler runs: only numbers and reason codes are logged", () => {
  function recordingLog() {
    const lines: Array<{ level: string; payload: Record<string, unknown> }> = [];
    return {
      lines,
      log: {
        info: (payload: Record<string, unknown>) => lines.push({ level: "info", payload }),
        error: (payload: Record<string, unknown>) => lines.push({ level: "error", payload })
      }
    };
  }

  it("S3: a finished run logs the day count and three numbers", async () => {
    const { log, lines } = recordingLog();
    const { pool } = recordingPool({ rowCounts: { "FROM messages WHERE": 4 } });
    await retentionPass(pool, log, on("90"), NOW);
    assert.deepEqual(lines.map((l) => l.payload), [{ retention: { days: 90, messages: 4, conversations: 0, ratingsAggregated: 0 } }]);
  });

  it("off: silent and nothing is touched; an illegal value: named, and nothing is touched (S10)", async () => {
    const off = recordingPool();
    const offLog = recordingLog();
    await retentionPass(off.pool, offLog.log, {}, NOW);
    assert.equal(off.calls.length, 0);
    assert.equal(offLog.lines.length, 0);

    const bad = recordingPool();
    const badLog = recordingLog();
    await retentionPass(bad.pool, badLog.log, on("1000"), NOW);
    assert.equal(bad.calls.length, 0);
    assert.deepEqual(badLog.lines.map((l) => l.payload), [{ retention: "retention_skipped", reason: "invalid_days" }]);
  });

  it("a failure logs a code, never the error's own text (it may carry a row value)", async () => {
    const { log, lines } = recordingLog();
    await retentionPass(recordingPool({ failAt: "DELETE FROM messages" }).pool, log, on("30"), NOW);
    assert.deepEqual(lines.map((l) => l.payload), [{ retention: "retention_failed", code: "23503" }]);
    assert.equal(JSON.stringify(lines).includes("secret-row-value"), false);
  });

  it("a lock held elsewhere is a named skip, not a failure", async () => {
    const { log, lines } = recordingLog();
    await retentionPass(recordingPool({ locked: false }).pool, log, on("30"), NOW);
    assert.deepEqual(lines.map((l) => l.payload), [{ retention: "retention_skipped", reason: "locked" }]);
  });
});

describe("the schema of what the job keeps", () => {
  it("rating_aggregates holds counts per month, axis and value and no text or identifier column", () => {
    const table = /CREATE TABLE IF NOT EXISTS rating_aggregates \(([\s\S]*?)\n    \);/.exec(SCHEMA_SQL)?.[1] ?? "";
    assert.ok(table, "the table is in the schema");
    const columns = table
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((word) => /^[a-z_]+$/.test(word) && word !== "primary");
    assert.deepEqual(columns, ["month", "axis", "rating", "ratings"]);
  });
});
