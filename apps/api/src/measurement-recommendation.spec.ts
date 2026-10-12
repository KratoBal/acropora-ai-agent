import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type AppDependencies } from "./app.js";
import {
  guardRecommendationText,
  MAX_EXAMPLES,
  MEASUREMENT_RECOMMENDATION_INSTRUCTIONS,
  measurementRecommendationInput,
  NO_PRODUCT_SENTENCE,
  parseRecommendationRequest
} from "./measurement-recommendation.js";

/**
 * The water-measurement recommendation (Acropora OS card 2b3983e1, step 2).
 * Invented data throughout. Nothing here reaches OpenAI or the database.
 */

const deviation = {
  parameterCode: "KH",
  measured: 6,
  unit: "dKH",
  min: 7,
  max: 9,
  status: "WARN",
  direction: "LOW",
  trend: "IMPROVING"
};
const candidate = {
  productId: "cmp1",
  name: "Kitalált KH puffer",
  category: "Termékek > Nyomelemek",
  effects: [],
  basis: "CATEGORY"
};
const request = (over: Record<string, unknown> = {}) => ({
  waterType: "TENGERI",
  volumeLiters: 300,
  deviations: [deviation],
  candidates: [candidate],
  examples: [],
  ...over
});

/*
  THE UNVERIFIED MARK (Acropora OS #1673, t5-5). What turns these red: the
  parser dropping the mark (the model never sees it); a non-boolean mark let
  through; a confirmed candidate given a mark; the rule missing from the
  instructions.
*/
describe("the unverified candidate", () => {
  const parsed = (over: Record<string, unknown>) => {
    const result = parseRecommendationRequest(
      request({
        candidates: [
          { ...candidate, productId: "cmp1", basis: "JEV", ...over },
          { ...candidate, productId: "cmp2", basis: "JEV" }
        ]
      })
    );
    assert.equal(result.ok, true);
    return (result as { request: Parameters<typeof measurementRecommendationInput>[0] })
      .request;
  };
  const modelCandidates = (over: Record<string, unknown>) =>
    (
      JSON.parse(measurementRecommendationInput(parsed(over))) as {
        candidates: Record<string, unknown>[];
      }
    ).candidates;

  it("RECO-UNVERIFIED-IN: the mark reaches the model's input, a confirmed one gets none", () => {
    const [unverified, confirmed] = modelCandidates({ unverified: true });
    assert.equal(unverified.unverified, true);
    assert.equal("unverified" in confirmed, false);
  });

  it("RECO-UNVERIFIED-FALSE: an explicit false is the same as no mark", () => {
    const [first] = modelCandidates({ unverified: false });
    assert.equal("unverified" in first, false);
  });

  it("RECO-UNVERIFIED-SHAPE: a non-boolean mark is refused", () => {
    const result = parseRecommendationRequest(
      request({ candidates: [{ ...candidate, unverified: "yes" }] })
    );
    assert.deepEqual(result, { ok: false, error: "a candidate is malformed" });
  });

  it("RECO-UNVERIFIED-RULE: the instructions tell the model to word it cautiously", () => {
    assert.match(MEASUREMENT_RECOMMENDATION_INSTRUCTIONS, /"unverified": true/);
    assert.match(
      MEASUREMENT_RECOMMENDATION_INSTRUCTIONS,
      /Do not state its effect as a fact/
    );
  });
});

describe("parseRecommendationRequest", () => {
  it("RECO-PARSE: the OS's shape passes; a broken field is named", () => {
    const ok = parseRecommendationRequest(request());
    assert.equal(ok.ok, true);
    assert.deepEqual(
      [
        parseRecommendationRequest(request({ deviations: [] })),
        parseRecommendationRequest(
          request({
            examples: Array.from({ length: MAX_EXAMPLES + 1 }, () => ({
              deviations: [deviation],
              aiDraft: "a",
              approvedText: "b"
            }))
          })
        ),
        parseRecommendationRequest(
          request({ candidates: [{ ...candidate, productId: "a b" }] })
        ),
        parseRecommendationRequest(
          request({ deviations: [{ ...deviation, direction: "UP" }] })
        )
      ].map((result) => (result.ok ? "ok" : result.error)),
      [
        "deviations must hold 1 to 40 items",
        "examples must hold at most 3 items",
        "a candidate is malformed",
        "a deviation is malformed"
      ]
    );
  });
});

describe("guardRecommendationText", () => {
  it("RECO-GUARD: an id outside the candidates, and a malformed token, are removed", () => {
    assert.deepEqual(
      guardRecommendationText(
        "A KH alacsony: {{termek:cmp1}} segít, vagy {{termek:kitalalt}}, vagy {{termek: cmp1}}.",
        new Set(["cmp1"])
      ),
      {
        text: "A KH alacsony: {{termek:cmp1}} segít, vagy, vagy.",
        removedProductIds: ["kitalalt", " cmp1"]
      }
    );
  });

  it("RECO-NO-CANDIDATES: with no candidates every product goes, and the answer says there is none", () => {
    const guarded = guardRecommendationText(
      "Próbálja ezt: {{termek:cmp1}}. Ellenőrizze a vízcserét.",
      new Set()
    );
    assert.equal(
      guarded.text,
      `${NO_PRODUCT_SENTENCE} Próbálja ezt:. Ellenőrizze a vízcserét.`
    );
    assert.deepEqual(guarded.removedProductIds, ["cmp1"]);
    // said once, not twice, when the model already said it
    assert.equal(
      guardRecommendationText(NO_PRODUCT_SENTENCE, new Set()).text,
      NO_PRODUCT_SENTENCE
    );
  });
});

describe("POST /v1/measurement-recommendations", () => {
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
      url: "/v1/measurement-recommendations",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json"
      },
      payload: payload as Record<string, unknown>
    });

  it("RECO-ROUTE: the token gate, the shape check, and a filtered answer", async () => {
    modelText = "Javasolt: {{termek:cmp1}} és {{termek:nincs-a-listan}}.";
    const unauthorized = await call(request(), null);
    const malformed = await call(request({ deviations: [] }));
    const answered = await call(request());
    assert.deepEqual(
      [unauthorized.statusCode, malformed.statusCode, answered.statusCode],
      [401, 400, 200]
    );
    assert.deepEqual(answered.json(), {
      text: "Javasolt: {{termek:cmp1}} és.",
      model: process.env.OPENAI_MODEL ?? "gpt-5.1",
      removedProductIds: ["nincs-a-listan"]
    });
    // the model was told the rules, and was given the candidates as data
    assert.match(String(handed.instructions), /ONLY from the candidate list/);
    assert.match(JSON.stringify(handed.input), /cmp1/);
  });
});
