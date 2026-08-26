import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  buildApp,
  chatInstructions,
  NO_PRODUCT_CONTEXT_INSTRUCTIONS
} from "./app.js";

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

describe("buildApp", () => {
  it("puts the socket net on the server, not just in the config object", () => {
    /**
     * Reads it back off the built app rather than trusting that the value was
     * passed. A limit that is computed and then never handed to Fastify would
     * leave the handler unbounded while every unit test stayed green - the
     * same gap that let an inherited ten minute SDK timeout survive.
     */
    assert.equal(app.initialConfig.connectionTimeout, 45_000);
  });
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

describe("the catalogue the model does not have", () => {
  it("is stated in both modes, not only for an anonymous visitor", () => {
    /**
     * Mode-independent on purpose. A resolved customer is asking the same
     * model, which can see just as few products as it can for a stranger.
     * Stating it only in one mode would leave the other free to invent.
     */
    const anonymous = chatInstructions({ ok: true, mode: "anonymous" });
    const customer = chatInstructions({
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

    for (const [label, instructions] of [
      ["anonymous", anonymous],
      ["customer", customer]
    ] as const) {
      assert.ok(
        instructions.includes(NO_PRODUCT_CONTEXT_INSTRUCTIONS),
        `the ${label} mode must carry the product block`
      );
    }
  });

  it("forbids filling the gap from general knowledge", () => {
    // The failure this prevents is not silence, it is a confident invention:
    // a price or a stock level guessed from a familiar-sounding name.
    assert.match(NO_PRODUCT_CONTEXT_INSTRUCTIONS, /no data about Acropora/i);
    assert.match(NO_PRODUCT_CONTEXT_INSTRUCTIONS, /prices, stock/i);
    assert.match(NO_PRODUCT_CONTEXT_INSTRUCTIONS, /must\s+not fill that gap/i);
  });

  it("allows nothing at all about our range: not yes, not no, not 'typically'", () => {
    /**
     * Three shapes, because all three were measured on stage.
     *
     * "Yes, we have several" was the first. "Not at us either" was the second,
     * and it is the more expensive of the two, because a denial sends a
     * customer away. The third is the quiet one: "typically available from us"
     * - a claim at the level of categories rather than products, made in
     * answers that never named a brand at all. All three are about a range
     * nobody in this conversation can see.
     */
    assert.match(NO_PRODUCT_CONTEXT_INSTRUCTIONS, /what you can\s+SEE/);
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /not yes, not no, not 'typically available from us'/
    );
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /answering it with yes or no is the\s+mistake/i
    );
  });

  it("does NOT stop the model correcting a false premise", () => {
    /**
     * The assertion that guards against tightening this back.
     *
     * Asked whether a low-sodium Red Sea Coral Pro exists, the model said
     * there is no such thing - and that refutation is the most useful thing on
     * the whole test list, better than "I have no data". What had to go was
     * only the half-sentence it added about our range. A clause that silenced
     * the refutation along with it would trade the best behaviour we measured
     * for a rule that reads more tidily.
     */
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /Correcting a false premise is different, and it is welcome/
    );
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /say that it does not exist and why/
    );
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /correct the premise, and do not add\s+whether we carry it/
    );
  });

  it("forbids steering someone to buy a particular item", () => {
    // The form the earlier wording left open: a concrete "get this one" in a
    // conversation carried by Acropora reads as "we sell this one", even when
    // the word "ours" never appears.
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /do not recommend a specific product to\s+buy/i
    );
    assert.match(NO_PRODUCT_CONTEXT_INSTRUCTIONS, /we sell\s+this one/i);
  });

  it("keeps the general description of a brand allowed", () => {
    // Without this the clause would turn every brand question into a refusal,
    // and the general knowledge is the part worth having.
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /Describing a brand or a product in\s+general terms is welcome/i
    );
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /What you know about the world you may say/
    );
  });

  it("does not aim at a grammatical pattern", () => {
    // Two patterns were tried and both failed against our own data: the
    // possessive ("from our range" appears in questions that behaved well) and
    // the named brand (brandless questions still claimed things about us).
    assert.match(
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      /not about how a question is phrased/
    );
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
