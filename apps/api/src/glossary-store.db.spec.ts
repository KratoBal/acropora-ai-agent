import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/**
 * The glossary store against a real Postgres (card 7a5ea203, B1).
 *
 * The unit spec measures the statement's text and the mapping; this one measures what the statement DOES: one version however many
 * starts, no write next to an existing version, the active list the highest version, the checks that refuse a bad row. It needs a
 * throwaway database and is skipped without one (CI has none): AI_GLOSSARY_DB_URL=postgres://... on an EMPTY database, because it creates
 * the schema and clears the glossary tables.
 *
 * What turns it red: two parallel seeds writing two versions or twelve entries; the seed writing beside version 2; the active list
 * not the highest version; a language outside en/de accepted; the order not kept.
 */
const url = process.env.AI_GLOSSARY_DB_URL;

describe("the glossary store in Postgres", { skip: url ? false : "AI_GLOSSARY_DB_URL is not set" }, () => {
  let db: typeof import("./db.js");
  let store: typeof import("./glossary-store.js");

  const clear = async () => {
    await db.pool.query("DELETE FROM glossary_entries; DELETE FROM glossary_versions;");
  };

  before(async () => {
    process.env.DATABASE_URL = url;
    db = await import("./db.js");
    store = await import("./glossary-store.js");
    await db.pool.query(db.SCHEMA_SQL);
    await db.pool.query(db.SCHEMA_SQL); // the schema runs on every start: twice must be the same as once
    await clear();
  });

  after(async () => {
    await clear();
    await db.pool.end();
  });

  it("five parallel seeds write exactly one version with the six entries", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.seedGlossary(db.pool)));
    assert.equal(results.filter(Boolean).length, 1);
    const versions = await db.pool.query("SELECT COUNT(*)::int AS n FROM glossary_versions");
    const entries = await db.pool.query("SELECT COUNT(*)::int AS n FROM glossary_entries");
    assert.equal(versions.rows[0].n, 1);
    assert.equal(entries.rows[0].n, 6);
  });

  it("the active list is the seed, in order, with the approval marks", async () => {
    const loaded = await store.loadActiveGlossary(db.pool);
    assert.equal(loaded?.version, 1);
    assert.deepEqual(loaded?.entries, store.SEED_ENTRIES);
  });

  it("a later seed writes nothing, and nothing next to a higher version", async () => {
    assert.equal(await store.seedGlossary(db.pool), false);
    await db.pool.query("INSERT INTO glossary_versions (version, created_by, note) VALUES (2, 'test', 'edited')");
    await db.pool.query(
      "INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved) VALUES (2, 1, 'ATO', 'Automatic Top Off', 'en', 'más név', true)"
    );
    assert.equal(await store.seedGlossary(db.pool), false);
    const loaded = await store.loadActiveGlossary(db.pool);
    assert.equal(loaded?.version, 2);
    assert.deepEqual(loaded?.entries.map((entry) => entry.hungarian), ["más név"]);
    const versions = await db.pool.query("SELECT COUNT(*)::int AS n FROM glossary_versions");
    assert.equal(versions.rows[0].n, 2);
  });

  it("with only a higher version left (the first one gone) the seed still writes nothing", async () => {
    await db.pool.query("DELETE FROM glossary_entries WHERE version = 1; DELETE FROM glossary_versions WHERE version = 1;");
    assert.equal(await store.seedGlossary(db.pool), false);
    const versions = await db.pool.query("SELECT version FROM glossary_versions ORDER BY version");
    assert.deepEqual(versions.rows.map((row) => row.version), [2]);
  });

  it("saveGlossaryVersion writes the next version with its entries, and two parallel writes get two numbers", async () => {
    const edited = store.SEED_ENTRIES.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, hungarian: "más név" } : entry));
    const versions = await Promise.all([store.saveGlossaryVersion(db.pool, edited, "test", "a"), store.saveGlossaryVersion(db.pool, edited, "test", "b")]);
    assert.deepEqual([...versions].sort(), [3, 4]);
    const loaded = await store.loadActiveGlossary(db.pool);
    assert.equal(loaded?.version, 4);
    assert.deepEqual(loaded?.entries, edited);
    const counts = await db.pool.query("SELECT version, COUNT(*)::int AS n FROM glossary_entries WHERE version IN (3, 4) GROUP BY version ORDER BY version");
    assert.deepEqual(counts.rows.map((row) => row.n), [6, 6]);
  });

  it("an invalid list writes nothing, and a failure between the version row and its entries leaves NO half version", async () => {
    await assert.rejects(store.saveGlossaryVersion(db.pool, [], "test", "empty"));
    const before = (await db.pool.query("SELECT MAX(version)::int AS v FROM glossary_versions")).rows[0].v;
    // the same pool, but the entries insert fails: the version row written before it must roll back with it
    const failing = {
      connect: async () => {
        const client = await db.pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            if (text.includes("INSERT INTO glossary_entries")) throw new Error("the entries insert broke");
            return client.query(text, values);
          },
          release: () => client.release()
        };
      }
    };
    await assert.rejects(store.saveGlossaryVersion(failing, store.SEED_ENTRIES, "test", "broken"), /entries insert broke/);
    const after = (await db.pool.query("SELECT MAX(version)::int AS v FROM glossary_versions")).rows[0].v;
    assert.equal(after, before);
    const orphan = await db.pool.query("SELECT COUNT(*)::int AS n FROM glossary_versions v WHERE NOT EXISTS (SELECT 1 FROM glossary_entries e WHERE e.version = v.version)");
    assert.equal(orphan.rows[0].n, 0);
  });

  it("the schema gives messages a glossary_version column", async () => {
    const column = await db.pool.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'glossary_version'");
    assert.equal(column.rows[0]?.data_type, "integer");
  });

  it("refuses a language outside en/de and an empty text", async () => {
    await assert.rejects(
      db.pool.query(
        "INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved) VALUES (2, 2, 'X', 'x', 'fr', 'x', true)"
      )
    );
    await assert.rejects(
      db.pool.query(
        "INSERT INTO glossary_entries (version, position, abbreviation, original, language, hungarian, approved) VALUES (2, 3, 'Y', 'y', 'en', '', true)"
      )
    );
  });
});
