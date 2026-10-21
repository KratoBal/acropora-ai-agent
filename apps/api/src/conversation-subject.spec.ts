import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  buildApp,
  type AppDependencies,
  type ConversationStore
} from "./app.js";
import {
  conversationSubject,
  type CustomerContextResult,
  type ResolvedCustomer
} from "./customer-context.js";

/**
 * A conversation stays with the subject it was started for (card a3e0327f).
 *
 * The customer was resolved per request and stored nowhere, so a conversation
 * started for customer A could be continued with customer B's header, or with
 * none, and B's chat was handed A's history. What turns these red: the subject
 * not passed to the store on create or on the ownership check; a mismatch
 * answered with anything but the same 404 an unknown conversation gets; a
 * refused request that still saves a message or calls the model.
 *
 * The store here is a stand-in that applies the same rule as the SQL in
 * conversations.ts (client AND subject, a row with no subject matches
 * nobody). The SQL itself is measured against Postgres in
 * conversations.db.spec.ts.
 */
const API_TOKEN = "test-api-access-token";
const savedEnvironment = { ...process.env };

const customer = (customerId: string): ResolvedCustomer => ({
  ok: true,
  mode: "customer",
  context: {
    subjectType: "customer",
    customerId,
    customerNumber: `N-${customerId}`,
    entitlements: {},
    entitlementsStatus: "not-modelled",
    entitlementsNote: ""
  }
});

describe("conversationSubject", () => {
  it("names the customer the OS answered with, or anonymous", () => {
    assert.equal(conversationSubject(customer("cus_A")), "customer:cus_A");
    assert.equal(conversationSubject({ ok: true, mode: "anonymous" }), "anonymous");
  });
});

describe("a conversation is continued only for the subject it was started for", () => {
  const rows = new Map<string, { clientKey: string; subject: string | null }>();
  const saved: Array<{ conversationId: string; content: string }> = [];
  const calls: { create: string[]; check: string[] } = { create: [], check: [] };
  let modelCalls = 0;
  let next = 0;

  const store: ConversationStore = {
    createConversation: async (clientKey, subject) => {
      calls.create.push(subject);
      next += 1;
      const id = `6f1d0a2c-1b7e-4a3f-9c2d-${String(next).padStart(12, "0")}`;
      rows.set(id, { clientKey, subject });
      return id;
    },
    conversationBelongsToClient: async (conversationId, clientKey, subject) => {
      calls.check.push(subject);
      const row = rows.get(conversationId);
      return Boolean(row && row.clientKey === clientKey && row.subject !== null && row.subject === subject);
    },
    saveMessage: async (input) => {
      saved.push({ conversationId: input.conversationId, content: input.content });
      return "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
    },
    setMessageOutcome: async () => {},
    getConversationMessages: async () => []
  };

  const modelClient = {
    responses: {
      create: async () => {
        modelCalls += 1;
        return { output_text: "valasz" };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;

  const resolveCustomer = async (raw: unknown): Promise<CustomerContextResult> =>
    raw === undefined ? { ok: true, mode: "anonymous" } : customer(String(raw));

  let app: ReturnType<typeof buildApp>;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
    app = buildApp({ conversations: store, openai: modelClient, resolveCustomer });
    await app.ready();
  });

  after(async () => {
    await app.close();
    process.env = savedEnvironment;
  });

  beforeEach(() => {
    saved.length = 0;
    calls.create.length = 0;
    calls.check.length = 0;
    modelCalls = 0;
  });

  const chat = (customerId: string | undefined, conversationId?: string, message = "szia") =>
    app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        "content-type": "application/json",
        ...(customerId === undefined ? {} : { "x-acropora-user-id": customerId })
      },
      payload: { message, ...(conversationId ? { conversationId } : {}) }
    });

  const start = async (customerId: string | undefined) => {
    const response = await chat(customerId);
    assert.equal(response.statusCode, 200);
    return (response.json() as { conversationId: string }).conversationId;
  };

  it("stores who the conversation is about when it is created", async () => {
    await start("cus_A");
    await start(undefined);
    assert.deepEqual(calls.create, ["customer:cus_A", "anonymous"]);
  });

  it("the same customer continues their own conversation", async () => {
    const id = await start("cus_A");
    const response = await chat("cus_A", id);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls.check, ["customer:cus_A"]);
  });

  for (const [label, starter, other] of [
    ["another customer, on a customer's conversation", "cus_A", "cus_B"],
    ["an anonymous visitor, on a customer's conversation", "cus_A", undefined],
    ["a customer, on an anonymous conversation", undefined, "cus_A"]
  ] as const) {
    it(`${label}: the same 404 as an unknown conversation, nothing saved, no model call`, async () => {
      const id = await start(starter);
      saved.length = 0;
      modelCalls = 0;
      const response = await chat(other, id, "masik ugyfel kerdese");
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "conversation not found" });
      assert.deepEqual(saved, []);
      assert.equal(modelCalls, 0);
    });
  }

  it("a conversation written before the subject was stored is continued by nobody", async () => {
    const legacy = "6f1d0a2c-1b7e-4a3f-9c2d-999999999999";
    rows.set(legacy, { clientKey: "stage-test-client", subject: null });
    for (const who of [undefined, "cus_A"]) {
      const response = await chat(who, legacy);
      assert.equal(response.statusCode, 404, String(who));
    }
    assert.deepEqual(saved, []);
  });
});
