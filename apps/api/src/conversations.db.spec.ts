import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * The ownership SQL in conversations.ts, against a real Postgres (card
 * a3e0327f).
 *
 * The route test drives a stand-in store; this one measures the query the
 * stand-in imitates. It needs a throwaway database and is skipped without one
 * (CI has none): AI_CONVERSATIONS_DB_URL=postgres://... on an EMPTY database,
 * because it creates the schema and drops the rows it wrote.
 *
 * What turns it red: the subject not compared; a NULL (pre-column) row matched
 * by anyone; the column missing from the schema an existing database gets.
 */
const url = process.env.AI_CONVERSATIONS_DB_URL;

describe("conversation ownership in Postgres", { skip: url ? false : "AI_CONVERSATIONS_DB_URL is not set" }, () => {
  let mod: typeof import("./conversations.js");
  let db: typeof import("./db.js");
  const written: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = url;
    db = await import("./db.js");
    mod = await import("./conversations.js");
    // An existing database from before the column: the table without it, then the schema run.
    await db.pool.query(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), client_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    const legacy = await db.pool.query<{ id: string }>(
      "INSERT INTO conversations (client_key) VALUES ('k') RETURNING id"
    );
    written.push(legacy.rows[0].id);
    await db.pool.query(db.SCHEMA_SQL);
  });

  after(async () => {
    if (db) {
      await db.pool.query("DELETE FROM conversations WHERE id = ANY($1::uuid[])", [written]);
      await db.pool.end();
    }
  });

  it("matches only the same client AND the same subject; a pre-column row matches nobody", async () => {
    const a = await mod.createConversation("k", "customer:cus_A");
    const anon = await mod.createConversation("k", "anonymous");
    written.push(a, anon);
    const [legacy] = written;

    assert.equal(await mod.conversationBelongsToClient(a, "k", "customer:cus_A"), true);
    assert.equal(await mod.conversationBelongsToClient(a, "k", "customer:cus_B"), false);
    assert.equal(await mod.conversationBelongsToClient(a, "k", "anonymous"), false);
    assert.equal(await mod.conversationBelongsToClient(a, "other", "customer:cus_A"), false);
    assert.equal(await mod.conversationBelongsToClient(anon, "k", "anonymous"), true);
    assert.equal(await mod.conversationBelongsToClient(anon, "k", "customer:cus_A"), false);
    for (const subject of ["anonymous", "customer:cus_A", ""]) {
      assert.equal(await mod.conversationBelongsToClient(legacy, "k", subject), false, subject);
    }
  });
});
