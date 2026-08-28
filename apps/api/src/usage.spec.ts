import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { buildApp, readUsage, type AppDependencies } from "./app.js";
import type { ConversationStore } from "./app.js";

/**
 * WHAT THE MODEL CALL COST, WRITTEN DOWN - AND WHAT HAPPENS WHEN IT IS NOT
 * THERE.
 *
 * The second half is the one that needs proving. A recording that falls over
 * when the provider omits `usage` is worse than no recording at all: it turns
 * an accounting note into a reason the customer gets no answer.
 */

const API_TOKEN = "usage-teszt-kulcs";

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  // Soha nem hívjuk, de a kliens az app építésekor jön létre, és üres kulcsot
  // nem fogad el.
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

const CONVERSATION_ID = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";
const ANSWER_ID = "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";

function storeRecording(saved: Array<Record<string, unknown>>) {
  return {
    createConversation: async () => CONVERSATION_ID,
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: Record<string, unknown>) => {
      saved.push(input);
      return input.role === "assistant"
        ? ANSWER_ID
        : "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
    },
    // Nem díszítés: enélkül ez a hamisítvány a kimenet-jegyzetnél dobna, és a
    // két teszt csak azért maradna zöld, mert a hívó elnyeli a hibát. Egy
    // teszt, ami a saját tárgyát egy őrzőnek köszönheti, rossz okból zöld.
    setMessageOutcome: async () => {},
    getConversationMessages: async () => []
  } as unknown as ConversationStore;
}

function modelAnswering(answer: Record<string, unknown>) {
  return {
    responses: { create: async () => answer }
  } as unknown as NonNullable<AppDependencies["openai"]>;
}

async function ask(
  store: ConversationStore,
  openai: NonNullable<AppDependencies["openai"]>
) {
  const app = buildApp({ conversations: store, openai });
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat",
    headers: { authorization: `Bearer ${API_TOKEN}` },
    payload: { message: "Melyik szűrő kell 200 literhez?" }
  });

  await app.close();
  return response;
}

describe("a modellhívás ára", () => {
  /**
   * MINEK KELL PIROSÍTANIA: ha a számok nem érnek el a tárolóig, vagy ha a
   * három közül bármelyik elveszik útközben.
   */
  it("leírja a három token-számot, ha a válasz hozta őket", async () => {
    const saved: Array<Record<string, unknown>> = [];

    const response = await ask(
      storeRecording(saved),
      modelAnswering({
        output_text: "valasz",
        usage: { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 }
      })
    );

    assert.equal(response.statusCode, 200);

    const answer = saved.find((entry) => entry.role === "assistant");
    assert.ok(answer, "az asszisztens-üzenetnek mentődnie kellett");
    assert.deepEqual(answer.usage, {
      inputTokens: 1234,
      outputTokens: 56,
      totalTokens: 1290
    });
  });

  /**
   * A BIZONYÍTÁS, NEM AZ ÁLLÍTÁS: a válaszban NINCS usage mező.
   *
   * MINEK KELL PIROSÍTANIA: ha a hiányzó mezőtől a kérés elhasal, vagy ha a
   * kód nullát ír oda, ahol nem tudunk semmit. A nulla azt állítaná, hogy a
   * hívás ingyen volt.
   */
  it("hiányzó usage mezőnél is válaszol, csak nem ír le számot", async () => {
    const saved: Array<Record<string, unknown>> = [];

    const response = await ask(
      storeRecording(saved),
      modelAnswering({ output_text: "valasz" })
    );

    assert.equal(response.statusCode, 200, "a válasz nem eshet el a hiánytól");

    const answer = saved.find((entry) => entry.role === "assistant");
    assert.ok(answer);
    assert.equal(answer.usage, undefined);
  });

  /**
   * ÉS AMI KÖZTE VAN: a usage megjött, de nem szám van benne.
   *
   * MINEK KELL PIROSÍTANIA: ha egy szöveg vagy egy null bekerül a
   * szám-oszlopba, vagy ha a hibás mező miatt a jó mező is elveszik.
   */
  it("a használhatatlan mezőt eldobja, a jót megtartja", () => {
    assert.deepEqual(
      readUsage({ usage: { input_tokens: 7, output_tokens: "sok" } }),
      {
        inputTokens: 7,
        outputTokens: undefined,
        totalTokens: undefined
      }
    );

    assert.equal(readUsage({ usage: {} }), undefined);
    assert.equal(readUsage({ usage: null }), undefined);
    assert.equal(readUsage({}), undefined);
    assert.equal(readUsage(undefined), undefined);
  });
});
