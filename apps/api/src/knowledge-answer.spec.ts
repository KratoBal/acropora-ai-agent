import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type AppDependencies } from "./app.js";
import {
  MAX_SENTENCES,
  guardKnowledgeAnswer,
  knowledgeAnswerInstructions,
  marked,
  parseKnowledgeAnswerRequest,
  type KnowledgeAnswerRequest
} from "./knowledge-answer.js";

/**
 * THE MODE A ANSWER (Acropora OS research knowledge base, S6). WHAT TURNS IT
 * RED: a sentence that is not, letter for letter, the statement of the claim
 * it names leaves this service (one changed word is enough); a claim the OS
 * did not send; an unnamed sentence that is not a fixed one; the marker not
 * written as the OS gate reads it; the route without its token or shape
 * check. Invented statements only.
 */
const LOW =
  "Kutatás szerint egy kontrollált kísérletben a zátonyon 0,05 mg/l foszfát csökkentette az Acropora kalcifikációját.";
const HIGH =
  "Akvarisztikai tapasztalat szerint, egy akvarisztikai beszámoló szerint az otthoni akváriumban 0,05 mg/l foszfát növelte az Acropora színezetét.";
const INTRO = "Az alábbi válasz csak a tudásbázis elfogadott állításaira épül.";
const REQUEST: KnowledgeAnswerRequest = {
  question: "Mennyi foszfát jó egy SPS-akváriumban?",
  claims: [
    { id: "c1sci", statement: LOW, contradicts: ["c2hob"] },
    { id: "c2hob", statement: HIGH, contradicts: ["c1sci"] }
  ],
  fixedSentences: [INTRO]
};
const answer = (...sentences: { claim: string | null; text: string }[]) => JSON.stringify({ sentences });

function guarded(modelText: string) {
  const g = guardKnowledgeAnswer(modelText, REQUEST);
  assert.ok(g.ok, modelText);
  return g;
}

describe("the guard", () => {
  it("keeps statements copied letter for letter and a fixed sentence, and writes the markers", () => {
    const g = guarded(answer({ claim: null, text: INTRO }, { claim: "c1sci", text: LOW }, { claim: "c2hob", text: HIGH }));
    assert.deepEqual(g.refused, []);
    assert.equal(
      g.answer,
      `${INTRO} ${LOW.replace(/\.$/, " [[claim:c1sci]].")} ${HIGH.replace(/\.$/, " [[claim:c2hob]].")}`
    );
  });

  it("drops a statement with one word changed, and a merged one", () => {
    const g = guarded(
      answer(
        { claim: "c1sci", text: LOW.replace("csökkentette", "erősen csökkentette") },
        { claim: "c1sci", text: `${LOW} ${HIGH}` },
        { claim: "c2hob", text: HIGH.replace("0,05", "0,1") }
      )
    );
    assert.deepEqual(g.refused.map((r) => r.refusal), ["STATEMENT_CHANGED", "STATEMENT_CHANGED", "STATEMENT_CHANGED"]);
    assert.equal(g.answer, "");
  });

  it("drops a statement under another claim's id, a claim not sent, and a repeat", () => {
    const g = guarded(
      answer(
        { claim: "c2hob", text: LOW },
        { claim: "c9out", text: LOW },
        { claim: "c1sci", text: LOW },
        { claim: "c1sci", text: LOW }
      )
    );
    assert.deepEqual(g.refused, [
      { index: 0, refusal: "STATEMENT_CHANGED" },
      { index: 1, refusal: "CLAIM_NOT_SENT" },
      { index: 3, refusal: "CLAIM_REPEATED" }
    ]);
    assert.deepEqual(g.sentences.map((s) => s.claimId), ["c1sci"]);
  });

  it("an own sentence without a claim goes nowhere, even a harmless one; a statement without its id neither", () => {
    const g = guarded(answer({ claim: null, text: "Az SPS-korallok szeretik a stabil vizet." }, { claim: null, text: LOW }));
    assert.deepEqual(g.refused.map((r) => r.refusal), ["NOT_A_FIXED_SENTENCE", "NOT_A_FIXED_SENTENCE"]);
  });

  it("whitespace is not a change; a broken entry and too many entries are refused", () => {
    const g = guarded(answer({ claim: "c1sci", text: `  ${LOW.replace(" ", "\n")} ` }));
    assert.deepEqual(g.refused, []);
    const broken = guardKnowledgeAnswer(JSON.stringify({ sentences: [{ claim: 7, text: LOW }, "x"] }), REQUEST);
    assert.ok(broken.ok);
    assert.deepEqual(broken.refused.map((r) => r.refusal), ["NOT_AN_ENTRY", "NOT_AN_ENTRY"]);
    const many = guardKnowledgeAnswer(
      JSON.stringify({ sentences: Array.from({ length: MAX_SENTENCES + 1 }, () => ({ claim: null, text: INTRO })) }),
      REQUEST
    );
    assert.ok(many.ok);
    assert.deepEqual(many.refused, [{ index: MAX_SENTENCES, refusal: "TOO_MANY_SENTENCES" }]);
  });

  it("an empty list is an answer with nothing in it; not JSON is a refusal", () => {
    assert.equal(guarded(answer()).answer, "");
    assert.deepEqual(guardKnowledgeAnswer("nem json", REQUEST), { ok: false, refusal: "NOT_JSON" });
    assert.deepEqual(guardKnowledgeAnswer('{"text": "x"}', REQUEST), { ok: false, refusal: "NO_SENTENCES_LIST" });
  });

  it("the marker goes before the final punctuation, and a statement without one gets a period", () => {
    assert.equal(marked("A kalcifikáció csökken.", "k1"), "A kalcifikáció csökken [[claim:k1]].");
    assert.equal(marked("Csökken?!", "k1"), "Csökken [[claim:k1]]?!");
    assert.equal(marked("A kalcifikáció csökken", "k1"), "A kalcifikáció csökken [[claim:k1]].");
  });
});

