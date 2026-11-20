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

  /*
    A MONDAT FAJTÁJA SZÁMÍT, NEM A TERMÉK (t-20261116-adagolasi-or-szukites; barracuda 53718, acrobot 53719). Az első két
    stage-futás hat általános választ veszített el ezen az ágon. MI PIROSÍT: egy általános válasz (megvilágítás, mérési
    gyakoriság, párolgás, célérték) újra adagnak számít; vagy egy név nélküli adag (igével, tárgyraggal, egységgel)
    kimegy; vagy a szabály neve nem az, ami elsült.
  */
  it("a puszta térfogat, a mért érték és a mérés gyakorisága nem adag, tartománnyal sem", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const answer of [
      "A lámpát napi 8-10 órán át érdemes működtetni.",
      "Hetente 1-2 alkalommal mérd a nitrátot, a cél 5–10 ppm.",
      "Egy 200 literes akváriumnál napi 2-3 liter is elpárologhat.",
      "A KH legyen 8–12 dKH, hetente mérd.",
      "A habtartályt hetente 1-2 alkalommal ürítsd.",
      "Naponta 3.",
      // a dosing verb next to a range: the range's first number is no bare count
      "Pótold hetente a párolgást, napi 2-3 liter is elmehet.",
      "Adj a lámpának napi 8-10 órás megvilágítást."
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  // the third question-set run (2026-11-16): the ATO answer was swapped on a multiplicative suffix
  it("a szorzó toldalék (-szor, -szer, -ször) nem puszta szám, egy adagolási ige mellett sem", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const answer of [
      "Az ATO naponta 2-3-szor pótolja az elpárolgott vizet.",
      "Hetente 5-ször pótolja a vizet.",
      "Naponta 2-szer pótold a párolgást.",
      "A 2-szori pótlás naponta elég."
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  /*
    THE QUESTION-SET RUN OF 2026-11-17 18:00 UTC (card 15e38019, task t-20261117-ai-dose-guard-gyakorisag; acrobot 55011): two of its three
    swapped answers were no dose, and the guard read a FREQUENCY and a LIST NUMBER as a bare count next to "naponta" and "pótol-".
    Measured on the main before the change: the times sign "×" blocked (given-count) while "x" and "-szor" passed, and a list marker
    ("1.", "1)") at a line's start counted as the number. WHAT TURNS IT RED: either sentence leaving the answer replaced; a list marker or
    the times sign hiding a REAL given count or an amount with a unit.
  */
  it("a × gyakoriság-jel és a listajel nem puszta szám (a -szor és az x már így van)", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const answer of [
      "- nem tudod vállalni, hogy **naponta 1–2× kézzel pótolsz RO‑vizet** mindig azonos időben",
      "Az ATO helyett naponta 2× kézzel pótold a párolgást.",
      "1. Egy hétig kézzel pótold az RO‑vizet, és **írd fel naponta, mennyi fogy**",
      "2) Hetente egyszer pótold az RO-vizet, és írd fel naponta, mennyi fogy"
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  it("a listajel és a × jel nem rejt el valódi adagot: a tárgyragos szám és a mennyiség egységgel továbbra is fennakad", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const [answer, rule] of [
      ["1. Adjon 3-at naponta.", "given-count"],
      ["2) Adj naponta 2-t.", "given-count"],
      // a number that opens the sentence with no point or bracket is the sentence's own count, not a list marker
      ["3-at adjon naponta.", "given-count"],
      ["- 1. Adagolj naponta 3-at.", "given-count"],
      ["1. Adj naponta 3 csepp készítményt.", "no-fixed-dose"],
      ["Adagolj naponta 3× 2 ml-t 100 literre.", "no-fixed-dose"],
      // a decimal point is no list marker: "1.5 ml" is an amount
      ["1.5 ml naponta 100 literre.", "no-fixed-dose"]
    ] as const) {
      const result = guardAnswerDoses(answer, empty);
      assert.equal(result.ok, false, answer);
      assert.equal(result.ok ? null : result.rule, rule, answer);
    }
  });

  /*
    THE QUESTION-SET RUN OF 2026-11-17 21:15 UTC (card 89a6ba86, task t-20261117-ai-dose-guard-kepletek; acrobot 55223): two more whole answers were swapped
    (4469 characters and 3042 lost, measured by the size field): "Heti 1-2x meres ... (szenforras-adagolas, biopellet, NO3-PO4 redukalo rendszerek)" and
    "atlagosan 2,5 liter parolog el naponta -> 2,5 x 7 = 17,5 liter". Measured on the main: the first passes WITHOUT "NO3-PO4" (the range and the times sign are
    already handled), so the digit of the formula was read as a bare count next to "heti" and "adagolas"; the second is arithmetic on a volume, its "7" read as
    the count. WHAT TURNS IT RED: either sentence swapped; a formula's digit or an equation's operand hiding a REAL given count, or an amount with a unit.
  */
  it("a képlet számjegye (NO3, PO4) és a puszta számokból álló egyenlet nem puszta szám", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const answer of [
      "- **Heti 1–2×** mérés javasolt, főleg, ha tápanyagszabályzást használsz (szénforrás-adagolás, biopellet, NO3-PO4 redukáló rendszerek)",
      "Naponta mérd a CO2-t, ha szénforrás-adagolást használsz.",
      "- Ha azt látod, hogy átlagosan 2,5 liter párolog el naponta → 2,5 × 7 = 17,5 liter → egy **kb. 20 literes tartály elég",
      "Átlagosan 2,5 liter párolog el naponta, vagyis 2,5 x 7 = 17,5 liter hetente."
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  it("a képlet és az egyenlet mellett a valódi adag továbbra is fennakad: tárgyragos szám, egység, mennyiség egységgel", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const [answer, rule] of [
      ["A NO3-PO4 csökkentéséhez adj naponta 5-öt a készítményből.", "given-count"],
      ["Adjon naponta 3-at, ha a PO4 magas.", "given-count"],
      ["Adagolj naponta 2 × 5 = 10 csepp készítményt 100 literre.", "no-fixed-dose"],
      // barracuda on #122: the RESULT of an equation is not taken out, so a counted thing given still blocks
      ["Adj naponta 2 × 5 = 10-et.", "given-count"],
      ["Naponta 2 x 3 = 6-ot adj belőle.", "given-count"],
      ["Adj naponta 3 × 2 ml-t 100 literre.", "no-fixed-dose"],
      ["Adj naponta 2 × 5 ml készítményt.", "no-fixed-dose"],
      // a number with a unit next to a formula is still an amount
      ["A NO3 miatt adj 2 ml-t 100 literre naponta.", "no-fixed-dose"]
    ] as const) {
      const result = guardAnswerDoses(answer, empty);
      assert.equal(result.ok, false, answer);
      assert.equal(result.ok ? null : result.rule, rule, answer);
    }
  });

  it("a név nélküli adag igével, tárgyraggal vagy egységgel továbbra is fennakad, és a szabály neve a válaszban", () => {
    const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };
    for (const [answer, rule] of [
      ["Adjon 3-at naponta.", "given-count"],
      ["Adj naponta 2-t.", "given-count"],
      ["Adagolj naponta 2-3 alkalommal 3-at.", "given-count"],
      ["Csepegtess naponta 3-4-et 100 literre.", "given-count"],
      ["Adagolj hetente 2-3-at.", "given-count"],
      ["Tegyél naponta 2 kupakot 100 literre.", "other-unit"],
      // an amount per volume, with no verb and no unit (barracuda, #99)
      ["Az adag 100 literenként napi 2.", "per-volume-count"],
      ["Hetente 1 jut 100 literre.", "per-volume-count"],
      // a bare count next to a volume that is no rate ("literes"): the bare-count-plus-volume reading
      ["Az Ön 300 literes akváriumába napi 2.", "per-volume-count"],
      ["Naponta 2-3 ml-t adj.", "no-fixed-dose"],
      // the accusative stays a count after the suffix change (third run, ATO)
      ["Pótold naponta 2-3-at.", "given-count"],
      // a target and a difference carry an amount: only the multiplicative suffix is no count (barracuda, #101)
      ["Növeld az adagolást napi 3-ra.", "given-count"],
      ["Adagolj naponta 2-vel többet.", "given-count"],
      ["Pótold naponta, 3-mal kevesebbet, mint tegnap.", "given-count"],
      // the multiplier adjective multiplies an amount (barracuda, #101 v2)
      ["Adagold naponta a 2-szeres adagot.", "given-count"],
      ["Adj 1,5-szeres mennyiséget hetente.", "given-count"]
    ] as const) {
      const result = guardAnswerDoses(answer, empty);
      assert.equal(result.ok, false, answer);
      assert.equal((result as { rule?: string }).rule, rule, answer);
    }
    assert.equal(
      (guardAnswerDoses("Naponta 3 csepp 100 literenként.", catalogue) as { rule?: string }).rule,
      "not-in-catalogue"
    );
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
      headers: { authorization: `Bearer ${API_TOKEN}`, "x-client-key": "stage-test-client" },
      payload: { message: "Mennyit adagoljak?" }
    });
    await app.close();
    return { body: response.json() as { answer: string; doseGuard: string | null; doseGuardRule: string | null }, saved };
  };

  it("egy kitalált adag helyett a biztonságos mondat megy ki és tárolódik", async () => {
    const { body, saved } = await run("Naponta 2 ml 100 literenként.");
    assert.deepEqual(
      [body.answer, body.doseGuard, body.doseGuardRule, saved],
      [DOSE_GUARD_FALLBACK, "NO_FIXED_DOSE", "no-fixed-dose", [DOSE_GUARD_FALLBACK]]
    );
  });

  it("adag nélküli válasz változatlan", async () => {
    const { body } = await run("Előbb mérje a KH-t.");
    assert.deepEqual([body.answer, body.doseGuard], ["Előbb mérje a KH-t.", null]);
  });
});

