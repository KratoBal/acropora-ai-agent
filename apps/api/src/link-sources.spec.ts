import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { LINK_RULE_ENV } from "./answer-link-guard.js";
import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import {
  LINK_SOURCES_CACHE_MS,
  LINK_SOURCES_PATH,
  LINK_SOURCES_TOKEN_ENV,
  clearLinkSourcesCache,
  parseLinkSource,
  readLinkSources
} from "./link-sources.js";

/**
 * THE STORED LINK SOURCES FROM THE OS (card 9d060f5c). WHAT TURNS IT RED: a failed or unconfigured read lets an
 * exception on (the list only widens what may leave, so every failure must be an empty list); an entry the gate
 * cannot use is guessed into one; the token travels in a failure; the OS is asked on every chat turn, or a failure is
 * cached; the route reads the list while the rule is off, or ignores it while it is on.
 */
const BASE = "http://os.invalid";
const TOKEN = "beallitas-olvaso-titok";
const env = { ACROPORA_OS_BASE_URL: BASE, [LINK_SOURCES_TOKEN_ENV]: TOKEN };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counting = (answer: () => Response | Promise<Response>) => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

beforeEach(() => clearLinkSourcesCache());

describe("parseLinkSource", () => {
  it("takes a host with a known category, and a brand only for a manufacturer document", () => {
    assert.deepEqual(parseLinkSource({ host: "redseafish.com", category: "MANUFACTURER_DOCUMENT", brand: "Red Sea", note: "x" }), {
      host: "redseafish.com",
      category: "MANUFACTURER_DOCUMENT",
      brand: "Red Sea"
    });
    assert.deepEqual(parseLinkSource({ host: "nebih.gov.hu", category: "AUTHORITY", brand: "Valami" }), {
      host: "nebih.gov.hu",
      category: "AUTHORITY",
      brand: null
    });
  });

  it("drops what the gate cannot use, instead of guessing", () => {
    for (const bad of [
      null,
      "redseafish.com",
      { host: "RedSeaFish.com", category: "AUTHORITY" },
      { host: "https://redseafish.com", category: "AUTHORITY" },
      { host: "redseafish", category: "AUTHORITY" },
      { host: "redseafish.com", category: "OTHER" },
      { host: "redseafish.com", category: "MANUFACTURER_DOCUMENT", brand: null },
      { host: "redseafish.com", category: "MANUFACTURER_DOCUMENT", brand: "  " }
    ])
      assert.equal(parseLinkSource(bad), null, JSON.stringify(bad));
  });
});

