import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildApp } from "./app.js";
import { parseGlossarySave, type GlossaryAdmin } from "./glossary-admin.js";
import type { GlossaryProvider } from "./glossary-provider.js";
import { GLOSSARY_LIMITS, GlossaryVersionConflict, SEED_ENTRIES, validateGlossaryEntries, type GlossaryVersionDetail } from "./glossary-store.js";

/**
 * THE GLOSSARY'S WRITE PATH AND HISTORY (card 7a5ea203, C1). What turns it red: any of the three routes open without the token; a save body
 * accepted without the base version (the lost-update guard silently off) or with a field the server owns (approvedBy, approvedAt); a stale
 * base saved instead of refused with 409; a refused list answering 500 or a database error leaking its text; a save that does not drop this
 * instance's cache; the answer not saying how long the other instances take; a missing store answering anything but 503.
 */
const API_TOKEN = "glossary-write-teszt-kulcs";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

const body = (overrides: Record<string, unknown> = {}) => ({
  expectedVersion: 1,
  createdBy: "user-1",
  note: "ATO magyar neve",
  entries: SEED_ENTRIES.map(({ abbreviation, original, language, hungarian, approved }) => ({ abbreviation, original, language, hungarian, approved })),
  ...overrides
});

describe("parseGlossarySave", () => {
  it("a jó törzset elfogadja, a szövegek szélét levágja, a note elhagyható", () => {
    const parsed = parseGlossarySave(body({ note: undefined, createdBy: "  user-1 ", entries: [{ abbreviation: " ATO ", original: "Automatic Top Off ", language: "en", hungarian: " név", approved: true }] }));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.createdBy, "user-1");
      assert.equal(parsed.value.note, "");
      assert.deepEqual(parsed.value.entries, [{ abbreviation: "ATO", original: "Automatic Top Off", language: "en", hungarian: "név", approved: true }]);
    }
  });

  const refused: Array<[string, unknown, RegExp]> = [
    ["nem objektum", [], /objektum/],
    ["hiányzó expectedVersion", (() => { const b = body(); delete (b as Record<string, unknown>).expectedVersion; return b; })(), /expectedVersion kötelező/],
    ["nulla expectedVersion", body({ expectedVersion: 0 }), /pozitív egész/],
    ["tört expectedVersion", body({ expectedVersion: 1.5 }), /pozitív egész/],
    ["szöveg expectedVersion", body({ expectedVersion: "1" }), /pozitív egész/],
    ["üres createdBy", body({ createdBy: " " }), /createdBy/],
    ["ismeretlen mező", body({ approvedBy: "valaki" }), /ismeretlen mező: approvedBy/],
    ["entries nem lista", body({ entries: "x" }), /entries lista/],
    ["sor ismeretlen mezője", body({ entries: [{ abbreviation: "A", original: "a", language: "en", hungarian: "a", approved: true, approvedBy: "x" }] }), /ismeretlen mezője: approvedBy/],
    ["rossz nyelv", body({ entries: [{ abbreviation: "A", original: "a", language: "fr", hungarian: "a", approved: true }] }), /en vagy de/],
    ["approved nem logikai", body({ entries: [{ abbreviation: "A", original: "a", language: "en", hungarian: "a", approved: "igen" }] }), /igaz\/hamis/],
    ["hosszú note", body({ note: "x".repeat(GLOSSARY_LIMITS.note + 1) }), /note legfeljebb/]
  ];
  for (const [name, input, message] of refused) {
    it(`${name}: elutasítja`, () => {
      const parsed = parseGlossarySave(input);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.message, message);
    });
  }

  it("a null expectedVersion elfogadott (még nincs tárolt verzió)", () => {
    assert.equal(parseGlossarySave(body({ expectedVersion: null })).ok, true);
  });
});

describe("validateGlossaryEntries, hosszkorlátok", () => {
  it("a túl hosszú szöveget és a túl sok sort elutasítja, a seed belefér", () => {
    assert.equal(validateGlossaryEntries(SEED_ENTRIES), null);
    assert.match(validateGlossaryEntries([{ ...SEED_ENTRIES[0]!, hungarian: "x".repeat(GLOSSARY_LIMITS.hungarian + 1) }]) ?? "", /túl hosszú/);
    assert.match(validateGlossaryEntries(Array.from({ length: GLOSSARY_LIMITS.entries + 1 }, (_, i) => ({ ...SEED_ENTRIES[0]!, abbreviation: `A${i}` }))) ?? "", /legfeljebb/);
  });
});

const detail: GlossaryVersionDetail = {
  version: 2,
  createdAt: "2026-11-26T18:00:00.000Z",
  createdBy: "user-1",
  note: "n",
  active: true,
  entries: SEED_ENTRIES.map((entry) => ({ ...entry, approvedBy: entry.approved ? "seed" : null, approvedAt: entry.approved ? "2026-11-26T17:00:00.000Z" : null }))
};

const fakeAdmin = (overrides: Partial<GlossaryAdmin> = {}) => {
  const saved: unknown[] = [];
  const admin: GlossaryAdmin = {
    listVersions: async () => [{ version: 2, createdAt: detail.createdAt, createdBy: "user-1", note: "n", entryCount: 6, active: true }],
    readVersion: async (version) => (version === 2 ? detail : null),
    save: async (input) => {
      saved.push(input);
      return 3;
    },
    ...overrides
  };
  return { admin, saved };
};

