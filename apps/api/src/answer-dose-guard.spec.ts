import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  DOSE_GUARD_FALLBACK,
  fixedDosesOf,
  guardAnswerDoses
} from "./answer-dose-guard.js";
import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import type { ProductSearchOutcome } from "./product-search.js";

/**
 * THE ANSWER'S DOSES AGAINST THE CATALOGUE (Acropora OS card 85c38ab1;
 * barracuda on #42). WHAT TURNS IT RED: a recalculated, rounded, re-perioded or
 * gallon dose leaves; a dose leaves when the catalogue gave none; a pack's reach
 * is taken for a dose; the route sends the model's dose instead of the fallback.
 */
const withDose = (value: string): ProductSearchOutcome => ({
  ok: true,
  result: {
    hits: [
      {
        productId: "p1",
        knowledge: [
          { field: "dosing", value, unit: null, source: "MANUFACTURER_PAGE", confirmed: true },
          { field: "dosingMode", value: "FIXED", unit: null, source: "MANUFACTURER_PAGE", confirmed: true }
        ]
      }
    ]
  }
});
const catalogue = withDose("1 drop/100 L/day");

describe("a válasz adagjai a katalógushoz mérve", () => {
  it("a gyártó adagja átmegy, ahogy áll", () => {
    assert.deepEqual(
      guardAnswerDoses("A gyártó oldala szerint naponta 1 csepp 100 literenként.", catalogue),
      { ok: true, doseStatements: 1 }
    );
    assert.equal(
      guardAnswerDoses("Dose 0,5 ml per 100 l weekly.", withDose("0.5 ml/100 L/week")).ok,
      true
    );
  });

  it("átszámolt, más időszakú, más egységű vagy gallonos adag nem megy ki", () => {
    for (const answer of [
      "Az Ön 300 literes akváriumába naponta 3 csepp kell.",
      "Hetente 1 csepp 100 literenként.",
      "Naponta 1 ml 100 literenként.",
      "Naponta 1 csepp 25 gallonra.",
      // the same number as the fact: only the unit can refuse it
      "Naponta 1 csepp 100 gallonra."
    ])
      assert.deepEqual(
        guardAnswerDoses(answer, catalogue).ok,
        false,
        answer
      );
  });

  // barracuda, #43: an outgoing guard reads wide; what it does not recognise leaves
  it("a hiányos adag-mondat sem megy ki: térfogat, időszak vagy az egység nélkül", () => {
    for (const answer of [
      "Az Ön 300 literes akváriumába 3 csepp kell.",
      "Naponta 3 cseppet adjon.",
      "Adagolja naponta. Az Ön akváriumába 3 csepp kell.",
      "Naponta 1 kupak 100 literre.",
      // the exceptions are no way out (barracuda, #43 v2)
      "Naponta 5 ml-t adjon 100 literenként.",
      "Hetente 2 ml-rel adagolja.",
      "Elég naponta 3 csepp az Ön akváriumába.",
      "Adjon 3-at naponta.",
      "Naponta 3 adagot adjon.",
      // the unit word marks the dose, not the digit (barracuda, #43 v3)
      "Naponta egy csepp 100 literenként.",
      "Naponta három cseppet adjon.",
      "Hetente pár ml-t adjon.",
      "Naponta fél kupakot adjon.",
      // a measure word is no pack noun (barracuda, #43 v4)
      "Az Ön 300 literes akváriumába 3 csepp elég.",
      "3 drops are enough for your 300 l tank.",
      // the safe side: a pack's reach without the pack noun
      "500 ml 10 000 literhez elegendő."
    ])
      assert.equal(guardAnswerDoses(answer, catalogue).ok, false, answer);
    // controls: the full dose, a pack's reach, a pack adjective
    for (const answer of [
      "Naponta 1 csepp 100 literenként.",
      "Az 500 ml-es flakon 10 000 literhez elegendő.",
      // the amount stands alone here: only the reach word skips it
      "Egy 500 ml flakon 10 000 literhez elegendő.",
      "Az 500 ml-es változat jó választás nagyobb akváriumhoz.",
      // a period word next to a number WITH a unit is no unit-less dose
      "Hetente mérje a KH-t, a cél 8 dKH.",
      // a multi-digit one: no backtracking to "42" + "0"
      "Hetente mérje a kalciumot, a cél 420 mg/l.",
      // "adagolás" is no unit word
      "Az adagolást a mért KH alapján végezze, hetente mérje."
    ])
      assert.equal(guardAnswerDoses(answer, catalogue).ok, true, answer);
  });

  it("katalógus-adag nélkül nincs adag a válaszban", () => {
    const answer = "Naponta 1 csepp 100 literenként.";
    assert.equal((guardAnswerDoses(answer, { ok: true, result: { hits: [] } }) as { reason?: string }).reason, "NO_FIXED_DOSE");
    assert.equal(
      (guardAnswerDoses(answer, { ok: false, error: "product_search_unavailable", detail: "" }) as { reason?: string }).reason,
      "NO_FIXED_DOSE"
    );
  });

  it("a kiszerelés hatótávja nem adag, és egy adag nélküli válasz érintetlen", () => {
    assert.deepEqual(guardAnswerDoses("Az 500 ml-es flakon 10 000 literhez elegendő.", catalogue), {
      ok: true,
      doseStatements: 0
    });
    assert.deepEqual(guardAnswerDoses("Ennek a szernek nincs fix adagja, előbb mérje a KH-t.", { ok: true, result: {} }), {
      ok: true,
      doseStatements: 0
    });
  });

  it("csak a dosing tény számít fix adagnak, a rossz alakú nem", () => {
    assert.equal(fixedDosesOf(withDose("1 csepp naponta")).length, 0);
    assert.deepEqual(fixedDosesOf(withDose("2 ml/100 L, 2-3/week")), [
      { amount: "2", unit: "ml", volume: "100", period: "week" }
    ]);
  });
});

describe("a chat útja: a válasz-őr be van kötve", () => {
  const API_TOKEN = "dose-guard-teszt-kulcs";
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    // no catalogue: a dose in the answer has nothing behind it
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });

  const run = async (modelText: string) => {
    const saved: string[] = [];
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: { role: string; content: string }) => {
        if (input.role === "assistant") saved.push(input.content);
        return "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";
      },
      setMessageOutcome: async () => {},
      getConversationMessages: async () => []
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: modelText }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { message: "Mennyit adagoljak?" }
    });
    await app.close();
    return { body: response.json() as { answer: string; doseGuard: string | null }, saved };
  };

  it("egy kitalált adag helyett a biztonságos mondat megy ki és tárolódik", async () => {
    const { body, saved } = await run("Naponta 2 ml 100 literenként.");
    assert.deepEqual([body.answer, body.doseGuard, saved], [DOSE_GUARD_FALLBACK, "NO_FIXED_DOSE", [DOSE_GUARD_FALLBACK]]);
  });

  it("adag nélküli válasz változatlan", async () => {
    const { body } = await run("Előbb mérje a KH-t.");
    assert.deepEqual([body.answer, body.doseGuard], ["Előbb mérje a KH-t.", null]);
  });
});
