import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, chatInstructions } from "./app.js";

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

describe("chatInstructions", () => {
  it("keeps the assistant persona and adds the customer block", () => {
    const instructions = chatInstructions({
      ok: true,
      mode: "customer",
      context: {
        subjectType: "customer",
        customerId: "cus_1",
        customerNumber: "V-00123",
        entitlements: {},
        entitlementsStatus: "not-modelled",
        entitlementsNote: "..."
      }
    });

    assert.match(instructions, /Acropora marine aquarium assistant/);
    assert.match(instructions, /Customer context from the Acropora OS/);
    assert.match(instructions, /cus_1/);
  });

  it("keeps the assistant persona and states the absence for an anonymous chat", () => {
    // Both halves matter. Losing the persona would change every answer;
    // losing the second half would let the model speak as if it knew the
    // person, which is the whole reason this mode is announced rather than
    // silently empty.
    const instructions = chatInstructions({ ok: true, mode: "anonymous" });

    assert.match(instructions, /Acropora marine aquarium assistant/);
    assert.match(instructions, /no customer context/i);
    assert.equal(instructions.includes("Customer context from"), false);
  });
});

describe("POST /v1/chat", () => {
  it("lets a request with no customer header through the customer gate", async () => {
    /**
     * An anonymous chat is a normal outcome, so the gate must not stop it.
     *
     * There is no database here, so the request cannot finish - and that is
     * what makes the assertion sharp rather than vague: it got past the
     * customer step and died at the conversation step instead. If the header
     * were made mandatory again, this would come back as a 400 from the gate
     * and never reach the database at all.
     */
    const response = await chat({});

    assert.notEqual(response.statusCode, 400);
    assert.notEqual(response.statusCode, 502);
    assert.equal(
      ["customer_id_required", "customer_context_unavailable"].includes(
        (response.json() as { error?: string }).error ?? ""
      ),
      false
    );
  });

  it("refuses a customer header that was sent but carries nothing", async () => {
    // An anonymous visitor sends no header. An empty one is a caller whose
    // variable did not get filled in, and it is answered loudly.
    const response = await chat({ "x-acropora-user-id": "   " });

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

  it("cannot be called from a browser page on another origin", async () => {
    /**
     * The boundary this API relies on, written down as a test rather than as
     * a sentence in a document.
     *
     * The architecture requires a server-side layer between the public front
     * end and this API, and part of what keeps a browser out today is that
     * nothing here speaks CORS. A cross-origin call carrying an Authorization
     * header needs a successful preflight first, and there is no route to
     * answer one; even a request that did arrive would produce a response the
     * page is not allowed to read.
     *
     * This is not a claim that the API is unreachable - it is public, and the
     * shared token is the only gate. It is a claim about what a BROWSER PAGE
     * on someone else's origin can do, and it goes red the moment a permissive
     * CORS plugin is added without a decision.
     */
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/chat",
      headers: {
        origin: "https://example.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type"
      }
    });

    assert.equal(preflight.statusCode, 404);
    assert.equal(
      preflight.headers["access-control-allow-origin"],
      undefined
    );

    const crossOrigin = await chat({ origin: "https://example.invalid" });

    assert.equal(
      crossOrigin.headers["access-control-allow-origin"],
      undefined
    );
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
