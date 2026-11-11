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
  resolveRetentionDays,
  retentionPass,
  runRetentionOnce,
  type RetentionClient,
  type RetentionPool
} from "./retention.js";
import { SCHEMA_SQL } from "./db.js";
import { CHAT_SETTINGS_TOKEN_ENV } from "./chat-settings.js";

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

function recordingPool(
  options: { locked?: boolean; failAt?: string; rowCounts?: Record<string, number>; lastKnown?: number | null } = {}
) {
  const calls: Call[] = [];
  let released = 0;
  const client: RetentionClient = {
    async query(text, values) {
      calls.push({ text, values });
      if (options.failAt && text.includes(options.failAt)) throw Object.assign(new Error("boom: secret-row-value"), { code: "23503" });
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: options.locked ?? true }], rowCount: 1 };
      if (text.includes("FROM chat_settings_last_known"))
        return options.lastKnown == null
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{ message_retention_days: options.lastKnown, offer_enabled: false, contact_request_enabled: false }],
              rowCount: 1
            };
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

  it("S3: a finished run logs the day count, where it came from and three numbers", async () => {
    const { log, lines } = recordingLog();
    const { pool } = recordingPool({ rowCounts: { "FROM messages WHERE": 4 } });
    await retentionPass(pool, log, on("90"), NOW);
    assert.deepEqual(lines.map((l) => l.payload), [{ retention: { days: 90, origin: "env", messages: 4, conversations: 0, ratingsAggregated: 0 } }]);
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

/*
  WHERE THE DAYS COME FROM (plan 2/1, S10; acrobot 46747): the OS's setting, the last one it read when the OS does not answer, and a
  SKIP (never a code default) when there is neither.
*/
const withOs = (days?: string): NodeJS.ProcessEnv => ({
  ...on(days),
  ACROPORA_OS_BASE_URL: "http://os.invalid",
  [CHAT_SETTINGS_TOKEN_ENV]: "settings-token"
});
const osAnswers = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });
const osDown: typeof fetch = async () => {
  throw Object.assign(new Error("down"), { name: "TypeError" });
};
const view = (days: number) => ({ offerEnabled: false, contactRequestEnabled: false, messageRetentionDays: days });

describe("resolveRetentionDays", () => {
  it("the switch is the master: off means off, whatever the OS says", async () => {
    const { pool, calls } = recordingPool();
    assert.deepEqual(
      await resolveRetentionDays(pool, { ...withOs(), [RETENTION_ENV]: "false" }, osAnswers(view(30))),
      { skip: "switch_off" }
    );
    assert.equal(calls.length, 0);
  });

  it("no OS source configured: the days are the environment's, exactly as in 4b", async () => {
    const { pool } = recordingPool();
    assert.deepEqual(await resolveRetentionDays(pool, on("90")), { days: 90, origin: "env" });
    assert.deepEqual(await resolveRetentionDays(pool, on("1000")), { skip: "invalid_days" });
  });

  it("the OS answers: its days win over the environment's (even an illegal environment value is ignored), and the value is KEPT as the last known", async () => {
    const { pool, calls } = recordingPool();
    const resolved = await resolveRetentionDays(pool, withOs("1000"), osAnswers(view(365)));
    assert.deepEqual(resolved, { days: 365, origin: "os" });
    const kept = calls.find((c) => c.text.includes("INSERT INTO chat_settings_last_known"));
    assert.deepEqual(kept?.values, [365, false, false]);
  });

  it("S10: the OS does not answer and the last known value was 365: the run goes on 365, NOT on a code default of 180", async () => {
    for (const fetchImpl of [osDown, osAnswers({}, 500), osAnswers({}, 401), osAnswers({ nonsense: true })]) {
      const { pool } = recordingPool({ lastKnown: 365 });
      const resolved = await resolveRetentionDays(pool, withOs(), fetchImpl);
      assert.equal("days" in resolved && resolved.days, 365);
      assert.equal("origin" in resolved && resolved.origin, "last_known");
      assert.ok("note" in resolved && resolved.note?.startsWith("chat_settings_"));
    }
  });

  it("S10: the OS does not answer and nothing was ever read: the run is SKIPPED and named", async () => {
    const { pool } = recordingPool({ lastKnown: null });
    assert.deepEqual(await resolveRetentionDays(pool, withOs(), osDown), {
      skip: "settings_unavailable",
      note: "chat_settings_unavailable"
    });
  });

  it("a last-known row the contract does not allow is not repaired: it counts as nothing", async () => {
    const { pool } = recordingPool({ lastKnown: 3 });
    assert.equal("skip" in (await resolveRetentionDays(pool, withOs(), osDown)), true);
  });

  it("an OS value outside 7..365 is a bad response: the last known value is used, the illegal one never", async () => {
    const { pool } = recordingPool({ lastKnown: 200 });
    const resolved = await resolveRetentionDays(pool, withOs(), osAnswers(view(3)));
    assert.equal("days" in resolved && resolved.days, 200);
  });
});

describe("the pass with the OS as the source", () => {
  function logs() {
    const lines: Array<Record<string, unknown>> = [];
    return { lines, log: { info: (p: Record<string, unknown>) => lines.push(p), error: (p: Record<string, unknown>) => lines.push(p) } };
  }

  it("deletes with the OS's days and logs where they came from", async () => {
    const { pool, calls } = recordingPool({ rowCounts: { "FROM messages WHERE": 2 } });
    const { log, lines } = logs();
    await retentionPass(pool, log, withOs(), NOW, osAnswers(view(60)));
    const cutoff = new Date(NOW.getTime() - 60 * 86_400_000).getTime();
    const del = calls.find((c) => c.text.includes("DELETE FROM messages"));
    assert.equal((del?.values?.[0] as Date).getTime(), cutoff);
    assert.deepEqual(lines, [{ retention: { days: 60, origin: "os", messages: 2, conversations: 0, ratingsAggregated: 0 } }]);
  });

  it("S10 end to end: the OS is down, the last known value is 365: the cutoff is 365 days back, nothing newer is touched", async () => {
    const { pool, calls } = recordingPool({ lastKnown: 365 });
    const { log, lines } = logs();
    await retentionPass(pool, log, withOs("180"), NOW, osDown);
    const del = calls.find((c) => c.text.includes("DELETE FROM messages"));
    assert.equal((del?.values?.[0] as Date).getTime(), NOW.getTime() - 365 * 86_400_000);
    assert.deepEqual(lines[0], {
      retention: { days: 365, origin: "last_known", settings: "chat_settings_unavailable", messages: 0, conversations: 0, ratingsAggregated: 0 }
    });
  });

  it("S10 end to end: the OS is down and nothing was read: NO statement deletes, and the skip names the OS code", async () => {
    const { pool, calls } = recordingPool({ lastKnown: null });
    const { log, lines } = logs();
    await retentionPass(pool, log, withOs(), NOW, osDown);
    assert.equal(calls.some((c) => c.text.includes("DELETE")), false);
    assert.deepEqual(lines, [{ retention: "retention_skipped", reason: "settings_unavailable", settings: "chat_settings_unavailable" }]);
  });

  it("the log never holds the token", async () => {
    const { pool } = recordingPool({ lastKnown: null });
    const { log, lines } = logs();
    await retentionPass(pool, log, withOs(), NOW, osDown);
    assert.equal(JSON.stringify(lines).includes("settings-token"), false);
  });
});
