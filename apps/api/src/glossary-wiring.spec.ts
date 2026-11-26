import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildApp, instructionsVersionOf, INSTRUCTIONS_VERSION, type AppDependencies, type ConversationStore } from "./app.js";
import { GLOSSARY_INSTRUCTIONS, renderGlossaryInstructions } from "./glossary.js";
import { SEED_ENTRIES } from "./glossary-store.js";
import type { GlossaryCurrent, GlossaryProvider } from "./glossary-provider.js";

/**
 * THE STORED GLOSSARY REACHES THE PROMPT, AND THE ANSWER CARRIES ITS VERSION (card 7a5ea203, B2), through the real routes. What turns it
 * red: the model told the constant while a stored list exists; the instructions version not following the text; the glossary version
 * missing on the stored row or the response; the version coming from a SECOND read after the call (the cache may move in between);
 * /health not reporting what the answers carry; a service with the constants answering a version it did not use.
 */
const API_TOKEN = "glossary-wiring-teszt-kulcs";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

const EDITED = SEED_ENTRIES.map((entry) => (entry.abbreviation === "ATO" ? { ...entry, hungarian: "más név" } : entry));
const STORED: GlossaryCurrent = { version: 7, text: renderGlossaryInstructions(EDITED), source: "stored" };
const CONSTANTS: GlossaryCurrent = { version: null, text: GLOSSARY_INSTRUCTIONS, source: "constants" };

const providerOf = (...answers: GlossaryCurrent[]) => {
  let calls = 0;
  const provider: GlossaryProvider = {
    current: async () => answers[Math.min(calls++, answers.length - 1)],
    invalidate: () => {}
  };
  return { provider, calls: () => calls };
};

async function chatWith(provider: GlossaryProvider) {
  const saved: Array<Record<string, unknown>> = [];
  const store = {
    createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: Record<string, unknown>) => {
      saved.push(input);
      return input.role === "assistant" ? "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f" : "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
    },
    setMessageOutcome: async () => {},
    getConversationMessages: async () => []
  } as unknown as ConversationStore;
  const told: string[] = [];
  const openai = {
    responses: {
      create: async (request: { instructions: string }) => {
        told.push(request.instructions);
        return { output_text: "valasz" };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;
  const app = buildApp({ conversations: store, openai, glossary: provider, databaseCheck: async () => {} });
  await app.ready();
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat",
    headers: { authorization: `Bearer ${API_TOKEN}`, "x-client-key": "stage-test-client" },
    payload: { message: "Melyik szűrő kell 200 literhez?" }
  });
  await app.close();
  return { response, saved, told };
}

describe("a tárolt szójegyzék a chat útvonalon", () => {
  it("a modell a tárolt listát kapja, és a válasz sora meg a válasz a verzióját és a szöveg verzióját viszi", async () => {
    const { response, saved, told } = await chatWith(providerOf(STORED).provider);
    assert.equal(response.statusCode, 200);
    assert.equal(told.length, 1);
    assert.ok(told[0].includes(STORED.text));
    assert.ok(told[0].includes("ATO (Automatic Top Off, angol - más név)"));
    assert.ok(!told[0].includes(GLOSSARY_INSTRUCTIONS));

    const expected = instructionsVersionOf(STORED.text);
    assert.notEqual(expected, INSTRUCTIONS_VERSION);
    const body = response.json() as { instructionsVersion?: string; glossaryVersion?: number | null };
    assert.equal(body.instructionsVersion, expected);
    assert.equal(body.glossaryVersion, 7);
    const answer = saved.find((entry) => entry.role === "assistant");
    assert.equal(answer?.instructionsVersion, expected);
    assert.equal(answer?.glossaryVersion, 7);
    const question = saved.find((entry) => entry.role === "user");
    assert.equal(question?.glossaryVersion, undefined);
  });

  it("a kérésenként EGY olvasás dönt: a második olvasás más listát adna, a válasz mégis azt viszi, amit a modell kapott", async () => {
    const source = providerOf(STORED, CONSTANTS);
    const { response, saved, told } = await chatWith(source.provider);
    assert.equal(source.calls(), 1);
    assert.ok(told[0].includes(STORED.text));
    assert.equal((response.json() as { glossaryVersion?: number | null }).glossaryVersion, 7);
    assert.equal(saved.find((entry) => entry.role === "assistant")?.glossaryVersion, 7);
  });

  it("kód-konstanssal a verzió null, és a szöveg-verzió a mai (kontroll)", async () => {
    const { response, saved } = await chatWith(providerOf(CONSTANTS).provider);
    const body = response.json() as { instructionsVersion?: string; glossaryVersion?: number | null };
    assert.equal(body.instructionsVersion, INSTRUCTIONS_VERSION);
    assert.equal(body.glossaryVersion, null);
    assert.equal(saved.find((entry) => entry.role === "assistant")?.glossaryVersion, null);
  });
});

describe("a /health ugyanazt mondja, amit a válaszok visznek", () => {
  it("a tárolt listánál mindkét szám a tárolté, kód-konstansnál a mai és null", async () => {
    for (const [current, version] of [
      [STORED, 7],
      [CONSTANTS, null]
    ] as const) {
      const app = buildApp({ databaseCheck: async () => {}, glossary: providerOf(current).provider });
      await app.ready();
      try {
        const body = (await app.inject({ method: "GET", url: "/health" })).json() as { instructionsVersion?: string; glossaryVersion?: number | null };
        assert.equal(body.instructionsVersion, instructionsVersionOf(current.text));
        assert.equal(body.glossaryVersion, version);
      } finally {
        await app.close();
      }
    }
  });
});
