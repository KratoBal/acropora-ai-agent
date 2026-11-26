import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GLOSSARY_INSTRUCTIONS, renderGlossaryInstructions } from "./glossary.js";
import { createGlossaryProvider, DEFAULT_TTL_MS, RETRY_AFTER_FAILURE_MS } from "./glossary-provider.js";
import { SEED_ENTRIES, type GlossaryEntry, type GlossaryQuery } from "./glossary-store.js";

/*
  WHAT TURNS THIS RED (card 7a5ea203, B2). The stored list not reaching the text; a failed read taking the language rule out of the prompt
  (it must fall back, and the provider must never throw); a failed read dropping the LAST GOOD list for the constants; the database hit on
  every request (no cache) or hammered after a failure (no retry window); two parallel callers doing two reads; the version not saying
  which source served (null = the code constants).
*/

const rowsOf = (entries: readonly GlossaryEntry[], version: number) => entries.map((entry) => ({ version, ...entry }));

/** A database that answers from a queue (a row list or an Error) and counts the reads. */
const queued = (answers: Array<Array<Record<string, unknown>> | Error>) => {
  let reads = 0;
  const db: GlossaryQuery = {
    query: async () => {
      const next = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      if (next instanceof Error) throw next;
      return { rows: next, rowCount: next.length };
    }
  };
  return { db, reads: () => reads };
};

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const EDITED = SEED_ENTRIES.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, hungarian: "más név" } : entry));

describe("a szójegyzék szolgáltatója", () => {
  it("adatbázis nélkül a kód-konstans, version null", async () => {
    const provider = createGlossaryProvider({ db: null });
    assert.deepEqual(await provider.current(), { version: null, text: GLOSSARY_INSTRUCTIONS, entries: SEED_ENTRIES, source: "constants" });
  });

  it("a tárolt listából épül a szöveg, a verzió számával; a seed szövege bájtra a konstans", async () => {
    const seeded = await createGlossaryProvider({ db: queued([rowsOf(SEED_ENTRIES, 1)]).db }).current();
    assert.equal(seeded.version, 1);
    assert.equal(seeded.source, "stored");
    assert.equal(seeded.text, GLOSSARY_INSTRUCTIONS);

    const edited = await createGlossaryProvider({ db: queued([rowsOf(EDITED, 2)]).db }).current();
    assert.equal(edited.version, 2);
    assert.equal(edited.text, renderGlossaryInstructions(EDITED));
    assert.notEqual(edited.text, GLOSSARY_INSTRUCTIONS);
    assert.ok(edited.text.includes("ATO (Automatic Top Off, angol - más név)"));
  });

  it("üres táblára (még nincs seed) a kód-konstans, version null", async () => {
    assert.deepEqual(await createGlossaryProvider({ db: queued([[]]).db }).current(), {
      version: null,
      text: GLOSSARY_INSTRUCTIONS,
      entries: SEED_ENTRIES,
      source: "constants"
    });
  });

  it("a cache a TTL-ig tart, utána újraolvas, az invalidate azonnal újraolvastat", async () => {
    const time = clock();
    const source = queued([rowsOf(SEED_ENTRIES, 1), rowsOf(EDITED, 2), rowsOf(EDITED, 3)]);
    const provider = createGlossaryProvider({ db: source.db, now: time.now });
    assert.equal((await provider.current()).version, 1);
    time.advance(DEFAULT_TTL_MS - 1);
    assert.equal((await provider.current()).version, 1);
    assert.equal(source.reads(), 1);
    time.advance(2);
    assert.equal((await provider.current()).version, 2);
    assert.equal(source.reads(), 2);
    provider.invalidate();
    assert.equal((await provider.current()).version, 3);
    assert.equal(source.reads(), 3);
  });

  it("hiba, és nem volt jó érték: a konstans, a várakozás alatt nem olvas újra, utána újrapróbál", async () => {
    const time = clock();
    const errors: unknown[] = [];
    const source = queued([new Error("connection refused"), rowsOf(EDITED, 2)]);
    const provider = createGlossaryProvider({ db: source.db, now: time.now, onError: (error) => errors.push(error) });
    assert.equal((await provider.current()).source, "constants");
    assert.equal((await provider.current()).source, "constants");
    assert.equal(source.reads(), 1);
    assert.equal(errors.length, 1);
    time.advance(RETRY_AFTER_FAILURE_MS + 1);
    const recovered = await provider.current();
    assert.equal(recovered.version, 2);
    assert.equal(source.reads(), 2);
  });

  it("hiba, de volt jó érték: az UTOLSÓ JÓ lista marad, nem a konstans (kontroll: a konstans más szöveg)", async () => {
    const time = clock();
    const source = queued([rowsOf(EDITED, 2), new Error("timeout")]);
    const provider = createGlossaryProvider({ db: source.db, now: time.now });
    assert.equal((await provider.current()).version, 2);
    time.advance(DEFAULT_TTL_MS + 1);
    const during = await provider.current();
    assert.equal(during.version, 2);
    assert.equal(during.text, renderGlossaryInstructions(EDITED));
    assert.notEqual(during.text, GLOSSARY_INSTRUCTIONS);
  });

  it("a hibás sor (szerződést sértő) a konstansra visszaesik, nem dob", async () => {
    const bad = rowsOf(SEED_ENTRIES, 1).map((row, index) => (index === 0 ? { ...row, language: "fr" } : row));
    const result = await createGlossaryProvider({ db: queued([bad]).db }).current();
    assert.equal(result.source, "constants");
  });

  it("két egyszerre érkező hívó EGY olvasáson osztozik", async () => {
    const source = queued([rowsOf(SEED_ENTRIES, 1)]);
    const provider = createGlossaryProvider({ db: source.db });
    const [a, b] = await Promise.all([provider.current(), provider.current()]);
    assert.equal(source.reads(), 1);
    assert.equal(a.version, b.version);
  });

  it("a hibajelző hibája sem dob", async () => {
    const provider = createGlossaryProvider({
      db: queued([new Error("down")]).db,
      onError: () => {
        throw new Error("a naplózó is elromlott");
      }
    });
    assert.equal((await provider.current()).source, "constants");
  });
});