/*
  THE PUMP AS A NOUN (card 15e38019, task t-20261117-ai-dose-guard-pumpa; acrobot 55013). The question-set run of 2026-11-17 17:45 UTC lost
  an answer on "... 150-300 liter, ez mar logisztikai kerdes (hordok, pumpak, keverotartaly)": "pumpak" (the plural noun, water pumps) was read as a
  dosing-pump unit next to a volume. WHAT TURNS IT RED: the plural noun next to a volume or a period replacing the answer; a pump DOSE
  (a number or a word number with "pumpa", "pumpat", "pumpaval") leaving.
*/
describe("a pumpa mint főnév nem adagolási egység, a pumpa mint adag igen", () => {
  const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };

  it("a többes számú főnév (pumpák) egy felsorolásban vagy egy gyakoriság mellett nem adag", () => {
    for (const answer of [
      "- **Részleges vízcsere:** 3000 liternél még egy 5–10%-os vízcsere is 150–300 liter, ez már logisztikai kérdés (hordók, pumpák, keverőtartály)",
      "A pumpák naponta kétszer indulnak a 200 literes medencében."
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  it("a pumpa adagként (számmal, szám-szóval, ragozva) továbbra is fennakad", () => {
    for (const [answer, rule] of [
      ["Egy pumpa naponta elég 100 literre.", "no-fixed-dose"],
      ["Adj naponta két pumpát 100 literre.", "no-fixed-dose"],
      ["Nyomj egy pumpával naponta 100 literre.", "no-fixed-dose"],
      ["Adj naponta 2 pumpát 100 literre.", "other-unit"],
      ["Naponta 2 pumpa 100 literhez.", "other-unit"],
      // the plural ACCUSATIVE is something given, so it stays a dose word
      ["Naponta két pumpákat adj 100 literre.", "no-fixed-dose"]
    ] as const) {
      const result = guardAnswerDoses(answer, empty);
      assert.equal(result.ok, false, answer);
      assert.equal(result.ok ? null : result.rule, rule, answer);
    }
  });
});

/*
  THE PUMP AS THE DEVICE IN ONE SINGULAR NOMINATIVE (card 89a6ba86; acrobot 58779). The question-set run of 2026-11-20 20:15 UTC lost a 5467-character answer about
  the daily work of an automated tank to "Ha automatizálsz (ATO, adagoló pumpa, vezérlő, ...), a napi manuális munka nem feltétlen sok": "pumpa" next to "napi". WHAT TURNS
  IT RED: the device sentence replacing the answer; a pump DOSE leaving (a quantity word ANYWHERE earlier in the sentence than the nominative, or the case forms), the plural accusative
  and the numbers with "pumpa" among them.
*/
describe("az eszköz-pumpa (egyes szám alanyeset) nem adagolási egység", () => {
  const empty: ProductSearchOutcome = { ok: true, result: { hits: [] } };

  it("az automatizálás mondata és az eszközt nevező mondatok egy gyakoriság mellett nem adagok", () => {
    for (const answer of [
      "Ha automatizálsz (ATO, adagoló pumpa, vezérlő, esetleg automata vízcsere\u2011rendszer), a **napi manuális munka nem feltétlen sok** – de:",
      "Az ATO pumpa naponta kétszer indul.",
      "A keringető pumpa napi 24 órában megy egy 200 literes medencében.",
      "Heti ellenőrzés elég a pumpa és a szenzor állapotára."
    ])
      assert.deepEqual(guardAnswerDoses(answer, empty), { ok: true, doseStatements: 0 }, answer);
  });

  it("a mennyiség után álló pumpa továbbra is adag, minden alakjában", () => {
    for (const [answer, rule] of [
      ["Egy pumpa naponta elég 100 literre.", "no-fixed-dose"],
      ["Naponta egy kis pumpa 100 literre.", "no-fixed-dose"],
      ["Naponta két adagoló pumpa 100 literre.", "no-fixed-dose"],
      // THE QUANTITY ANYWHERE EARLIER IN THE SENTENCE, however many words stand between it and the pump (barracuda, #125)
      ["Naponta egy jó nagy kézi pumpa 100 literre.", "no-fixed-dose"],
      ["Naponta egy teljes, lassan lenyomott pumpa elég.", "no-fixed-dose"],
      ["Heti két alkalommal, egy nagyon óvatos, kis erővel lenyomott pumpa 100 literre.", "no-fixed-dose"],
      ["Adj naponta két pumpát 100 literre.", "no-fixed-dose"],
      ["Nyomj egy pumpával naponta 100 literre.", "no-fixed-dose"],
      ["Naponta két pumpákat adj 100 literre.", "no-fixed-dose"],
      ["Adj naponta 2 pumpát 100 literre.", "other-unit"],
      ["Naponta 2 pumpa 100 literhez.", "other-unit"],
      // THE CASE FORMS WITH NO QUANTITY WORD stay unit words too: only the bare nominative is the device
      ["Nyomj naponta pumpát 100 literre.", "no-fixed-dose"],
      ["Pumpával adagolj naponta 100 literre.", "no-fixed-dose"],
      ["Naponta pumpákat adj 100 literre.", "no-fixed-dose"]
    ] as const) {
      const result = guardAnswerDoses(answer, empty);
      assert.equal(result.ok, false, answer);
      assert.equal(result.ok ? null : result.rule, rule, answer);
    }
  });
});

/*
  A TEST STEP'S AMOUNT IS NO DOSE (acrobot 58933; the cron guard's run of 2026-11-20 21:30 UTC, server e867b6fe, lost a 4065-character nitrate
  answer to "(pl. 5 vagy 10 ml, amit a teszt ír)"). WHAT TURNS IT RED: the sample volume in a test vial replaced; the sentence split at "pl.",
  cutting the vial away; a real dose let through because the sentence names a test vessel too (with a period, a water volume or the aquarium
  as the target it stays a dose); an abbreviation point hiding a dose.
*/
describe("a teszt mintatérfogata nem adag", () => {
  const none: ProductSearchOutcome = { ok: true, result: { hits: [] } };

  it("a nitrátmérés válaszának lépése (a cron-futás szövege) nem csere", () => {
    const answer = [
      "### 1. Csepegtetős (kolorimetriás) teszt",
      "**Általános lépések (mindig a saját teszted leírása a mérvadó):**",
      "1. **Mintavétel**  ",
      "   - Vegyél ki adott mennyiségű akváriumvizet a teszt fiolájába (pl. 5 vagy 10 ml, amit a teszt ír).",
      "   - Ügyelj, hogy a fiola tiszta, ne legyen benne vegyszer- vagy sómaradék."
    ].join("\n");
    assert.deepEqual(guardAnswerDoses(answer, none), { ok: true, doseStatements: 0 });
  });

  it("a mintához, fiolához, küvettához mért mennyiség tesztlépés", () => {
    for (const answer of [
      "Cseppents 5 cseppet a mintához.",
      "Töltsd a küvettát 10 ml-ig a mintavízzel.",
      "Fill the vial with 5 ml of tank water.",
      "A fecskendővel szívj fel 2 ml mintát."
    ])
      assert.deepEqual(guardAnswerDoses(answer, none), { ok: true, doseStatements: 0 }, answer);
  });

  it("egy valódi adag továbbra is fennakad: időszakkal, vízmennyiséggel, vagy ha az akvárium a célpont", () => {
    for (const answer of [
      "Adagolj naponta 5 ml-t.",
      "Tegyél 5 ml-t a mintavétel után az akváriumba.",
      "Cseppents a fiolába naponta 5 cseppet.",
      "A mintához hasonlóan adj 10 ml-t 100 literre.",
      // an abbreviation point hides nothing: the period earlier in the sentence still counts
      "Add 5 ml of the sample water into the tank.",
      // barracuda on #132: the syringe doses, and the target list reads "szump", "vízbe", "áramlásba", "technikába"
      "A kezdő adag 5 ml, fecskendővel kimérve.",
      "Mérj ki fecskendővel 10 ml-t, és csepegtesd lassan az áramlásba.",
      "Fiolával mérj ki 5 ml-t, és öntsd a szumpba.",
      "Mérj ki a fiolával 5 ml-t, és öntsd a vízbe.",
      "A mintavétel után 5 ml-t tegyél a technikába.",
      "Kb. 5 ml naponta elég.",
      "Naponta adj kb. 5 ml-t."
    ]) {
      const result = guardAnswerDoses(answer, none);
      assert.equal(result.ok, false, answer);
    }
  });
});

/*
  THE CRON GUARD'S RUN OF 2026-11-20 21:45 UTC (server 45c97c50, acrobot 58977): two false replacements, and a litre dose main let through.
  WHAT TURNS IT RED: the vessel missed inside a compound ("Mérőfiolába"); the operands of a sum that comes out in litres read as a bare
  count ("14 + tartalék = 18–20 liter"); a litre dose with a strong dosing verb let through; the water, the evaporation, a tank's size or
  the dosing device read as a litre dose; "Kalkwasser" read as water.
*/
describe("összetett mintaedény, literben kijövő összeg, literes adag", () => {
  const none: ProductSearchOutcome = { ok: true, result: { hits: [] } };

  it("a cron-futás két mondata nem csere", () => {
    for (const answer of [
      "1. Mérőfiolába pontosan kimérsz egy adott mennyiségű akváriumvizet (pl. 5 vagy 10 ml)",
      "- Ha napi 2 liter jön ki, akkor már **kb. 14 + tartalék = 18–20 liter** lenne a kényelmes heti méret",
      "Hetente 14 + 2 = 16 liter vizet pótolj.",
      "Töltsd a mérőküvettát 10 ml-ig.",
      "A tesztkémcsőbe 5 ml kell."
    ])
      assert.deepEqual(guardAnswerDoses(answer, none), { ok: true, doseStatements: 0 }, answer);
  });

  it("a víz, a párolgás, a medence mérete és az adagoló eszköz nem literes adag", () => {
    for (const answer of [
      "Az ATO adagolja a napi 2 liter vizet.",
      "Az ATO adagolja a napi 2 liter párolgást.",
      "Napi 2 liter RO-vizet adagol a rendszer.",
      "The ATO doses 2 liters of RO water a day.",
      "Ha napi 3 litert pótolsz, a sótartalom stabil marad.",
      "Egy 3000 literes rendszert automata adagolókkal napi fél óra alatt el lehet látni.",
      "Az automata adagolók a heti 20 liter cserénél is működnek.",
      "Egy 3000 literes rendszerben naponta adagolj a címke szerint.",
      "Napi 2 liter desztillált vizet adagol az ATO.",
      // "kalkul-" is no additive: a calculation next to the ATO's water
      "Kalkulálj napi 2 liter párolgással, ezt adagolja az ATO."
    ])
      assert.deepEqual(guardAnswerDoses(answer, none), { ok: true, doseStatements: 0 }, answer);
  });

  it("egy valódi literes adag csere, és az összeg mellett adott darab is az marad", () => {
    for (const [answer, rule] of [
      ["Napi 2 liter kalkwasser-oldatot adagolj.", "litre-dose"],
      ["Adagolj naponta 2 liter kalkwassert.", "litre-dose"],
      ["Napi 2 liter kalkwassert adagolj a feltöltővízbe.", "litre-dose"],
      ["Dose 2 liters of kalkwasser daily.", "litre-dose"],
      ["Adagolj naponta 2 litert.", "litre-dose"],
      // barracuda on #134: "mészvíz" is Kalkwasser, a target is no volume noun, and a named additive opens the rule to a weak verb
      ["Adagolj naponta 2 liter mészvizet.", "litre-dose"],
      ["Adagolj naponta 2 liter kalkwasseres vizet.", "litre-dose"],
      ["Adagolj naponta 2 liter kalkwasser-vizet.", "litre-dose"],
      ["Napi 2 liter kalkwassert a vízbe adagolj.", "litre-dose"],
      ["Adj naponta 2 liter kalkwassert.", "litre-dose"],
      ["Pótolj naponta 2 liter mészvizet.", "litre-dose"],
      // with no additive named: only plain water is water, and a target is no volume noun
      ["Adagolj naponta 2 liter jódvizet.", "litre-dose"],
      ["Napi 2 litert a vízbe adagolj.", "litre-dose"],
      ["Adagolj naponta 2 liter Seewasser-Konzentrat.", "litre-dose"],
      // the sum is taken out only when it comes out in litres, and only its left side
      ["Hetente 2 + 1-et adj, ez 100 literre = 3 liter.", "given-count"],
      ["Hetente 14 + 2 = 16 liter vízhez adj 3-at.", "given-count"],
      ["Naponta 2 + 1 = 3 cseppet adj 100 literre.", "no-fixed-dose"]
    ] as const) {
      const result = guardAnswerDoses(answer, none);
      assert.equal(result.ok, false, answer);
      assert.equal(result.ok ? null : result.rule, rule, answer);
    }
  });
});
