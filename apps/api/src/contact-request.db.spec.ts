import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * THE `local_kind` COLUMN AND THE MASKING UPDATE AGAINST A REAL POSTGRES (slice 4c, card f5b8f7ba; plan rows S7 and the offer flag).
 *
 * The route spec drives a stand-in store; this one measures the SQL the stand-in imitates. Like the other database specs it needs a
 * throwaway EMPTY database and is skipped without one (CI has none, by design): AI_CONTACT_DB_URL=postgres://... (its OWN variable and
 * database: `node --test` runs the spec files in parallel). It creates the schema, REFUSES to run if its tables already hold a row, and
 * truncates them after each test.
 *
 * What turns it red: the column missing from the schema a database from before it gets (and the schema failing a second time); the
 * flag not stored or not read back with the history; the flag leaking onto other rows; the masking touching an assistant row, another
 * message, or not the text it was given.
 */
const url = process.env.AI_CONTACT_DB_URL;

describe("the contact flag and the masking update in Postgres", { skip: url ? false : "AI_CONTACT_DB_URL is not set" }, () => {
  let db: typeof import("./db.js");
  let mod: typeof import("./conversations.js");

  before(async () => {
    process.env.DATABASE_URL = url;
    db = await import("./db.js");
    mod = await import("./conversations.js");
    // A database from before the column: the old table, then the schema run (twice: the statement must be repeatable).
    await db.pool.query(
      "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE IF NOT EXISTS conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), client_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    await db.pool.query(
      "CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
    );
    for (const table of ["conversations", "messages"]) {
      const held = Number((await db.pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
      if (held > 0) throw new Error(`refusing to run: ${table} already holds rows, this is not a throwaway database`);
    }
    await db.pool.query(db.SCHEMA_SQL);
    await db.pool.query(db.SCHEMA_SQL);
  });

  beforeEach(async () => {
    await db.pool.query("TRUNCATE messages, conversations CASCADE");
  });

  after(async () => {
    if (db) {
      await db.pool.query("TRUNCATE messages, conversations CASCADE");
      await db.pool.end();
    }
  });

  it("an existing database gets the column from the schema run, and the run can repeat", async () => {
    const column = await db.pool.query(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'local_kind'"
    );
    assert.equal(column.rows.length, 1);
    assert.equal(column.rows[0].data_type, "text");
    assert.equal(column.rows[0].is_nullable, "YES");
  });

  it("stores the flag on the offer row and reads it back with the history; every other row reads null", async () => {
    const conversation = await mod.createConversation("k", "anonymous");
    await mod.saveMessage({ conversationId: conversation, role: "user", content: "kérdés" });
    await mod.saveMessage({ conversationId: conversation, role: "assistant", content: "válasz és ajánlat", localKind: "contact_offer" });
    await mod.saveMessage({ conversationId: conversation, role: "assistant", content: "másik válasz" });
    await mod.saveMessage({ conversationId: conversation, role: "assistant", content: "újra kérem", localKind: "contact_ask" });
    const history = await mod.getConversationMessages(conversation, 20);
    assert.deepEqual(
      history.map((row) => [row.role, row.localKind ?? null]),
      [
        ["user", null],
        ["assistant", "contact_offer"],
        ["assistant", null],
        ["assistant", "contact_ask"]
      ]
    );
  });

  it("masks ONLY the given user message, with exactly the given text; an assistant row with that id, and the other rows, stay", async () => {
    const conversation = await mod.createConversation("k", "anonymous");
    const first = await mod.saveMessage({ conversationId: conversation, role: "user", content: "a számom 06 30 123 4567" });
    const second = await mod.saveMessage({ conversationId: conversation, role: "user", content: "a másik 06 20 765 4321" });
    const answer = await mod.saveMessage({ conversationId: conversation, role: "assistant", content: "válasz 06 30 123 4567" });

    await mod.maskUserMessage(first, "a számom [elérhetőség]");
    await mod.maskUserMessage(answer, "[elérhetőség]");

    const rows = await db.pool.query<{ id: string; content: string }>("SELECT id, content FROM messages WHERE conversation_id = $1", [conversation]);
    const byId = new Map(rows.rows.map((row) => [row.id, row.content]));
    assert.equal(byId.get(first), "a számom [elérhetőség]");
    assert.equal(byId.get(second), "a másik 06 20 765 4321");
    assert.equal(byId.get(answer), "válasz 06 30 123 4567");
  });
});