describe("readLinkSources", () => {
  it("not configured: an empty list, and the OS is not asked", async () => {
    const { calls, fetchImpl } = counting(() => json({ linkSources: [] }));
    for (const environment of [{}, { ACROPORA_OS_BASE_URL: BASE }, { [LINK_SOURCES_TOKEN_ENV]: TOKEN }])
      assert.deepEqual(await readLinkSources({ environment, fetchImpl }), { ok: false, sources: [], reason: "not_configured" });
    assert.equal(calls.length, 0);
  });

  it("reads the reader endpoint with its own token, keeps the usable entries and counts the dropped ones", async () => {
    const { calls, fetchImpl } = counting(() =>
      json({
        offerEnabled: false,
        linkSources: [
          { host: "redseafish.com", category: "MANUFACTURER_DOCUMENT", brand: "Red Sea" },
          { host: "nebih.gov.hu", category: "AUTHORITY", brand: null },
          { host: "bad host", category: "AUTHORITY" }
        ]
      })
    );
    const read = await readLinkSources({ environment: { ...env, ACROPORA_OS_BASE_URL: `${BASE}/` }, fetchImpl });
    assert.deepEqual(read, {
      ok: true,
      sources: [
        { host: "redseafish.com", category: "MANUFACTURER_DOCUMENT", brand: "Red Sea" },
        { host: "nebih.gov.hu", category: "AUTHORITY", brand: null }
      ],
      dropped: 1
    });
    assert.deepEqual(calls, [{ url: `${BASE}${LINK_SOURCES_PATH}`, authorization: `Bearer ${TOKEN}` }]);
  });

  it("an OS from before the list (no field) is an empty list, not a failure", async () => {
    const { fetchImpl } = counting(() => json({ offerEnabled: false, contactRequestEnabled: false, messageRetentionDays: 180 }));
    assert.deepEqual(await readLinkSources({ environment: env, fetchImpl }), { ok: true, sources: [], dropped: 0 });
  });

  it("every failure is an empty list with its reason, and none carries the token", async () => {
    for (const [answer, reason] of [
      [() => json({}, 401), "unauthorized"],
      [() => json({}, 403), "unauthorized"],
      [() => json({}, 500), "unavailable"],
      [
        () => {
          throw new TypeError(`fetch failed: Bearer ${TOKEN}`);
        },
        "unavailable"
      ],
      [() => new Response("nem json", { status: 200 }), "bad_response"],
      [() => json({ linkSources: { host: "x.com" } }), "bad_response"]
    ] as const) {
      clearLinkSourcesCache();
      const read = await readLinkSources({ environment: env, fetchImpl: counting(answer).fetchImpl });
      assert.deepEqual(read, { ok: false, sources: [], reason }, reason);
      assert.equal(JSON.stringify(read).includes(TOKEN), false);
    }
  });

  it("a good read is kept for a minute; a failure is not kept", async () => {
    let status = 500;
    const { calls, fetchImpl } = counting(() =>
      status === 200 ? json({ linkSources: [{ host: "nebih.gov.hu", category: "AUTHORITY" }] }) : json({}, status)
    );
    assert.equal((await readLinkSources({ environment: env, fetchImpl, now: 0 })).ok, false);
    status = 200;
    assert.equal((await readLinkSources({ environment: env, fetchImpl, now: 1 })).ok, true);
    status = 500;
    assert.equal((await readLinkSources({ environment: env, fetchImpl, now: LINK_SOURCES_CACHE_MS })).ok, true);
    assert.equal(calls.length, 2);
    assert.equal((await readLinkSources({ environment: env, fetchImpl, now: LINK_SOURCES_CACHE_MS + 1 })).ok, false);
    assert.equal(calls.length, 3);
  });
});

describe("the chat route reads the stored list only while the link rule is on", () => {
  const API_TOKEN = "link-sources-teszt-kulcs";
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let settingsCalls = 0;
  let settingsStatus = 200;

  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ACROPORA_OS_BASE_URL = BASE;
    process.env[LINK_SOURCES_TOKEN_ENV] = TOKEN;
    // the catalogue search is not configured: only the settings read goes to the stub
    delete process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });
  after(() => {
    process.env = saved;
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    settingsCalls = 0;
    settingsStatus = 200;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith(LINK_SOURCES_PATH)) settingsCalls++;
      return settingsStatus === 200
        ? json({ linkSources: [{ host: "nebih.gov.hu", category: "AUTHORITY", brand: null }] })
        : json({}, settingsStatus);
    }) as typeof fetch;
  });
  afterEach(() => {
    delete process.env[LINK_RULE_ENV];
  });

  const run = async (message: string, modelText: string) => {
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
      setMessageOutcome: async () => {},
      getConversationMessages: async () => [{ role: "user", content: message }]
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: modelText }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { message }
      });
      return response.json() as { answer: string; linkGuard: { reason: string | null } | null };
    } finally {
      await app.close();
    }
  };
  const authorityAnswer = "A hatóság oldala: https://nebih.gov.hu/cites";

  it("off: the OS is not asked for the list", async () => {
    const body = await run("Kell CITES engedély?", authorityAnswer);
    assert.deepEqual([body.linkGuard, settingsCalls], [null, 0]);
  });

  it("on: a listed AUTHORITY host on a CITES question passes (K3), read from the OS", async () => {
    process.env[LINK_RULE_ENV] = "enforce";
    const body = await run("Kell CITES engedély a korallhoz?", authorityAnswer);
    assert.deepEqual([body.answer, body.linkGuard?.reason, settingsCalls], [authorityAnswer, null, 1]);
  });

  it("on, the list unreadable: no exception, the K3 topic is reported without a stored source", async () => {
    process.env[LINK_RULE_ENV] = "log";
    settingsStatus = 503;
    const body = await run("Kell CITES engedély a korallhoz?", authorityAnswer);
    assert.deepEqual([body.answer, body.linkGuard?.reason], [authorityAnswer, "EXCEPTION_WITHOUT_STORED_SOURCE"]);
  });
});
