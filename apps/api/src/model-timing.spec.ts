import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";

/*
  THE MODEL CALL'S OWN TIME AND SIZE (ai-chat-modellhivas-ido-20261123; acrobot 59468). The question-set runner measures the whole request, so a
  slower provider and a slower server read the same (barracuda on #138); `modelTiming` gives it the model call's milliseconds and the provider's
  token counts. WHAT TURNS IT RED: the field going to an OS key, or to the runner's key with the switch off; the time not being the model call's
  (a constant, or the whole request); a missing count read as zero; the field reaching the stored row.
*/
const API_TOKEN = "modellido-teszt-kulcs";
const MODEL_DELAY_MS = 60;

describe("the model call's own time and size", () => {
  const saved = { ...process.env };
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });
  after(() => {
    process.env = saved;
  });
  afterEach(() => {
    delete process.env.AI_DOSE_GUARD_DEBUG;
  });

  const ask = async (clientKey: string, usage: unknown) => {
    const stored: Array<Record<string, unknown>> = [];
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: Record<string, unknown>) => {
        if (input.role === "assistant") stored.push(input);
        return "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";
      },
      setMessageOutcome: async () => {},
      getConversationMessages: async () => [{ role: "user", content: "Milyen gyakran mérjem a nitrátot?" }]
    } as unknown as ConversationStore;
    const openai = {
      responses: {
        create: async () => {
          await new Promise((resolve) => setTimeout(resolve, MODEL_DELAY_MS));
          return { output_text: "A nitrátot hetente mérd.", ...(usage === undefined ? {} : { usage }) };
        }
      }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const startedAt = Date.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${API_TOKEN}`, "x-client-key": clientKey },
        payload: { message: "Milyen gyakran mérjem a nitrátot?" }
      });
      return { body: response.json() as Record<string, unknown>, stored, wholeMs: Date.now() - startedAt };
    } finally {
      await app.close();
    }
  };

  it("the runner key with the switch on gets the model call's milliseconds and the provider's token counts", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    const { body, stored, wholeMs } = await ask("question-set-run", { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 });
    const timing = body.modelTiming as { modelMs: number; inputTokens: number | null; outputTokens: number | null };
    assert.equal(timing.inputTokens, 1234);
    assert.equal(timing.outputTokens, 56);
    // the model call's own time: at least the stand-in's delay, and no more than the whole request took
    assert.ok(timing.modelMs >= MODEL_DELAY_MS - 5, `modelMs ${timing.modelMs}`);
    assert.ok(timing.modelMs <= wholeMs, `modelMs ${timing.modelMs} over the whole ${wholeMs}`);
    assert.deepEqual(Object.keys(timing).sort(), ["inputTokens", "modelMs", "outputTokens"]);
    // not stored: the row keeps what it kept (the usage counts it always had), and no timing
    assert.equal(stored.length, 1);
    assert.equal("modelTiming" in stored[0]!, false);
  });

  it("a count the provider did not send is null, never zero", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    const { body } = await ask("question-set-run", undefined);
    const timing = body.modelTiming as { inputTokens: unknown; outputTokens: unknown };
    assert.deepEqual([timing.inputTokens, timing.outputTokens], [null, null]);
  });

  it("an OS key never gets it, switch or no switch; the runner key without the switch does not either", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    assert.equal("modelTiming" in (await ask("os-user:42", { input_tokens: 1 })).body, false);
    delete process.env.AI_DOSE_GUARD_DEBUG;
    assert.equal("modelTiming" in (await ask("question-set-run", { input_tokens: 1 })).body, false);
  });
});
