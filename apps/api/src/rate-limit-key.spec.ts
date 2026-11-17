import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";

/*
  WHOSE ALLOWANCE A CHAT SPENDS (acrobot 54567, t-20261117-ai-rate-limit-kulcs). Per address, the live OS's users and the
  fleet's question-set runner shared one 20 a minute, as they reach the service from the same host. WHAT TURNS IT RED: a
  second caller from the same address refused because the first used its 20; one caller getting more than 20; a request
  without a valid key escaping the address's bucket.
*/
const TOKEN = "kulcs-teszt";
const STORE = {
  createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
  conversationBelongsToClient: async () => true,
  saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
  setMessageOutcome: async () => {},
  getConversationMessages: async () => []
} as unknown as ConversationStore;

function app() {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  return buildApp({
    conversations: STORE,
    openai: { responses: { create: async () => ({ output_text: "valasz" }) } } as unknown as NonNullable<AppDependencies["openai"]>
  });
}

const ask = (a: ReturnType<typeof app>, key: string | null) =>
  a.inject({
    method: "POST",
    url: "/v1/chat",
    headers: { authorization: `Bearer ${TOKEN}`, ...(key === null ? {} : { "x-client-key": key }) },
    payload: { message: "Mennyi a nitrát?" }
  });

describe("the chat's rate limit, per client key", () => {
  it("two callers from one address each have their own 20 a minute", async () => {
    const a = app();
    try {
      const first: number[] = [];
      for (let i = 0; i < 21; i++) first.push((await ask(a, "os-user:egy")).statusCode);
      const other = (await ask(a, "question-set-run")).statusCode;
      assert.deepEqual([first.slice(0, 20).every((s) => s === 200), first[20], other], [true, 429, 200]);
    } finally {
      await a.close();
    }
  });

  it("without a valid key the address's bucket still counts, and a key does not reach into it", async () => {
    const a = app();
    try {
      const keyless: number[] = [];
      for (let i = 0; i < 21; i++) keyless.push((await ask(a, null)).statusCode);
      // a caller whose key reads like the address: without the prefixes it would spend the address's bucket
      const withKey = (await ask(a, "127.0.0.1")).statusCode;
      // a keyless chat is refused 400 (no key); the 21st is refused earlier, by the limit
      assert.deepEqual([keyless.slice(0, 20).every((s) => s === 400), keyless[20], withKey], [true, 429, 200]);
    } finally {
      await a.close();
    }
  });
});
