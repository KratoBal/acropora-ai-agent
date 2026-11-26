import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "./db.js";
import { ABBREVIATIONS, GLOSSARY_INSTRUCTIONS, renderGlossaryInstructions } from "./glossary.js";
import {
  loadActiveGlossary,
  SEED_ENTRIES,
  SEED_SQL,
  seedGlossary,
  type GlossaryEntry,
  type GlossaryQuery
} from "./glossary-store.js";

/*
  WHAT TURNS THIS RED (card 7a5ea203, B1). The seed drifting from the code constants (a field, the order, the approval marks); the rendered
  glossary text no longer byte-equal to GLOSSARY_INSTRUCTIONS (then switching the prompt to the stored list in B2 would move the behavior
  and the instructions version); the approval mark leaking into the prompt (it only marks); the seed writing next to an existing version;
  a stored row that breaks the contract being repaired or guessed instead of refused.
*/

const recorder = (rows: Array<Record<string, unknown>> = [], rowCount: number | null = rows.length) => {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const db: GlossaryQuery = {
    query: async (text, values) => {
      calls.push({ text, values });
      return { rows, rowCount };
    }
  };
  return { db, calls };
};

const storedRow = (entry: GlossaryEntry, version = 1) => ({ version, ...entry });

describe("a szójegyzék seedje", () => {
  it("a hat kód-konstans sor, ugyanabban a sorrendben, és csak a négy várakozó magyar név nincs jóváhagyva", () => {
    assert.deepEqual(
      SEED_ENTRIES.map((entry) => entry.abbreviation),
      ["ATO", "ICP", "RO", "TDS", "KH", "PAR"]
    );
    assert.deepEqual(
      SEED_ENTRIES.filter((entry) => !entry.approved).map((entry) => entry.abbreviation),
      ["ICP", "RO", "TDS", "PAR"]
    );
    for (const [index, entry] of SEED_ENTRIES.entries()) {
      const { approved: _approved, ...rest } = entry;
      assert.deepEqual(rest, ABBREVIATIONS[index]);
    }
  });

  it("a seedből renderelt szöveg bájtra azonos a kód-konstans szöveggel (a B2 átkapcsolás nem mozdíthat semmit)", () => {
    assert.equal(renderGlossaryInstructions(SEED_ENTRIES), GLOSSARY_INSTRUCTIONS);
  });

  it("a jóváhagyás jelölője nem kerül a promptba, és a lista a sorrendet és a tartalmat követi (kontroll)", () => {
    const allApproved = SEED_ENTRIES.map((entry) => ({ ...entry, approved: true }));
    const nobodyApproved = SEED_ENTRIES.map((entry) => ({ ...entry, approved: false }));
    assert.equal(renderGlossaryInstructions(allApproved), renderGlossaryInstructions(nobodyApproved));

    const edited = SEED_ENTRIES.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, hungarian: "más név" } : entry));
    assert.notEqual(renderGlossaryInstructions(edited), GLOSSARY_INSTRUCTIONS);
    assert.ok(renderGlossaryInstructions(edited).includes("ATO (Automatic Top Off, angol - más név)"));

    const reversed = [...SEED_ENTRIES].reverse();
    assert.notEqual(renderGlossaryInstructions(reversed), GLOSSARY_INSTRUCTIONS);
  });

  it("egyetlen utasítás, a sorrend 1-től, a tömbök egymáshoz igazodnak, és a hívás jelzi, hogy ő írt", async () => {
    const written = recorder([], 6);
    assert.equal(await seedGlossary(written.db), true);
    assert.equal(written.calls.length, 1);
    assert.equal(written.calls[0].text, SEED_SQL);
    const values = written.calls[0].values as unknown[];
    assert.deepEqual(values[1], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(values[2], SEED_ENTRIES.map((entry) => entry.abbreviation));
    assert.deepEqual(values[4], ["en", "en", "en", "en", "de", "en"]);
    assert.deepEqual(values[6], [true, false, false, false, true, false]);

    const skipped = recorder([], 0);
    assert.equal(await seedGlossary(skipped.db), false);
  });

  it("csak akkor ír, ha EGYETLEN verzió sincs (a feltétel a szövegben, a viselkedést a db spec méri)", () => {
    assert.ok(SEED_SQL.includes("WHERE NOT EXISTS (SELECT 1 FROM glossary_versions)"));
    assert.ok(SEED_SQL.includes("ON CONFLICT (version) DO NOTHING"));
  });
});

describe("az aktív szójegyzék olvasása", () => {
  it("a sorokat sorrendben adja vissza, a verzióval", async () => {
    const { db } = recorder(SEED_ENTRIES.map((entry) => storedRow(entry, 3)));
    const loaded = await loadActiveGlossary(db);
    assert.equal(loaded?.version, 3);
    assert.deepEqual(loaded?.entries, SEED_ENTRIES);
  });

  it("üres táblára null (a hívó a kód-konstanst használja)", async () => {
    assert.equal(await loadActiveGlossary(recorder([]).db), null);
  });

  it("a szerződést sértő sort nem javítja és nem találja ki: null", async () => {
    const good = SEED_ENTRIES.map((entry) => storedRow(entry));
    assert.equal(await loadActiveGlossary(recorder([...good.slice(0, 5), { ...good[5], language: "fr" }]).db), null);
    assert.equal(await loadActiveGlossary(recorder([...good.slice(0, 5), { ...good[5], approved: "igen" }]).db), null);
    assert.equal(await loadActiveGlossary(recorder([...good.slice(0, 5), { ...good[5], hungarian: null }]).db), null);
    // két verzió keveredése egy válaszban: nem egy lista
    assert.equal(await loadActiveGlossary(recorder([...good.slice(0, 5), { ...good[5], version: 2 }]).db), null);
  });
});

describe("a szójegyzék séma", () => {
  it("a két tábla és a nyelv-kényszer ott van, és a seed nyelvei beleférnek", () => {
    assert.ok(SCHEMA_SQL.includes("CREATE TABLE IF NOT EXISTS glossary_versions"));
    assert.ok(SCHEMA_SQL.includes("CREATE TABLE IF NOT EXISTS glossary_entries"));
    assert.ok(SCHEMA_SQL.includes("language TEXT NOT NULL CHECK (language IN ('en', 'de'))"));
    for (const entry of SEED_ENTRIES) assert.ok(["en", "de"].includes(entry.language));
  });
});
