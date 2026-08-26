import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  buildApp,
  chatInstructions,
  NO_PRODUCT_CONTEXT_INSTRUCTIONS,
  type AppDependencies,
  type AppLogger,
  type ConversationStore,
  type RatingStore
} from "./app.js";
import { RATING_VALUES, type StoredRating } from "./evaluations.js";

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


/**
 * The whole handler, model call included.
 *
 * Everything above stops before the database on purpose, which is useful and
 * was not enough: it meant no test ever reached the point where the route
 * decides what to tell the model. That is where a real defect sat. The clause
 * about our own catalogue was written, exported and asserted by four tests,
 * and the route assembled its own instruction list by hand and left the clause
 * out - on this branch and on every commit before it. The stage measurements
 * of the "narrowed brand clause" were therefore measuring a service that had
 * never been given the clause.
 *
 * So these tests go all the way through with a stand-in store and a stand-in
 * model client, and read back what the model was actually handed.
 */
describe("the chat route, end to end", () => {
  const CONVERSATION_ID = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";

  const ANSWER_MESSAGE_ID = "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";

  const storedMessages: Array<{ role: string; content: string }> = [];

  const store: ConversationStore = {
    createConversation: async () => CONVERSATION_ID,
    conversationBelongsToClient: async () => true,
    saveMessage: async (input) => {
      storedMessages.push({ role: input.role, content: input.content });
      return input.role === "assistant"
        ? ANSWER_MESSAGE_ID
        : "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
    },
    getConversationMessages: async () => [
      { role: "user", content: "Van-e Fauna Marin nyomelem-adalekunk?" }
    ]
  };

  let handedToModel: { instructions?: unknown } = {};

  const modelClient = {
    responses: {
      create: async (parameters: { instructions?: unknown }) => {
        handedToModel = parameters;
        return { output_text: "valasz" };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;

  let routedApp: ReturnType<typeof buildApp>;

  before(async () => {
    routedApp = buildApp({ conversations: store, openai: modelClient });
    await routedApp.ready();
  });

  after(async () => {
    await routedApp.close();
  });

  const ask = () =>
    routedApp.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json"
      },
      payload: { message: "Van-e Fauna Marin nyomelem-adalekunk?" }
    });

  it("answers an anonymous question without touching the database", async () => {
    const response = await ask();

    assert.equal(response.statusCode, 200);
    assert.equal(
      (response.json() as { answer?: string }).answer,
      "valasz"
    );
    assert.ok(
      storedMessages.some((message) => message.role === "assistant"),
      "the answer has to be stored, not only returned"
    );
  });

  it("names the answer it just stored, so it can be judged later", async () => {
    /**
     * Without this the rating route has nothing to address. "The last answer
     * in the conversation" is the alternative, and it is wrong the moment a
     * second question is asked before the first one is judged.
     */
    const response = await ask();

    assert.equal(
      (response.json() as { messageId?: string }).messageId,
      ANSWER_MESSAGE_ID
    );
  });

  it("hands the model the clause about what it cannot see", async () => {
    /**
     * The assertion this file existed without.
     *
     * It is written against the text the model receives rather than against
     * the function that builds it, because the function was never the broken
     * part. Anyone who assembles the instructions inline again turns this red.
     */
    await ask();

    assert.equal(typeof handedToModel.instructions, "string");
    assert.ok(
      (handedToModel.instructions as string).includes(
        NO_PRODUCT_CONTEXT_INSTRUCTIONS
      ),
      "the route sent the model instructions without the catalogue clause"
    );
  });

  it("sends exactly what chatInstructions builds, with nothing dropped", async () => {
    // Not "contains the clause" but "is the assembled text": a route that
    // keeps its own copy of two of the three blocks would pass the test above
    // and still drift away from the function the other tests assert on.
    await ask();

    assert.equal(
      handedToModel.instructions,
      chatInstructions({ ok: true, mode: "anonymous" })
    );
  });
});


/**
 * Storing what somebody thought of an answer.
 *
 * The reason this is a route at all: a rating held in page state is gone on
 * reload, and the internal surface exists to build up a picture of answer
 * quality over more than one sitting.
 */
