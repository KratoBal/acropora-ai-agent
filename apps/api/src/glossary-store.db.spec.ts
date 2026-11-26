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

  describe("history, the base version and who approved (C1)", () => {
    const toEntries = (list: readonly import("./glossary-store.js").GlossaryEntry[]) => list.map((entry) => ({ ...entry }));

    before(async () => {
      await clear();
      assert.equal(await store.seedGlossary(db.pool), true);
    });

    it("the seeded approved rows say 'seed' with the seed's time; the others have no approver", async () => {
      const detail = await store.loadGlossaryVersionDetail(db.pool, 1);
      assert.ok(detail);
      assert.equal(detail.active, true);
      assert.equal(detail.createdBy, "seed");
      for (const entry of detail.entries) {
        if (entry.approved) {
          assert.equal(entry.approvedBy, "seed");
          assert.equal(entry.approvedAt, detail.createdAt);
        } else {
          assert.equal(entry.approvedBy, null);
          assert.equal(entry.approvedAt, null);
        }
      }
    });

    it("a save from a stale base writes nothing and says which version is active; null is a stale base too", async () => {
      await assert.rejects(store.saveGlossaryVersion(db.pool, toEntries(store.SEED_ENTRIES), "u", "x", 7), (error: unknown) => {
        assert.ok(error instanceof store.GlossaryVersionConflict);
        assert.equal(error.activeVersion, 1);
        return true;
      });
      await assert.rejects(store.saveGlossaryVersion(db.pool, toEntries(store.SEED_ENTRIES), "u", "x", null), store.GlossaryVersionConflict);
      const count = await db.pool.query("SELECT COUNT(*)::int AS n FROM glossary_versions");
      assert.equal(count.rows[0].n, 1);
    });

    it("an unchanged approved row keeps its approver and time; a new approval is the saver's; a changed approved text is the saver's too", async () => {
      const afterSeed = (await store.loadGlossaryVersionDetail(db.pool, 1))!;
      const atoBefore = afterSeed.entries.find((e) => e.abbreviation === "ATO")!;

      // v2: ICP gets approved by user-9; everything else as it was
      const v2 = toEntries(store.SEED_ENTRIES).map((entry) => (entry.abbreviation === "ICP" ? { ...entry, approved: true } : entry));
      assert.equal(await store.saveGlossaryVersion(db.pool, v2, "user-9", "ICP jóváhagyva", 1), 2);
      const d2 = (await store.loadGlossaryVersionDetail(db.pool, 2))!;
      const ato2 = d2.entries.find((e) => e.abbreviation === "ATO")!;
      const icp2 = d2.entries.find((e) => e.abbreviation === "ICP")!;
      const ro2 = d2.entries.find((e) => e.abbreviation === "RO")!;
      assert.deepEqual([ato2.approvedBy, ato2.approvedAt], [atoBefore.approvedBy, atoBefore.approvedAt]);
      assert.equal(icp2.approvedBy, "user-9");
      assert.ok(icp2.approvedAt);
      assert.deepEqual([ro2.approvedBy, ro2.approvedAt], [null, null]);

      // v3: ATO's Hungarian name edited (still marked approved): the new text is approved by the saver, ICP keeps user-9
      const v3 = v2.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, hungarian: "más név" } : entry));
      assert.equal(await store.saveGlossaryVersion(db.pool, v3, "user-2", "ATO név", 2), 3);
      const d3 = (await store.loadGlossaryVersionDetail(db.pool, 3))!;
      assert.equal(d3.entries.find((e) => e.abbreviation === "ATO")!.approvedBy, "user-2");
      assert.deepEqual(
        [d3.entries.find((e) => e.abbreviation === "ICP")!.approvedBy, d3.entries.find((e) => e.abbreviation === "ICP")!.approvedAt],
        [icp2.approvedBy, icp2.approvedAt]
      );

      // v4: ICP un-approved: no approver; v5: approved again: a NEW approval by the saver
      const v4 = v3.map((entry) => (entry.abbreviation === "ICP" ? { ...entry, approved: false } : entry));
      assert.equal(await store.saveGlossaryVersion(db.pool, v4, "user-3", "ICP vissza", 3), 4);
      const icp4 = (await store.loadGlossaryVersionDetail(db.pool, 4))!.entries.find((e) => e.abbreviation === "ICP")!;
      assert.deepEqual([icp4.approved, icp4.approvedBy, icp4.approvedAt], [false, null, null]);
      const v5 = v4.map((entry) => (entry.abbreviation === "ICP" ? { ...entry, approved: true } : entry));
      assert.equal(await store.saveGlossaryVersion(db.pool, v5, "user-4", "ICP újra", 4), 5);
      assert.equal((await store.loadGlossaryVersionDetail(db.pool, 5))!.entries.find((e) => e.abbreviation === "ICP")!.approvedBy, "user-4");
    });

    it("the list is newest first, with the saver, note, row count and exactly one active", async () => {
      const list = await store.listGlossaryVersions(db.pool);
      assert.deepEqual(list.map((v) => v.version), [5, 4, 3, 2, 1]);
      assert.deepEqual(list.map((v) => v.active), [true, false, false, false, false]);
      assert.equal(list[0]!.createdBy, "user-4");
      assert.equal(list[0]!.note, "ICP újra");
      assert.ok(list.every((v) => v.entryCount === 6));
    });

    it("an unknown version reads as null", async () => {
      assert.equal(await store.loadGlossaryVersionDetail(db.pool, 99), null);
    });

    it("the schema run backfills an empty approver on a seeded row, and only that", async () => {
      await db.pool.query("UPDATE glossary_entries SET approved_by = NULL, approved_at = NULL WHERE version IN (1, 2)");
      await db.pool.query(db.SCHEMA_SQL);
      const v1 = (await store.loadGlossaryVersionDetail(db.pool, 1))!;
      assert.equal(v1.entries.find((e) => e.abbreviation === "ATO")!.approvedBy, "seed");
      // version 2 was saved by a user, not seeded: its approver stays empty (nothing is invented)
      const v2 = (await store.loadGlossaryVersionDetail(db.pool, 2))!;
      assert.equal(v2.entries.find((e) => e.abbreviation === "ATO")!.approvedBy, null);
    });
  });
});
