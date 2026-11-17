import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";

/*
  THE NINE MODEL ENDPOINTS' OWN BUCKETS (card 41e81901, t-20261117-ai-rate-limit-maradek). After #109 and #110 only the chat and
  the rating were keyed per caller; the other nine POST endpoints spent ONE bucket keyed by the address, so one batch
  extractor run from the OS's host used up the live ticket draft's allowance too. WHAT TURNS IT RED: a burst on one of
  these endpoints refusing another; one endpoint allowing more than 20 a minute; the family having no address ceiling; an endpoint sharing or lacking its own bucket;
  the family's ceiling reaching into the chat's.
*/
const TOKEN = "kulcs-teszt";
const ROUTES = [
  "/v1/measurement-recommendations",
  "/v1/dosing-extractions",
  "/v1/product-field-extractions",
  "/v1/claim-extractions",
  "/v1/ticket-drafts",
  "/v1/figure-claim-extractions",
  "/v1/knowledge-answers",
  "/v1/research-queries",
  "/v1/research-summaries"
] as const;

function app() {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  return buildApp({
    conversations: {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
      setMessageOutcome: async () => {},
      getConversationMessages: async () => []
    } as unknown as ConversationStore,
    openai: { responses: { create: async () => ({ output_text: "valasz" }) } } as unknown as NonNullable<AppDependencies["openai"]>
  });
}

// An empty body is refused 400 AFTER the rate check, so a 429 here can only be the limit.
const hit = (a: ReturnType<typeof app>, url: string) =>
  a.inject({ method: "POST", url, headers: { authorization: `Bearer ${TOKEN}` }, payload: {} });

describe("the model endpoints' rate limit, per endpoint", () => {
  it("every one of the nine endpoints has a bucket of its own, named by the route it matched", async () => {
    // a fresh app per endpoint: its own 20 end in a 429 on the 21st, and another endpoint is not refused by it. An endpoint without the call, or
    // one sharing a bucket with another, fails here by name.
    for (const [index, route] of ROUTES.entries()) {
      const a = app();
      try {
        const burst: number[] = [];
        for (let i = 0; i < 21; i++) burst.push((await hit(a, route)).statusCode);
        const other = ROUTES[(index + 1) % ROUTES.length];
        const next = (await hit(a, other)).statusCode;
        assert.deepEqual([route, burst.slice(0, 20).every((s) => s !== 429), burst[20], next !== 429], [route, true, 429, true]);
      } finally {
        await a.close();
      }
    }
  });

  it("no call site keeps the address as its bucket, and the nine sites are the helper's", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../../apps/api/src/app.ts", import.meta.url), "utf8").catch(() =>
      readFile("apps/api/src/app.ts", "utf8")
    );
    assert.equal(/consumeRateLimit\(request\.ip\)/.test(source), false);
    assert.equal([...source.matchAll(/consumeRateLimits\(routeRateBuckets\(request\)\)/g)].length, ROUTES.length);
  });

  it("a burst on one endpoint does not refuse another, and each has its own 20 a minute", async () => {
    const a = app();
    try {
      const burst: number[] = [];
      for (let i = 0; i < 21; i++) burst.push((await hit(a, "/v1/claim-extractions")).statusCode);
      const others: number[] = [];
      for (const route of ROUTES.filter((r) => r !== "/v1/claim-extractions").slice(0, 3)) others.push((await hit(a, route)).statusCode);
      assert.deepEqual(
        [burst.slice(0, 20).every((s) => s !== 429), burst[20], others.every((s) => s !== 429)],
        [true, 429, true]
      );
    } finally {
      await a.close();
    }
  });

  it("the endpoints together keep a ceiling of 120 a minute per address, and the chat's is not touched", async () => {
    const a = app();
    try {
      // six endpoints, 20 each: exactly 120
      const spent: number[] = [];
      for (const route of ROUTES.slice(0, 6)) for (let i = 0; i < 20; i++) spent.push((await hit(a, route)).statusCode);
      const seventh = (await hit(a, ROUTES[6])).statusCode;
      const chat = (
        await a.inject({
          method: "POST",
          url: "/v1/chat",
          headers: { authorization: `Bearer ${TOKEN}`, "x-client-key": "os-user:egy" },
          payload: { message: "Mennyi a nitrát?" }
        })
      ).statusCode;
      // the 120 all pass: a 429 on the 7th alone would also come from one shared bucket of 20
      assert.deepEqual([spent.every((s) => s !== 429), seventh, chat], [true, 429, 200]);
    } finally {
      await a.close();
    }
  });
});