describe("rating an answer", () => {
  const ANSWER_ID = "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";
  const OTHER_CLIENTS_ANSWER = "c3d5e7f9-1b2c-4d3e-9f6a-0b8c7d6e5f4a";
  const CONVERSATION_ID = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";

  let written: Array<{
    messageId: string;
    rating: string;
    ratedBy: string;
  }> = [];

  const ratingStore: RatingStore = {
    answerIsRatable: async (messageId) => messageId === ANSWER_ID,
    rateAnswer: async (input) => {
      // The upsert, modelled: one row per rater per answer.
      written = written.filter(
        (row) =>
          !(
            row.messageId === input.messageId &&
            row.ratedBy === input.ratedBy
          )
      );
      written.push(input);

      return {
        messageId: input.messageId,
        rating: input.rating,
        ratedBy: input.ratedBy,
        ratedAt: "2026-08-26T20:00:00.000Z"
      } satisfies StoredRating;
    },
    conversationRatings: async () =>
      written.map((row) => ({
        messageId: row.messageId,
        rating: row.rating as StoredRating["rating"],
        ratedBy: row.ratedBy,
        ratedAt: "2026-08-26T20:00:00.000Z"
      }))
  };

  let ratedApp: ReturnType<typeof buildApp>;

  before(async () => {
    ratedApp = buildApp({ ratings: ratingStore });
    await ratedApp.ready();
  });

  after(async () => {
    await ratedApp.close();
  });

  beforeEach(() => {
    written = [];
  });

  const rate = (
    messageId: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    ratedApp.inject({
      method: "POST",
      url: `/v1/messages/${messageId}/rating`,
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
        ...headers
      },
      payload
    });

  it("stores a judgement against the answer it names", async () => {
    const response = await rate(ANSWER_ID, {
      rating: "inaccurate",
      ratedBy: "user_7"
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      messageId: ANSWER_ID,
      rating: "inaccurate",
      ratedBy: "user_7",
      ratedAt: "2026-08-26T20:00:00.000Z"
    });
    assert.deepEqual(written, [
      { messageId: ANSWER_ID, rating: "inaccurate", ratedBy: "user_7" }
    ]);
  });

  it("lets the same person change their mind without adding a second row", async () => {
    // On the screen the four buttons are one control, not four votes.
    await rate(ANSWER_ID, { rating: "correct", ratedBy: "user_7" });
    await rate(ANSWER_ID, { rating: "dangerous", ratedBy: "user_7" });

    assert.deepEqual(written, [
      { messageId: ANSWER_ID, rating: "dangerous", ratedBy: "user_7" }
    ]);
  });

  it("keeps two people's judgements of the same answer apart", async () => {
    // Disagreement about one answer is a finding, and it only survives if the
    // rows are kept separate.
    await rate(ANSWER_ID, { rating: "correct", ratedBy: "user_7" });
    await rate(ANSWER_ID, { rating: "inaccurate", ratedBy: "user_9" });

    assert.equal(written.length, 2);
  });

  it("accepts every value the surface offers, and nothing else", async () => {
    /**
     * Asserted against the exported list rather than a copy of it, so a value
     * added on one side and not the other cannot pass quietly.
     */
    for (const value of RATING_VALUES) {
      const accepted = await rate(ANSWER_ID, {
        rating: value,
        ratedBy: "user_7"
      });

      assert.equal(accepted.statusCode, 200, `rejected ${value}`);
    }

    const refused = await rate(ANSWER_ID, {
      rating: "excellent",
      ratedBy: "user_7"
    });

    assert.equal(refused.statusCode, 400);
    assert.deepEqual(refused.json(), {
      error: "invalid rating",
      allowed: [...RATING_VALUES]
    });
  });

  it("refuses a judgement nobody signed", async () => {
    const response = await rate(ANSWER_ID, { rating: "correct" });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "ratedBy is required" });
    assert.deepEqual(written, [], "nothing may be stored on a refusal");
  });

  it("will not write against an answer that is not the caller's", async () => {
    /**
     * The ownership rule the chat route already applies, applied here too. A
     * rating endpoint without it would let anyone holding the shared token
     * write against message ids they never saw.
     */
    const response = await rate(OTHER_CLIENTS_ANSWER, {
      rating: "correct",
      ratedBy: "user_7"
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "answer not found" });
    assert.deepEqual(written, []);
  });

  it("refuses a message id that is not one", async () => {
    const response = await rate("not-a-uuid", {
      rating: "correct",
      ratedBy: "user_7"
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "invalid messageId" });
  });

  it("is behind the same shared token as the chat", async () => {
    const response = await ratedApp.inject({
      method: "POST",
      url: `/v1/messages/${ANSWER_ID}/rating`,
      headers: { "content-type": "application/json" },
      payload: { rating: "correct", ratedBy: "user_7" }
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(written, []);
  });

  it("reads the judgements back, which is what storing them was for", async () => {
    await rate(ANSWER_ID, { rating: "correct", ratedBy: "user_7" });

    const response = await ratedApp.inject({
      method: "GET",
      url: `/v1/conversations/${CONVERSATION_ID}/ratings`,
      headers: { authorization: `Bearer ${API_TOKEN}` }
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      conversationId: CONVERSATION_ID,
      ratings: [
        {
          messageId: ANSWER_ID,
          rating: "correct",
          ratedBy: "user_7",
          ratedAt: "2026-08-26T20:00:00.000Z"
        }
      ]
    });
  });

  it("does not read a conversation back for an unauthenticated caller", async () => {
    const response = await ratedApp.inject({
      method: "GET",
      url: `/v1/conversations/${CONVERSATION_ID}/ratings`
    });

    assert.equal(response.statusCode, 401);
  });
});


