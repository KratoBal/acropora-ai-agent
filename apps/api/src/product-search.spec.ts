import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRODUCT_SEARCH_PATH,
  PRODUCT_SEARCH_TIMEOUT_MS,
  PRODUCT_SEARCH_TOKEN_ENV,
  productSearchConfig,
  searchProducts
} from "./product-search.js";
import { OPENAI_TIMEOUT_MS_ENV } from "./ai-provider.js";

const TOKEN = "product-search-token-that-must-never-leak";
const CUSTOMER_TOKEN = "customer-context-token";

const environment: NodeJS.ProcessEnv = {
  ACROPORA_OS_BASE_URL: "https://os.example/",
  [PRODUCT_SEARCH_TOKEN_ENV]: TOKEN,
  ACROPORA_OS_AI_SERVICE_TOKEN: CUSTOMER_TOKEN
};

const recordingFetch = (respond: () => Response | never) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;

  return { impl, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const projection = {
  query: "fauna marin",
  hits: [{ productId: "p1", name: "Fauna Marin Balling" }],
  totalMatched: 3,
  oldestSyncedAt: "2026-08-27T06:00:00.000Z",
  projectionVersion: "2026-08-27.1"
};

describe("productSearchConfig", () => {
  it("needs both halves and trims the trailing slash", () => {
    assert.deepEqual(productSearchConfig(environment), {
      baseUrl: "https://os.example",
      token: TOKEN
    });
    assert.equal(productSearchConfig({}), null);
  });

  it("is NOT satisfied by the customer-context token", () => {
    /**
     * The two endpoints are guarded by two separate mechanisms on the OS
     * side, each accepting exactly one token record. Falling back to the
     * customer-context token here would be refused there - but the reason to
     * keep them apart is not that it would fail. It is that one leaked
     * credential must not carry two systems.
     */
    assert.equal(
      productSearchConfig({
        ACROPORA_OS_BASE_URL: "https://os.example",
        ACROPORA_OS_AI_SERVICE_TOKEN: CUSTOMER_TOKEN
      }),
      null
    );
  });
});

describe("searchProducts", () => {
  it("asks the OS endpoint, carries its own token, and returns neither", async () => {
    const { impl, calls } = recordingFetch(() => json(projection));

    const outcome = await searchProducts(
      { query: "fauna marin", limit: 5 },
      { environment, fetchImpl: impl }
    );

    const call = calls[0];
    assert.ok(call, "a hivasnak meg kellett tortennie");
    assert.equal(
      call.url,
      `https://os.example${PRODUCT_SEARCH_PATH}?q=fauna+marin&limit=5`
    );
    assert.equal(
      (call.init.headers as Record<string, string>).authorization,
      `Bearer ${TOKEN}`
    );
    assert.equal(JSON.stringify(outcome).includes(TOKEN), false);
  });

  it("forwards the projection UNCHANGED", async () => {
    /**
     * The point of the whole module. If this side started sorting, filtering
     * or re-ranking, "swappable search" would stop being true: the engine
     * would have a second half living here, and changing it would mean
     * changing both.
     */
    const { impl } = recordingFetch(() => json(projection));

    const outcome = await searchProducts(
      { query: "x" },
      { environment, fetchImpl: impl }
    );

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ok && outcome.result, projection);
  });

  it("says it could not run, rather than returning an empty result", async () => {
    /**
     * "The search found nothing" and "the search could not run" must not look
     * alike. The first is an answer about the catalogue; the second is an
     * outage - and a model that cannot tell them apart will confidently say
     * we carry nothing.
     */
    const { impl, calls } = recordingFetch(() => json(projection));

    const outcome = await searchProducts({ query: "x" }, {
      environment: {},
      fetchImpl: impl
    });

    assert.equal(outcome.ok, false);
    assert.equal(
      !outcome.ok && outcome.error,
      "product_search_not_configured"
    );
    assert.equal(calls.length, 0, "nem szabad kimeno hivast inditania");
  });

  it("separates an authorization failure from an outage", async () => {
    // Two different repairs: one is a token, the other is a service.
    for (const [status, expected] of [
      [401, "product_search_unauthorized"],
      [403, "product_search_unauthorized"],
      [500, "product_search_unavailable"],
      [502, "product_search_unavailable"]
    ] as const) {
      const { impl } = recordingFetch(() => json({ error: "x" }, status));

      const outcome = await searchProducts(
        { query: "x" },
        { environment, fetchImpl: impl }
      );

      assert.equal(!outcome.ok && outcome.error, expected, `status ${status}`);
    }
  });

  it("reports a timeout as one, and says nothing else about it", async () => {
    const { impl } = recordingFetch(() => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      throw error;
    });

    const outcome = await searchProducts(
      { query: "x" },
      { environment, fetchImpl: impl }
    );

    assert.equal(!outcome.ok && outcome.error, "product_search_unavailable");
    assert.equal(!outcome.ok && outcome.detail, "timeout");
  });

  it("does not wait a model-sized minute for an index lookup", () => {
    /**
     * A catalogue search either answers quickly or is broken. Inheriting the
     * model budget would leave somebody waiting most of a minute for a
     * lookup.
     */
    assert.ok(PRODUCT_SEARCH_TIMEOUT_MS <= 10_000);
    assert.equal(typeof OPENAI_TIMEOUT_MS_ENV, "string");
  });
});
