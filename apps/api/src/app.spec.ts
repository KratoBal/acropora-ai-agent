import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp } from "./app.js";

/**
 * Drives the real `/v1/chat` route.
 *
 * The unit specs next to this one build the customer-context functions by
 * hand, which means none of them touches the wiring between the route and
 * those functions. That wiring is where a silent defect hides: on the
 * Acropora OS side of this same feature, sixteen green unit tests sat happily
 * next to a module that would have stopped the API from booting, because not
 * one of them went through the container.
 *
 * Nothing here reaches the database or OpenAI. That is the assertion, not a
 * convenience: both failures answer before any of that work starts, so a
 * status other than the expected one - a 500 from a missing DATABASE_URL, say
 * - would mean the lookup moved to the wrong place in the handler.
 */
const API_TOKEN = "test-api-access-token";

const savedEnvironment = { ...process.env };

let app: ReturnType<typeof buildApp>;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  // Never called in these tests, but the client is constructed when the app is
  // built, and it refuses an empty key.
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;

  app = buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  process.env = savedEnvironment;
});

const chat = (headers: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/v1/chat",
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      ...headers
    },
    payload: { message: "Mennyi a nitrát szintem?" }
  });

describe("POST /v1/chat", () => {
  it("refuses a request that names no customer, before touching anything", async () => {
    const response = await chat({});

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "customer_id_required" });
  });

  it("answers unavailable when the Acropora OS connection is not configured", async () => {
    const response = await chat({ "x-acropora-user-id": "cus_1" });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: "customer_context_unavailable"
    });
  });

  it("still refuses a caller without the API access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { "content-type": "application/json" },
      payload: { message: "szia" }
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "unauthorized" });
  });

  it("keeps rejecting an empty message before it looks for a customer", async () => {
    // Order check: the cheap validation stays in front of the network call.
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
        "x-acropora-user-id": "cus_1"
      },
      payload: { message: "   " }
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "message is required" });
  });
});