/**
 * The one claim in this service that nothing used to hold in place.
 *
 * `safeErrorSummary` is covered from every angle, but the line that CALLS it
 * was not: the upstream failure branch sits behind the database, so no test
 * reached it, and putting the raw provider error back into that log line would
 * have left every assertion green. The boundary document named this gap and
 * said closing it needed an injectable model client. It has one now, so the
 * gap closes here.
 *
 * An OpenAI error is the specific danger: the provider answers a bad key by
 * quoting it back, partially masked, so the error object can carry the secret
 * that must never reach a log.
 */
describe("what the upstream failure branch writes to the log", () => {
  const OPENAI_KEY = "sk-live-do-not-log-me-1234";

  const store: ConversationStore = {
    createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
    conversationBelongsToClient: async () => true,
    saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
    getConversationMessages: async () => [
      { role: "user", content: "Mennyi a nitrat szintem?" }
    ]
  };

  const providerError = Object.assign(
    new Error(
      `Incorrect API key provided: ${OPENAI_KEY}. You can find your API key at ...`
    ),
    {
      status: 401,
      headers: { authorization: `Bearer ${API_TOKEN}` },
      request: { headers: { authorization: `Bearer ${OPENAI_KEY}` } }
    }
  );

  const failingModel = {
    responses: {
      create: async () => {
        throw providerError;
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;

  let lines: Array<{ level: string; payload: unknown }> = [];

  const recordingLogger: AppLogger = {
    info: (payload) => lines.push({ level: "info", payload }),
    error: (payload) => lines.push({ level: "error", payload }),
    warn: (payload) => lines.push({ level: "warn", payload }),
    debug: (payload) => lines.push({ level: "debug", payload }),
    fatal: (payload) => lines.push({ level: "fatal", payload }),
    trace: (payload) => lines.push({ level: "trace", payload }),
    silent: () => {},
    level: "info",
    child: () => recordingLogger
  };

  let failingApp: ReturnType<typeof buildApp>;

  before(async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    failingApp = buildApp({
      conversations: store,
      openai: failingModel,
      logger: recordingLogger
    });
    await failingApp.ready();
  });

  after(async () => {
    await failingApp.close();
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  const askAndFail = async () => {
    lines = [];

    return failingApp.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json"
      },
      payload: { message: "Mennyi a nitrat szintem?" }
    });
  };

  it("answers with a code and a duration rather than the provider's words", async () => {
    const response = await askAndFail();

    assert.equal(response.statusCode, 502);
    const body = response.json() as { error: string; waitedMs: number };
    assert.equal(body.error, "ai_provider_error");
    assert.equal(typeof body.waitedMs, "number");
    assert.equal(JSON.stringify(body).includes(OPENAI_KEY), false);
  });

  it("logs the failure, and logs it without the key the provider quoted back", async () => {
    await askAndFail();

    const logged = lines.filter((line) => line.level === "error");
    assert.equal(logged.length, 1, "the failure has to be logged exactly once");

    const written = JSON.stringify(logged[0]?.payload);
    assert.equal(
      written.includes(OPENAI_KEY),
      false,
      "the OpenAI key reached the log"
    );
    assert.equal(
      written.includes(API_TOKEN),
      false,
      "the API access token reached the log"
    );
    assert.equal(
      /sk-[A-Za-z0-9_-]{4,}/.test(written),
      false,
      "a key-shaped string reached the log"
    );
  });

  it("hands the logger a summary, not the provider's error object", async () => {
    /**
     * The assertion the gap was about. A summary has a fixed, small set of
     * fields; the error object carries whatever the provider attached, and
     * what it attaches is not ours to predict. Anyone who passes the raw
     * error again turns this red even if today's error happens to be clean.
     */
    await askAndFail();

    const payload = (lines.find((line) => line.level === "error")?.payload ??
      {}) as Record<string, unknown>;

    assert.ok(payload.aiProviderError, "the summary is missing");
    assert.equal(
      payload.aiProviderError instanceof Error,
      false,
      "the raw error object was handed to the logger"
    );
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["aiProviderError", "aiProviderOutcome", "timeoutMs", "waitedMs"].sort()
    );
  });
});
