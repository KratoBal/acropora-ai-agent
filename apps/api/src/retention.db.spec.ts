import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * THE RETENTION SQL AGAINST A REAL POSTGRES (slice 4b, card f5b8f7ba; rows S1, S2, S15 of the plan).
 *
 * `retention.spec.ts` measures the job around the SQL with a recording client; this one measures the SQL. Like the other database
 * spec it needs a throwaway EMPTY database and is skipped without one (CI has none, by design: see ci.yml):
 * AI_RETENTION_DB_URL=postgres://... (its OWN variable and its own database: `node --test` runs the spec files in parallel, and the ownership spec's `AI_CONVERSATIONS_DB_URL` database is being created and emptied at the same time). It creates the schema, REFUSES to run if any of its tables already holds a row, and truncates them after each test.
 *
 * What turns it red: `<=` instead of `<` (the row exactly at the boundary goes); the aggregate written after the delete (the ratings
 * are gone before they are counted); the aggregate overwritten instead of added to; a conversation deleted while it still holds a
 * newer message, or while it is young and still empty; a delete that does not wait for the lock.
 */
const url = process.env.AI_RETENTION_DB_URL;

describe("the retention job in Postgres", { skip: url ? false : "AI_RETENTION_DB_URL is not set" }, () => {
  let db: typeof import("./db.js");
  let job: typeof import("./retention.js");
  const NOW = new Date("2026-11-11T10:00:00.000Z");
  const DAYS = 30;
  const CUTOFF = new Date(NOW.getTime() - DAYS * 86_400_000); // 2026-10-12: the October fixtures below are all older than this
  const at = (offsetMs: number) => new Date(CUTOFF.getTime() + offsetMs);

  before(async () => {
    process.env.DATABASE_URL = url;
    db = await import("./db.js");
    job = await import("./retention.js");
    await db.pool.query(db.SCHEMA_SQL);
    // The spec TRUNCATES the tables it uses. It refuses to start on a database that already holds anything: the variable must
    // never be pointed at data.
    for (const table of ["conversations", "messages", "answer_ratings", "rating_aggregates"]) {
      const held = Number((await db.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
      if (held > 0) throw new Error(`refusing to run: ${table} already holds rows, this is not a throwaway database`);
    }
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE rating_aggregates, answer_ratings, messages, conversations CASCADE");
  });

  after(async () => {
    if (db) {
      await db.pool.query("TRUNCATE rating_aggregates, answer_ratings, messages, conversations CASCADE");
      await db.pool.end();
    }
  });

  async function conversation(updatedAt: Date): Promise<string> {
    const r = await db.pool.query<{ id: string }>(
      "INSERT INTO conversations (client_key, subject, created_at, updated_at) VALUES ('k', 'anonymous', $1, $1) RETURNING id",
      [updatedAt]
    );
    return r.rows[0].id;
  }
  async function message(conversationId: string, createdAt: Date, role = "assistant"): Promise<string> {
    const r = await db.pool.query<{ id: string }>(
      "INSERT INTO messages (conversation_id, role, content, created_at) VALUES ($1, $2, 'szöveg', $3) RETURNING id",
      [conversationId, role, createdAt]
    );
    return r.rows[0].id;
  }
  async function rate(messageId: string, axis: string, rating: string, by = "r1") {
    await db.pool.query("INSERT INTO answer_ratings (message_id, axis, rating, rated_by) VALUES ($1, $2, $3, $4)", [messageId, axis, rating, by]);
  }
  const count = async (table: string) => Number((await db.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

  it("S1: the row exactly N days old STAYS, one second older goes, one second younger stays", async () => {
    const c = await conversation(at(-1000));
    const older = await message(c, at(-1000));
    const exact = await message(c, at(0));
    const younger = await message(c, at(1000));
    const result = await job.runRetentionOnce(db.pool, NOW, DAYS);
    const left = (await db.pool.query<{ id: string }>("SELECT id FROM messages")).rows.map((r) => r.id).sort();
    assert.deepEqual(left, [exact, younger].sort());
    assert.equal(left.includes(older), false);
    assert.equal(result?.messages, 1);
  });

  it("a conversation goes only when it is old AND empty", async () => {
    const oldEmptied = await conversation(at(-1000)); // its only message is old: it is empty after the delete
    await message(oldEmptied, at(-1000));
    const oldWithNewer = await conversation(at(-1000)); // an old conversation that still has a newer message
    await message(oldWithNewer, at(1000));
    const youngEmpty = await conversation(at(1000)); // just created, no message saved yet
    await job.runRetentionOnce(db.pool, NOW, DAYS);
    const left = (await db.pool.query<{ id: string }>("SELECT id FROM conversations")).rows.map((r) => r.id).sort();
    assert.deepEqual(left, [oldWithNewer, youngEmpty].sort());
  });

  it("S15: the ratings of the deleted messages are COUNTED per month, axis and value first, the newer ones are untouched", async () => {
    const c = await conversation(at(-1000));
    const octoberA = await message(c, new Date("2026-10-03T08:00:00Z"));
    const octoberB = await message(c, new Date("2026-10-08T08:00:00Z"));
    const septemberA = await message(c, new Date("2026-09-30T23:00:00Z"));
    const keep = await message(c, at(5000));
    await rate(octoberA, "accuracy", "correct");
    await rate(octoberA, "language", "natural");
    await rate(octoberB, "accuracy", "correct");
    await rate(septemberA, "accuracy", "inaccurate");
    await rate(keep, "accuracy", "correct");
    const result = await job.runRetentionOnce(db.pool, NOW, DAYS);
    const rows = (await db.pool.query("SELECT to_char(month, 'YYYY-MM') AS m, axis, rating, ratings FROM rating_aggregates ORDER BY 1, 2, 3")).rows;
    assert.deepEqual(rows, [
      { m: "2026-09", axis: "accuracy", rating: "inaccurate", ratings: 1 },
      { m: "2026-10", axis: "accuracy", rating: "correct", ratings: 2 },
      { m: "2026-10", axis: "language", rating: "natural", ratings: 1 }
    ]);
    assert.equal(result?.ratingsAggregated, 3, "three aggregate rows written");
    assert.equal(await count("answer_ratings"), 1, "only the newer message's rating is left");
  });

  it("S15/S2: a second run adds nothing (idempotent), and a later run ADDS to the month's count, it does not overwrite it", async () => {
    const c = await conversation(at(-1000));
    const first = await message(c, new Date("2026-10-03T08:00:00Z"));
    await rate(first, "accuracy", "correct");
    await job.runRetentionOnce(db.pool, NOW, DAYS);
    const again = await job.runRetentionOnce(db.pool, NOW, DAYS);
    assert.deepEqual(again, { messages: 0, conversations: 0, ratingsAggregated: 0 });
    assert.equal(Number((await db.pool.query("SELECT ratings FROM rating_aggregates")).rows[0].ratings), 1);

    const c2 = await conversation(at(-1000));
    const second = await message(c2, new Date("2026-10-09T08:00:00Z"));
    await rate(second, "accuracy", "correct");
    await job.runRetentionOnce(db.pool, NOW, DAYS);
    assert.equal(Number((await db.pool.query("SELECT ratings FROM rating_aggregates")).rows[0].ratings), 2);
  });

  it("S2: an empty database is no error", async () => {
    assert.deepEqual(await job.runRetentionOnce(db.pool, NOW, DAYS), { messages: 0, conversations: 0, ratingsAggregated: 0 });
  });

  it("a conversation that is being CONTINUED is not deleted from under the save (barracuda's race note on #72)", async () => {
    // Conversation and message are 40 days old and the job keeps 30: exactly what it deletes. The customer's next message arrives
    // first: the ownership check marks the conversation as in use (updated_at = now), and the job leaves it. Without the mark the
    // next INSERT fails on the foreign key. This test uses the real clock (the mark is the database's NOW()).
    const conversations = await import("./conversations.js");
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
    const c = await conversation(fortyDaysAgo);
    await message(c, fortyDaysAgo);
    assert.equal(await conversations.conversationBelongsToClient(c, "k", "anonymous"), true);
    const result = await job.runRetentionOnce(db.pool, new Date(), DAYS);
    assert.equal(result?.messages, 1, "the old message goes");
    assert.equal(await count("conversations"), 1, "the continued conversation stays");
    await conversations.saveMessage({ conversationId: c, role: "user", content: "új üzenet" });
    assert.equal(await count("messages"), 1, "the new message is saved");
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("the job is ALREADY in its DELETE when the customer's check arrives: the check waits for the row lock, then sees no row (false), not a foreign key error", async () => {
    // The two statements of the job are run by hand inside an open transaction, so the lock is held while the check runs.
    const conversations = await import("./conversations.js");
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
    const cutoff = new Date(Date.now() - DAYS * 86_400_000);
    const c = await conversation(fortyDaysAgo);
    await message(c, fortyDaysAgo);
    const job = await db.pool.connect();
    try {
      await job.query("BEGIN");
      await job.query("DELETE FROM messages WHERE created_at < $1", [cutoff]);
      const deleted = await job.query("DELETE FROM conversations c WHERE c.updated_at < $1 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)", [cutoff]);
      assert.equal(deleted.rowCount, 1, "the job's delete holds the conversation's row lock");
      let settled = false;
      const check = conversations.conversationBelongsToClient(c, "k", "anonymous").then((value) => {
        settled = true;
        return value;
      });
      await sleep(300);
      assert.equal(settled, false, "the check WAITS for the lock");
      await job.query("COMMIT");
      assert.equal(await check, false, "after the delete the conversation is gone: the route answers 'not found', it does not insert");
    } finally {
      job.release();
    }
  });

  it("the customer's check is ALREADY running when the job reaches the conversation: the job waits, then leaves it (the row is young now)", async () => {
    const conversations = await import("./conversations.js");
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
    const c = await conversation(fortyDaysAgo);
    await message(c, fortyDaysAgo);
    const check = await db.pool.connect();
    try {
      await check.query("BEGIN");
      await check.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND client_key = 'k' AND subject = 'anonymous' RETURNING 1", [c]);
      let finished = false;
      const run = job.runRetentionOnce(db.pool, new Date(), DAYS).then((result) => {
        finished = true;
        return result;
      });
      await sleep(300);
      assert.equal(finished, false, "the job WAITS for the conversation's row lock");
      await check.query("COMMIT");
      await run;
      assert.equal(await count("conversations"), 1, "the conversation the customer is continuing stays");
      await conversations.saveMessage({ conversationId: c, role: "user", content: "új üzenet" });
    } finally {
      check.release();
    }
  });

  it("a conversation that is NOT continued is still deleted when old and empty (the control)", async () => {
    const conversations = await import("./conversations.js");
    const c = await conversation(at(-1000));
    await message(c, at(-1000));
    assert.equal(await conversations.conversationBelongsToClient(c, "other", "anonymous"), false);
    assert.equal(await conversations.conversationBelongsToClient(c, "k", "someone-else"), false);
    await job.runRetentionOnce(db.pool, NOW, DAYS);
    assert.equal(await count("conversations"), 0);
  });

    it("another instance holds the lock: nothing is deleted and the answer is null", async () => {
    const c = await conversation(at(-1000));
    await message(c, at(-1000));
    const holder = await db.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1)", [job.ADVISORY_LOCK_KEY]);
      assert.equal(await job.runRetentionOnce(db.pool, NOW, DAYS), null);
      assert.equal(await count("messages"), 1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });
});
