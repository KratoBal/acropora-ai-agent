import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { buildApp, instructionsVersionOf, INSTRUCTIONS_VERSION } from "./app.js";
import { ABBREVIATIONS, GLOSSARY_INSTRUCTIONS, renderGlossaryInstructions } from "./glossary.js";
import type { GlossaryCurrent, GlossaryProvider } from "./glossary-provider.js";
import { SEED_ENTRIES } from "./glossary-store.js";
import { main, readServerAto, score, type RunReport } from "./question-set-run.js";
import { QUESTION_SET } from "./question-set.js";

/**
 * THE READ-ONLY GLOSSARY ENDPOINT AND THE RUNNER THAT READS IT (card 7a5ea203, B3). What turns it red: the endpoint open without the token;
 * it answering the constants while a stored list serves (or the reverse); the instructions version not following the served text; the
 * runner measuring the abbreviation checks against its OWN constant while the server's ATO differs; a missing, broken or unreachable
 * endpoint failing the run instead of falling back (and saying so); the report not naming which glossary and which expectation.
 */
const API_TOKEN = "glossary-endpoint-teszt-kulcs";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

const EDITED = SEED_ENTRIES.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, original: "Auto Top-Up" } : entry));
const STORED: GlossaryCurrent = { version: 7, text: renderGlossaryInstructions(EDITED), entries: EDITED, source: "stored" };
const CONSTANTS: GlossaryCurrent = { version: null, text: GLOSSARY_INSTRUCTIONS, entries: SEED_ENTRIES, source: "constants" };
const providerOf = (current: GlossaryCurrent): GlossaryProvider => ({ current: async () => current, invalidate: () => {} });

async function getGlossary(current: GlossaryCurrent, token: string | null) {
  const app = buildApp({ databaseCheck: async () => {}, glossary: providerOf(current) });
  await app.ready();
  try {
    return await app.inject({ method: "GET", url: "/v1/glossary", headers: token === null ? {} : { authorization: `Bearer ${token}` } });
  } finally {
    await app.close();
  }
}

describe("GET /v1/glossary", () => {
  it("token nélkül 401, rossz tokennel is", async () => {
    assert.equal((await getGlossary(CONSTANTS, null)).statusCode, 401);
    assert.equal((await getGlossary(CONSTANTS, "rossz")).statusCode, 401);
  });

  it("a tárolt listát adja a verzióval és a szöveg verziójával; a konstanst null verzióval (kontroll)", async () => {
    const stored = await getGlossary(STORED, API_TOKEN);
    assert.equal(stored.statusCode, 200);
    const storedBody = stored.json() as { version: number | null; source: string; instructionsVersion: string; entries: unknown[] };
    assert.equal(storedBody.version, 7);
    assert.equal(storedBody.source, "stored");
    assert.equal(storedBody.instructionsVersion, instructionsVersionOf(STORED.text));
    assert.deepEqual(storedBody.entries, EDITED);

    const constants = (await getGlossary(CONSTANTS, API_TOKEN)).json() as { version: number | null; source: string; instructionsVersion: string; entries: unknown[] };
    assert.equal(constants.version, null);
    assert.equal(constants.source, "constants");
    assert.equal(constants.instructionsVersion, INSTRUCTIONS_VERSION);
    assert.deepEqual(constants.entries, SEED_ENTRIES);
  });
});

const NEW_ATO = { ...ABBREVIATIONS[0]!, original: "Auto Top-Up" };
const ANSWER_NEW = "Az ATO (Auto Top-Up - automatikus utántöltő) fontos.";