describe("the request", () => {
  it("accepts the OS's shape and normalises the whitespace of a statement", () => {
    const p = parseKnowledgeAnswerRequest({ ...REQUEST, claims: [{ id: "k1", statement: `${LOW}  ` }] });
    assert.ok(p.ok);
    assert.deepEqual(p.request.claims, [{ id: "k1", statement: LOW, contradicts: [] }]);
  });

  it("refuses what the guard could misread", () => {
    for (const body of [
      { ...REQUEST, question: "" },
      { ...REQUEST, claims: [{ id: "k 1", statement: LOW }] },
      { ...REQUEST, claims: [REQUEST.claims[0], REQUEST.claims[0]] },
      { ...REQUEST, claims: [{ id: "k1", statement: `${LOW} [[claim:x]]` }] },
      { ...REQUEST, claims: [{ id: "k1", statement: LOW, contradicts: ["k2"] }] },
      { ...REQUEST, claims: [{ id: "k1", statement: LOW, contradicts: ["k1"] }] },
      { ...REQUEST, fixedSentences: [] },
      null
    ])
      assert.equal(parseKnowledgeAnswerRequest(body).ok, false, JSON.stringify(body)?.slice(0, 80));
  });
});

describe("POST /v1/knowledge-answers", () => {
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
      url: "/v1/knowledge-answers",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json"
      },
      payload: payload as Record<string, unknown>
    });

  it("ANSWER-ROUTE: the token gate, the shape check, a guarded answer, and a refusal", async () => {
    modelText = answer({ claim: "c1sci", text: LOW }, { claim: null, text: "Saját mondat." });
    const unauthorized = await call(REQUEST, null);
    const malformed = await call({ question: "x" });
    const answered = await call(REQUEST);
    assert.deepEqual([unauthorized.statusCode, malformed.statusCode, answered.statusCode], [401, 400, 200]);
    const body = answered.json();
    assert.equal(body.answer, LOW.replace(/\.$/, " [[claim:c1sci]]."));
    assert.deepEqual(body.refused, [{ index: 1, refusal: "NOT_A_FIXED_SENTENCE" }]);
    assert.equal(body.answeredBy, `${process.env.OPENAI_MODEL ?? "gpt-5.1"} knowledge-answer/v1`);
    // the model was told the rules, and was given the question and the statements as data
    assert.equal(handed.instructions, knowledgeAnswerInstructions());
    assert.match(String(handed.instructions), /copied character for character/);
    assert.match(JSON.stringify(handed.input), /SPS-akváriumban/);
    assert.match(JSON.stringify(handed.input), /c2hob/);

    modelText = "nem json";
    const refused = await call(REQUEST);
    assert.deepEqual([refused.statusCode, refused.json().refusal], [200, "NOT_JSON"]);
  });
});
