import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  CLIENT_KEY_MAX_LENGTH,
  INVALID_CLIENT_KEY,
  buildApp,
  type AppDependencies,
  type ConversationStore,
  type RatingStore
} from "./app.js";

/**
 * THE SHARED FALLBACK KEY ONLY FOR A MISSING HEADER (card 7a5ea203). A conversation and its ratings belong to the caller named by
 * `x-client-key`. WHAT TURNS IT RED: a header that is there but is not a key (empty, blank, longer than the limit) is quietly
 * turned into the shared key or cut to a prefix (two callers could then share a conversation); the given key is not the one a
 * conversation is kept under; the fallback is lost for a caller that sends no header at all; the rating routes read the key
 * differently from the chat route.
 */
const API_TOKEN = "kliens-kulcs-teszt";
const CONVERSATION_ID = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";
const MESSAGE_ID = "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";

describe("x-client-key: the shared fallback only when the header is missing", () => {
  const saved = { ...process.env };
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });
  after(() => {
    process.env = saved;
  });

  const harness = () => {
    const keys: string[] = [];
    const conversations = {
      createConversation: async (clientKey: string) => {
        keys.push(clientKey);
        return CONVERSATION_ID;
      },
      conversationBelongsToClient: async () => true,
      saveMessage: async () => MESSAGE_ID,
      setMessageOutcome: async () => {},
      getConversationMessages: async () => [{ role: "user", content: "Milyen világítás kell a korallokhoz?" }]
    } as unknown as ConversationStore;
    const ratingKeys: string[] = [];
    const ratings = {
      answerIsRatable: async (_id: string, clientKey: string) => {
        ratingKeys.push(clientKey);
        return false;
      },
      rateAnswer: async () => {
        throw new Error("not reached");
      },
      conversationRatings: async (_id: string, clientKey: string) => {
        ratingKeys.push(clientKey);
        return [];
      }
    } as unknown as RatingStore;
    const openai = {
      responses: { create: async () => ({ output_text: "A modell válasza." }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    return { keys, ratingKeys, deps: { conversations, ratings, openai } };
  };

  const call = async (
    deps: AppDependencies,
    request: { method: "GET" | "POST"; url: string; payload?: Record<string, unknown> },
    clientKey?: string
  ) => {
    const app = buildApp(deps);
    await app.ready();
    try {
      const response = await app.inject({
        ...request,
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          ...(clientKey === undefined ? {} : { "x-client-key": clientKey })
        }
      });
      return { status: response.statusCode, body: response.json() as { error?: string } };
    } finally {
      await app.close();
    }
  };
  const chat = { method: "POST" as const, url: "/v1/chat", payload: { message: "Milyen világítás kell a korallokhoz?" } };

  it("no header: the shared fallback key, as before", async () => {
    const h = harness();
    const { status } = await call(h.deps, chat);
    assert.deepEqual([status, h.keys], [200, ["stage-test-client"]]);
  });

  it("a key is kept as it is, up to the limit, never cut", async () => {
    for (const key of ["os-user:user_7", "k".repeat(CLIENT_KEY_MAX_LENGTH)]) {
      const h = harness();
      const { status } = await call(h.deps, chat, key);
      assert.deepEqual([status, h.keys], [200, [key]], key.slice(0, 20));
    }
  });

  it("a header that is not a key is refused with 400, and no conversation is made under any key", async () => {
    for (const key of ["", "   ", "k".repeat(CLIENT_KEY_MAX_LENGTH + 1)]) {
      const h = harness();
      const { status, body } = await call(h.deps, chat, key);
      assert.deepEqual([status, body.error, h.keys], [400, INVALID_CLIENT_KEY, []], JSON.stringify(key.slice(0, 20)));
    }
  });

  it("the rating routes read the key the same way: an invalid one is 400, a valid one reaches the store as it is", async () => {
    const rate = {
      method: "POST" as const,
      url: `/v1/messages/${MESSAGE_ID}/rating`,
      payload: { axis: "accuracy", rating: "correct", ratedBy: "user_7" }
    };
    const list = { method: "GET" as const, url: `/v1/conversations/${CONVERSATION_ID}/ratings` };
    for (const request of [rate, list]) {
      const bad = harness();
      const refused = await call(bad.deps, request, "");
      assert.deepEqual([refused.status, refused.body.error, bad.ratingKeys], [400, INVALID_CLIENT_KEY, []], request.url);
      const good = harness();
      await call(good.deps, request, "os-user:user_7");
      assert.deepEqual(good.ratingKeys, ["os-user:user_7"], request.url);
    }
  });
});
