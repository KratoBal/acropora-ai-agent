import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aiProviderLimits } from "./ai-provider.js";
import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import { CHAT_DEADLINE_ERROR, chatDeadlineMs } from "./chat-deadline.js";

/*
  THE CHAT ANSWER'S DEADLINE (task t-20261116-ai-kezelo-hatarido, acrobot 53996). Before it, a handler that ran past the
  connection net (45 s) was cut with no HTTP answer: the OS showed an empty failure. Measured here over a REAL socket
  (`app.listen` + `fetch`), because `inject` has no socket and no net. WHAT TURNS IT RED: the deadline gone (the client
  gets a closed socket, not a 504); an answer that came after the 504 stored; a model call started after the deadline;
  a fast answer touched by the deadline.
*/
const TOKEN = "hatarido-teszt-kulcs";

function store() {
  const saved: string[] = [];
  const outcomes: string[] = [];
  let readDelayMs = 0;
  const conversations = {
    createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: { role: string }) => {
      saved.push(input.role);
      return `0b1c2d3e-4f5a-4b6c-8d7e-${String(saved.length).padStart(12, "0")}`;
    },
    setMessageOutcome: async (_id: string, outcome: string) => {
      outcomes.push(outcome);
    },
    getConversationMessages: async () => {
      await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return [{ role: "user", content: "Hogyan mérjem a nitrátot?" }];
    }
  } as unknown as ConversationStore;
  return { conversations, saved, outcomes, slowReads: (ms: number) => (readDelayMs = ms) };
}

async function serve(
  conversations: ConversationStore,
  create: (params: unknown, options?: { signal?: AbortSignal }) => Promise<{ output_text: string }>
) {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  const app = buildApp({
    conversations,
    openai: { responses: { create } } as unknown as NonNullable<AppDependencies["openai"]>
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const ask = () =>
    fetch(`http://127.0.0.1:${address.port}/v1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-client-key": "question-set-run",
        "content-type": "application/json"
      },
      body: JSON.stringify({ message: "Hogyan mérjem a nitrátot?" })
    });
  return { app, ask };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the chat deadline's size", () => {
  it("sits under the connection net and above the model's own limit, so a slow model still gets its own code", () => {
    const limits = aiProviderLimits({});
    const deadline = chatDeadlineMs(limits.connectionTimeoutMs);
    assert.equal(deadline, 43_000);
    assert.ok(deadline < limits.connectionTimeoutMs);
    assert.ok(deadline > limits.timeoutMs);
  });

  it("keeps a floor when the net is set very low", () => {
    assert.equal(chatDeadlineMs(1_000), 500);
  });
});

describe("the chat deadline over a real socket", () => {
  it("a slow model: the client gets 504 ai_chat_deadline, not a closed socket; the late answer is not stored", async () => {
    process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS = "1000";
    const s = store();
    let signal: AbortSignal | undefined;
    const { app, ask } = await serve(s.conversations, (_params, options) => {
      signal = options?.signal;
      return new Promise((resolve) => setTimeout(() => resolve({ output_text: "kesei valasz" }), 1500));
    });
    try {
      const response = await ask();
      assert.equal(response.status, 504);
      const body = (await response.json()) as { error: string; waitedMs: number };
      assert.equal(body.error, CHAT_DEADLINE_ERROR);
      assert.ok(body.waitedMs >= 500 && body.waitedMs < 1000, `waitedMs ${body.waitedMs}`);
      assert.equal(signal?.aborted, true);
      await settle(1200);
      assert.deepEqual(s.saved, ["user"]);
      assert.deepEqual(s.outcomes, [CHAT_DEADLINE_ERROR]);
    } finally {
      delete process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS;
      await app.close();
    }
  });

  it("a slow read before the model (what the net was there for): 504, and no model call is started after it", async () => {
    process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS = "1000";
    const s = store();
    s.slowReads(900);
    let calls = 0;
    const { app, ask } = await serve(s.conversations, async () => {
      calls += 1;
      return { output_text: "valasz" };
    });
    try {
      const response = await ask();
      assert.equal(response.status, 504);
      assert.equal(((await response.json()) as { error: string }).error, CHAT_DEADLINE_ERROR);
      await settle(700);
      assert.equal(calls, 0);
      assert.deepEqual(s.saved, ["user"]);
      assert.deepEqual(s.outcomes, [CHAT_DEADLINE_ERROR]);
    } finally {
      delete process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS;
      await app.close();
    }
  });

  it("an answer inside the deadline is untouched: 200, stored, outcome answered", async () => {
    process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS = "1000";
    const s = store();
    const { app, ask } = await serve(s.conversations, async () => ({ output_text: "Nitrát teszttel, havonta." }));
    try {
      const response = await ask();
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { answer: string }).answer, "Nitrát teszttel, havonta.");
      await settle(700);
      assert.deepEqual(s.saved, ["user", "assistant"]);
      assert.deepEqual(s.outcomes, ["answered"]);
    } finally {
      delete process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS;
      await app.close();
    }
  });
});
