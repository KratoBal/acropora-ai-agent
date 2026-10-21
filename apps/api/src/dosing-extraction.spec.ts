import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type AppDependencies } from "./app.js";
import { guardDosingAnswer, parseDosingRequest } from "./dosing-extraction.js";

/**
 * THE DOSING EXTRACTION (Acropora OS card 85c38ab1). WHAT TURNS IT RED: an
 * excerpt the page does not hold leaves this service; a fixed dose without its
 * excerpt, a test-dependent answer without its guidance or tests; an unknown
 * mode or test code; the route without its token or shape check. Invented page
 * text only.
 */
const PAGE = [
  "Kitalált Jód 100 ml",
  "Adagolás:   napi 1 csepp 100 liter vízre.",
  "Tartalom: 100 ml."
].join("\n");
const TEST_PAGE = "Kitalált Ca. Az adagolás a heti kalcium- és KH-mérés alapján történik: adjon annyit, amennyi a fogyasztást pótolja.";

const answer = (over: Record<string, unknown>) =>
  JSON.stringify({ mode: "NO_DATA", dose: null, tests: [], guidance: null, excerpt: null, reason: "", ...over });

describe("a modell válaszának őre", () => {
  it("fix adag: a kivonat a lapon áll (a szóközök nem számítanak), és átmegy", () => {
    const r = guardDosingAnswer(
      answer({ mode: "FIXED", dose: "1 drop/100 L/day", excerpt: "Adagolás: napi 1 csepp 100 liter vízre." }),
      PAGE
    );
    assert.deepEqual(r, {
      ok: true,
      answer: {
        mode: "FIXED",
        dose: "1 drop/100 L/day",
        tests: [],
        guidance: null,
        excerpt: "Adagolás: napi 1 csepp 100 liter vízre.",
        reason: ""
      }
    });
  });

  it("a lapon nem álló kivonat nem megy ki, akármilyen hihető", () => {
    const r = guardDosingAnswer(
      answer({ mode: "FIXED", dose: "2 drop/100 L/day", excerpt: "Adagolás: napi 2 csepp 100 liter vízre." }),
      PAGE
    );
    assert.deepEqual(r, { ok: false, refusal: "EXCERPT_NOT_IN_PAGE" });
  });

  it("tesztfüggő: az útmutató is a lapról jön, a mérendő kódok rendezve, egyszer", () => {
    const guidance = "Az adagolás a heti kalcium- és KH-mérés alapján történik";
    const r = guardDosingAnswer(
      answer({ mode: "TEST_DEPENDENT", tests: ["kh", "KALCIUM", "KH"], guidance, excerpt: guidance }),
      TEST_PAGE
    );
    assert.ok(r.ok);
    assert.deepEqual(r.ok && [r.answer.tests, r.answer.dose], [["KALCIUM", "KH"], null]);
    assert.deepEqual(
      guardDosingAnswer(answer({ mode: "TEST_DEPENDENT", tests: ["KH"], guidance: "Mérjen naponta.", excerpt: guidance }), TEST_PAGE),
      { ok: false, refusal: "EXCERPT_NOT_IN_PAGE" }
    );
  });

  it("a hiányos vagy ismeretlen válasz emberhez megy, megnevezett okkal", () => {
    const cases: [string, string][] = [
      ["nem JSON", "NOT_JSON"],
      [answer({ mode: "DAILY" }), "UNKNOWN_MODE"],
      [answer({ mode: "TEST_DEPENDENT", tests: ["CALCIUM"] }), "UNKNOWN_TEST_CODE"],
      [answer({ mode: "FIXED", dose: "1 drop/100 L/day" }), "FIXED_WITHOUT_DOSE_OR_EXCERPT"],
      [answer({ mode: "TEST_DEPENDENT", tests: [], guidance: "Adagolás:", excerpt: "Adagolás:" }), "TEST_DEPENDENT_WITHOUT_GUIDANCE"],
      [answer({ mode: "FIXED", dose: "x", excerpt: "a".repeat(401) }), "EXCERPT_TOO_LONG"]
    ];
    for (const [text, refusal] of cases)
      assert.deepEqual(guardDosingAnswer(text, PAGE), { ok: false, refusal }, text.slice(0, 60));
  });

  // barracuda, #40: a true excerpt next to a wrong number is what the excerpt check alone lets through
  it("a fix adag minden száma a kivonatból jön; ezres csoport és gallon emberhez megy", () => {
    const page = [
      "Add 10 ml per 1,000 l weekly.",
      "Dose 1 ml per 25 gallons daily.",
      "Dose 2 ml per 100 l, 2-3 times per week.",
      "Adagolás: 0,5 ml 100 literre naponta."
    ].join("\n");
    const fixed = (dose: string, excerpt: string) =>
      guardDosingAnswer(answer({ mode: "FIXED", dose, excerpt }), page);
    assert.deepEqual(fixed("10 ml/1 L/week", "Add 10 ml per 1,000 l weekly."), {
      ok: false,
      refusal: "DOSE_NUMBER_NOT_IN_EXCERPT"
    });
    assert.deepEqual(fixed("10 ml/1000 L/week", "Add 10 ml per 1,000 l weekly."), {
      ok: false,
      refusal: "DOSE_NUMBER_NOT_IN_EXCERPT"
    });
    assert.deepEqual(fixed("10 ml/1,000 L/week", "Add 10 ml per 1,000 l weekly."), {
      ok: false,
      refusal: "THOUSANDS_GROUP"
    });
    assert.deepEqual(fixed("1 ml/100 L/day", "Dose 1 ml per 25 gallons daily."), {
      ok: false,
      refusal: "DOSE_NUMBER_NOT_IN_EXCERPT"
    });
    assert.deepEqual(fixed("1 ml/25 L/day", "Dose 1 ml per 25 gallons daily."), {
      ok: false,
      refusal: "OTHER_UNIT"
    });
    // a fragment of the page: true, but the dose's numbers are not in it
    assert.deepEqual(fixed("1 ml/100 L/day", "ml"), { ok: false, refusal: "DOSE_NUMBER_NOT_IN_EXCERPT" });
    // controls: the right numbers pass, the frequency's too, and a decimal comma is a point
    assert.equal(fixed("2 ml/100 L, 2-3/week", "Dose 2 ml per 100 l, 2-3 times per week.").ok, true);
    assert.equal(fixed("0.5 ml/100 L/day", "Adagolás: 0,5 ml 100 literre naponta.").ok, true);
  });

  it("a mérendő paraméter a kivonatban vagy az útmutatóban néven áll", () => {
    const guidance = "Az adagolás a heti kalcium- és KH-mérés alapján történik";
    const tested = (tests: string[]) =>
      guardDosingAnswer(answer({ mode: "TEST_DEPENDENT", tests, guidance, excerpt: guidance }), TEST_PAGE);
    assert.equal(tested(["KALCIUM", "KH"]).ok, true);
    assert.deepEqual(tested(["KALCIUM", "MAGNEZIUM"]), { ok: false, refusal: "TEST_CODE_NOT_IN_TEXT" });
  });

  it("az indoklás hossza korlátos", () => {
    const r = guardDosingAnswer(answer({ reason: "x".repeat(1000) }), PAGE);
    assert.equal(r.ok && r.answer.reason.length, 300);
  });

  it("nincs adat: kivonat nélkül is érvényes válasz, és kódkerítés mögül is olvasható", () => {
    const r = guardDosingAnswer("```json\n" + answer({ reason: "nincs adag a lapon" }) + "\n```", PAGE);
    assert.deepEqual(r.ok && [r.answer.mode, r.answer.reason], ["NO_DATA", "nincs adag a lapon"]);
  });

  it("a kérés alakja", () => {
    assert.equal(parseDosingRequest({ productName: "X", pageText: PAGE }).ok, true);
    assert.equal(parseDosingRequest({ productName: "", pageText: PAGE }).ok, false);
    assert.equal(parseDosingRequest({ productName: "X", pageText: "" }).ok, false);
    assert.equal(parseDosingRequest({ productName: "X", pageText: "a".repeat(60_001) }).ok, false);
    assert.equal(parseDosingRequest(null).ok, false);
  });
});

