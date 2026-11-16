import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  buildApp,
  INSTRUCTIONS_VERSION,
  type AppDependencies,
  type ConversationStore
} from "./app.js";
import { instructionsVersion } from "./instructions-version.js";

/**
 * THE INSTRUCTION VERSION TRAVELS WITH THE ANSWER (card 7a5ea203, acrobot 53661). What turns this red: the version
 * not written on a model answer; written on the user row (no instructions applied to it); a hash that does not move
 * when one of the fixed texts changes; or one that moves with the per-request part (then it groups nothing).
 */
const API_TOKEN = "instructions-version-teszt-kulcs";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  // never called, but the client is built with the app and refuses an empty key
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

describe("instructionsVersion", () => {
  it("is 12 hex characters, the same for the same text, and moves when any part changes", () => {
    const base = instructionsVersion(["a", "b", "c"]);
    assert.match(base, /^[0-9a-f]{12}$/);
    assert.equal(instructionsVersion(["a", "b", "c"]), base);
    assert.notEqual(instructionsVersion(["a", "b", "c!"]), base);
    assert.notEqual(instructionsVersion(["a", "b"]), base);
    assert.match(INSTRUCTIONS_VERSION, /^[0-9a-f]{12}$/);
  });
});

describe("the stored answer carries the instruction version", () => {
  it("on the model answer, and not on the user row", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: Record<string, unknown>) => {
        saved.push(input);
        return input.role === "assistant"
          ? "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f"
          : "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
      },
      setMessageOutcome: async () => {},
      getConversationMessages: async () => []
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: "valasz" }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;

    const app = buildApp({ conversations: store, openai });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${API_TOKEN}`, "x-client-key": "stage-test-client" },
      payload: { message: "Melyik szűrő kell 200 literhez?" }
    });
    await app.close();

    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { instructionsVersion?: string }).instructionsVersion, INSTRUCTIONS_VERSION);
    const answer = saved.find((entry) => entry.role === "assistant");
    const question = saved.find((entry) => entry.role === "user");
    assert.equal(answer?.instructionsVersion, INSTRUCTIONS_VERSION);
    assert.equal(question?.instructionsVersion, undefined);
  });
});

describe("the health report names the instruction version", () => {
  it("is the value written on the answers, so a run can read it from the server it measures", async () => {
    const app = buildApp({ databaseCheck: async () => {} });
    await app.ready();
    try {
      const body = (await app.inject({ method: "GET", url: "/health" })).json() as { instructionsVersion?: string };
      assert.equal(body.instructionsVersion, INSTRUCTIONS_VERSION);
    } finally {
      await app.close();
    }
  });
});