const providerCounting = () => {
  const state = { invalidated: 0 };
  const provider: GlossaryProvider = {
    current: async () => ({ version: 3, text: "tárolt szöveg", entries: SEED_ENTRIES, source: "stored" }),
    invalidate: () => {
      state.invalidated += 1;
    }
  };
  return { provider, state };
};

async function call(options: { admin: GlossaryAdmin | null; provider?: GlossaryProvider; method: "GET" | "PUT"; url: string; token?: string | null; payload?: unknown }) {
  const app = buildApp({ databaseCheck: async () => {}, glossaryAdmin: options.admin, ...(options.provider ? { glossary: options.provider } : {}) });
  await app.ready();
  try {
    return await app.inject({
      method: options.method,
      url: options.url,
      headers: options.token === null ? {} : { authorization: `Bearer ${options.token ?? API_TOKEN}` },
      ...(options.payload !== undefined ? { payload: options.payload as object } : {})
    });
  } finally {
    await app.close();
  }
}

describe("a szójegyzék útvonalai", () => {
  it("mindhárom token nélkül 401, rossz tokennel is", async () => {
    const { admin } = fakeAdmin();
    for (const [method, url] of [["GET", "/v1/glossary/versions"], ["GET", "/v1/glossary/versions/2"], ["PUT", "/v1/glossary"]] as const) {
      assert.equal((await call({ admin, method, url, token: null, payload: method === "PUT" ? body() : undefined })).statusCode, 401, `${method} ${url}`);
      assert.equal((await call({ admin, method, url, token: "rossz", payload: method === "PUT" ? body() : undefined })).statusCode, 401);
    }
  });

  it("tároló nélkül mindhárom 503", async () => {
    for (const [method, url] of [["GET", "/v1/glossary/versions"], ["GET", "/v1/glossary/versions/2"], ["PUT", "/v1/glossary"]] as const) {
      assert.equal((await call({ admin: null, method, url, payload: method === "PUT" ? body() : undefined })).statusCode, 503);
    }
  });

  it("az előzmény és egy verzió olvasása; ismeretlen 404, rossz szám 400", async () => {
    const { admin } = fakeAdmin();
    const list = await call({ admin, method: "GET", url: "/v1/glossary/versions" });
    assert.equal(list.statusCode, 200);
    assert.equal((list.json() as { versions: Array<{ version: number }> }).versions[0]!.version, 2);
    const one = await call({ admin, method: "GET", url: "/v1/glossary/versions/2" });
    assert.deepEqual(one.json(), detail);
    assert.equal((await call({ admin, method: "GET", url: "/v1/glossary/versions/9" })).statusCode, 404);
    for (const bad of ["0", "abc", "-1", "1e3", "2.5"]) assert.equal((await call({ admin, method: "GET", url: `/v1/glossary/versions/${bad}` })).statusCode, 400, bad);
  });

  it("a mentés az admint hívja a törzsből, eldobja a cache-t, és kimondja a késést", async () => {
    const { admin, saved } = fakeAdmin();
    const { provider, state } = providerCounting();
    const response = await call({ admin, provider, method: "PUT", url: "/v1/glossary", payload: body({ expectedVersion: 2 }) });
    assert.equal(response.statusCode, 200);
    const json = response.json() as { version: number; activeVersion: number; instructionsVersion: string; takesEffectWithinSeconds: number };
    assert.equal(json.version, 3);
    assert.equal(json.activeVersion, 3);
    assert.match(json.instructionsVersion, /^[0-9a-f]{12}$/);
    assert.equal(json.takesEffectWithinSeconds, 60);
    assert.equal(state.invalidated, 1);
    assert.equal(saved.length, 1);
    assert.equal((saved[0] as { expectedVersion: number }).expectedVersion, 2);
    assert.equal((saved[0] as { createdBy: string }).createdBy, "user-1");
  });

  it("hibás törzs 400 és semmi nem ír; a hiányzó alapverzió is", async () => {
    const { admin, saved } = fakeAdmin();
    const missing = body();
    delete (missing as Record<string, unknown>).expectedVersion;
    for (const payload of [missing, body({ approvedBy: "valaki" }), body({ entries: [] })]) {
      const response = await call({ admin, method: "PUT", url: "/v1/glossary", payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(saved.length, 0);
  });

  it("a közben mentett lista 409 az aktív verzióval, és nem dobja el a cache-t", async () => {
    const { admin } = fakeAdmin({ save: async () => { throw new GlossaryVersionConflict(5); } });
    const { provider, state } = providerCounting();
    const response = await call({ admin, provider, method: "PUT", url: "/v1/glossary", payload: body() });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: "version_conflict", activeVersion: 5 });
    assert.equal(state.invalidated, 0);
  });

  it("a tároló elutasítása (üres lista) 400 az üzenettel; az adatbázis hibája 500, a szövege nem szivárog", async () => {
    const refused = fakeAdmin({ save: async () => { throw new Error("a szójegyzék nem lehet üres"); } });
    const first = await call({ admin: refused.admin, method: "PUT", url: "/v1/glossary", payload: body() });
    assert.equal(first.statusCode, 400);
    assert.match((first.json() as { message: string }).message, /nem lehet üres/);

    const broken = fakeAdmin({ save: async () => { throw Object.assign(new Error('relation "glossary_versions" does not exist'), { code: "42P01" }); } });
    const second = await call({ admin: broken.admin, method: "PUT", url: "/v1/glossary", payload: body() });
    assert.equal(second.statusCode, 500);
    assert.ok(!JSON.stringify(second.json()).includes("glossary_versions"));
  });
});