describe("POST /v1/dosing-extractions", () => {
  const API_TOKEN = "test-api-access-token";
  const saved = { ...process.env };
  let handed: { instructions?: unknown; input?: unknown } = {};
  let modelText = "";
  const modelClient = {
    responses: {
      create: async (parameters: { instructions?: unknown; input?: unknown }) => {
        handed = parameters;
        return { output_text: modelText };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;
  let app: ReturnType<typeof buildApp>;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    app = buildApp({ openai: modelClient });
    await app.ready();
  });

  after(async () => {
    await app.close();
    process.env = saved;
  });

  const call = (payload: unknown, token: string | null = API_TOKEN) =>
    app.inject({
      method: "POST",
      url: "/v1/dosing-extractions",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json"
      },
      payload: payload as Record<string, unknown>
    });

  it("DOSE-ROUTE: the token gate, the shape check, a guarded answer, and a refusal", async () => {
    const body = { productName: "Kitalált Jód 100 ml", pageText: PAGE };
    modelText = answer({ mode: "FIXED", dose: "1 drop/100 L/day", excerpt: "napi 1 csepp 100 liter vízre." });
    const unauthorized = await call(body, null);
    const malformed = await call({ productName: "X" });
    const answered = await call(body);
    assert.deepEqual([unauthorized.statusCode, malformed.statusCode, answered.statusCode], [401, 400, 200]);
    assert.deepEqual(
      [answered.json().mode, answered.json().dose, answered.json().model],
      ["FIXED", "1 drop/100 L/day", process.env.OPENAI_MODEL ?? "gpt-5.1"]
    );
    // the model was told the rules, and was given the page as data
    assert.match(String(handed.instructions), /copied character for character/);
    assert.match(JSON.stringify(handed.input), /Kitalált Jód/);

    modelText = answer({ mode: "FIXED", dose: "5 ml/100 L/day", excerpt: "napi 5 ml 100 liter vízre." });
    const refused = await call(body);
    assert.deepEqual([refused.statusCode, refused.json().refusal], [200, "EXCERPT_NOT_IN_PAGE"]);
  });
});