describe("a roviditesek ellenorzese a megadott ATO-hoz igazodik", () => {
  it("a szerver ATO-ja szerint pass, a konstans szerint fail (kontroll), mindkét ellenőrzésnél", () => {
    const expanded = QUESTION_SET.find((q) => q.id === "abbreviation-expanded")!;
    assert.equal(score(expanded, ANSWER_NEW, NEW_ATO).verdict, "pass");
    assert.equal(score(expanded, ANSWER_NEW).verdict, "fail");
    const notRepeated = QUESTION_SET.find((q) => q.id === "abbreviation-not-repeated")!;
    assert.equal(score(notRepeated, ANSWER_NEW, NEW_ATO).verdict, "fail");
    assert.equal(score(notRepeated, ANSWER_NEW).verdict, "pass");
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("readServerAto", () => {
  const serverList = { version: 7, source: "stored", entries: EDITED };

  it("a szerver listájából veszi az ATO-t, a verzióval", async () => {
    const result = await readServerAto((async () => json(serverList)) as unknown as typeof fetch, "http://ai.test", "t");
    assert.equal(result.ato.original, "Auto Top-Up");
    assert.deepEqual(result.glossary, { version: 7, expectation: "server" });
  });

  it("a tokent a hívás viszi", async () => {
    let seen = "";
    await readServerAto(
      (async (_url: string, init?: RequestInit) => {
        seen = String((init?.headers as Record<string, string>).authorization);
        return json(serverList);
      }) as unknown as typeof fetch,
      "http://ai.test",
      "titkos"
    );
    assert.equal(seen, "Bearer titkos");
  });

  const fallbacks: Array<[string, () => Promise<Response>, RegExp]> = [
    ["régi szerver (404)", async () => json({ error: "nf" }, 404), /older build/],
    ["szerverhiba (500)", async () => json({ error: "x" }, 500), /answered 500/],
    ["nem JSON", async () => new Response("<html>", { status: 200 }), /JSON/],
    ["nincs entries", async () => json({ version: 3 }), /no entries/],
    ["nincs ATO a listában", async () => json({ version: 3, entries: SEED_ENTRIES.filter((e) => e.abbreviation !== "ATO") }), /no ATO/],
    ["szerződést sértő ATO", async () => json({ version: 3, entries: [{ abbreviation: "ATO", original: 5, language: "en", hungarian: "x" }] }), /breaks the contract/]
  ];
  for (const [name, respond, note] of fallbacks) {
    it(`${name}: a konstansra esik vissza, szól róla, nem dob`, async () => {
      const result = await readServerAto((async () => respond()) as unknown as typeof fetch, "http://ai.test", "t");
      assert.equal(result.ato, ABBREVIATIONS.find((a) => a.abbreviation === "ATO"));
      assert.equal(result.glossary.expectation, "constants");
      assert.match(result.glossary.note ?? "", note);
    });
  }

  it("elérhetetlen szerver: a konstans, nem dob", async () => {
    const result = await readServerAto((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch, "http://ai.test", "t");
    assert.equal(result.glossary.expectation, "constants");
    assert.match(result.glossary.note ?? "", /unreachable/);
  });
});

describe("main a szerver szójegyzékével", () => {
  it("a jelentés nevezi a szójegyzék-verziót és az elvárás forrását, és a futás a szerver ATO-ját méri", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glossary-endpoint-"));
    const out = join(dir, "report.json");
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/health")) return json({ version: "abc", instructionsVersion: "aaaaaaaaaaaa", glossaryVersion: 7 });
      if (url.endsWith("/v1/glossary")) return json({ version: 7, source: "stored", entries: EDITED });
      return json({ conversationId: "c", messageId: "m", answer: ANSWER_NEW, model: "gpt-5.1" });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: (l) => lines.push(l), fetchImpl });
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.deepEqual(report.glossary, { version: 7, expectation: "server" });
    const expanded = report.results.find((r) => r.id === "abbreviation-expanded")!;
    assert.equal(expanded.verdict, "pass");
    assert.match(lines[0]!, /glossary 7 \(ATO from the server\)/);
  });

  it("régi szerverrel (404) a konstans elvárás, a jelentés mondja, és a futás nem bukik el", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glossary-endpoint-"));
    const out = join(dir, "report.json");
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/health")) return json({ version: "abc" });
      if (url.endsWith("/v1/glossary")) return json({ error: "not found" }, 404);
      return json({ conversationId: "c", messageId: "m", answer: ANSWER_NEW, model: "gpt-5.1" });
    }) as unknown as typeof fetch;
    const code = await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl });
    assert.ok(code === 0 || code === 3);
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.equal(report.glossary?.expectation, "constants");
    assert.match(report.glossary?.note ?? "", /older build/);
    assert.equal(report.results.find((r) => r.id === "abbreviation-expanded")!.verdict, "fail");
  });
});
