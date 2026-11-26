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
