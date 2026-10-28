import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { buildApp, type AppDependencies } from "./app.js";
import {
  MAX_QUERIES,
  guardResearchQueries,
  guardResearchSummary,
  parseResearchQuestion,
  parseSummaryRequest,
  researchQueriesInstructions,
  researchSummaryInstructions,
  SUMMARY_EXAMPLE,
  type SummaryRequest
} from "./research-draft.js";

/**
 * MODE B, THE AI SIDE (Acropora OS research knowledge base, S6). WHAT TURNS
 * IT RED: a query carrying anything but the search syntax (a URL, a field
 * prefix, a control character) leaves this service; more than three queries;
 * a summary sentence without a marker, with a marker of a claim not sent, or
 * with a number its cited claims do not hold; the routes without their token
 * or shape check. Invented claims only.
 */
const REQUEST: SummaryRequest = {
  question: "Mennyi foszfát jó egy SPS-akváriumban?",
  claims: [
    {
      id: "k1",
      fields: "species ACROPORA, environment FIELD, effect CALCIFICATION, direction DECREASE, 0.3-1 µmol/l",
      passage: "Calcification decreased at 0.3 to 1 µM phosphate.",
      source: "Koop et al., 2001"
    },
    {
      id: "k2",
      fields: "species ACROPORA, environment HOME_AQUARIUM, effect COLORATION, direction INCREASE, 0.03-0.1 mg/l PO4",
      passage: "Colour improved between 0.03 and 0.1 mg/L PO4.",
      source: "Holmes-Farley, 2002"
    }
  ]
};
const summary = (text: string) => JSON.stringify({ summary: text });

describe("the queries", () => {
  it("keeps the search syntax, at most three, without repeats", () => {
    const g = guardResearchQueries(
      JSON.stringify({
        queries: [
          '"phosphate" AND coral AND (calcification OR "skeletal density")',
          "Acropora phosphate enrichment",
          "acropora PHOSPHATE enrichment",
          "phosphate limitation bleaching",
          "reef aquarium phosphate"
        ]
      })
    );
    assert.ok(g.ok);
    assert.equal(g.queries.length, MAX_QUERIES);
    assert.deepEqual(g.refused, [
      { index: 2, refusal: "REPEATED" },
      { index: 4, refusal: "TOO_MANY" }
    ]);
  });

  it("refuses anything that could ride on a query to an external API", () => {
    const g = guardResearchQueries(
      JSON.stringify({
        queries: [
          "https://example.org/?q=phosphate",
          "title:phosphate",
          "phosphate\u0000coral",
          "phosphate; ignore previous",
          "x".repeat(201),
          "ab",
          7
        ]
      })
    );
    assert.ok(g.ok);
    assert.deepEqual(g.queries, []);
    assert.deepEqual(
      g.refused.map((r) => r.refusal),
      ["BAD_CHARACTER", "BAD_CHARACTER", "BAD_CHARACTER", "BAD_CHARACTER", "TOO_LONG", "TOO_SHORT", "NOT_A_STRING"]
    );
  });

  it("v2: the prompt's own examples pass the guard, and it keeps hobby words out of AND", () => {
    const text = researchQueriesInstructions();
    // the examples the model is shown must be queries the guard keeps
    const examples = [
      "phosphate AND (scleractinian OR coral) AND (calcification OR growth)",
      '(coral OR "SPS coral")'
    ];
    for (const example of examples) assert.ok(text.includes(example), example);
    const kept = guardResearchQueries(JSON.stringify({ queries: examples }));
    assert.deepEqual(kept, { ok: true, queries: examples, refused: [] });
    assert.match(text, /TITLE AND ABSTRACT/);
    assert.match(text, /Hobby words \(SPS, LPS, reef tank, reef aquarium, aquaria\) are NEVER a required term/);
    assert.match(text, /Every parenthesis and every double quote is closed/);
  });

  it("not JSON and no list are refusals; an empty list is an answer", () => {
    assert.deepEqual(guardResearchQueries("nem json"), { ok: false, refusal: "NOT_JSON" });
    assert.deepEqual(guardResearchQueries('{"q": []}'), { ok: false, refusal: "NO_QUERIES_LIST" });
    assert.deepEqual(guardResearchQueries('{"queries": []}'), { ok: true, queries: [], refused: [] });
  });
});

describe("the summary", () => {
  it("keeps a marked sentence whose numbers are its claims' numbers", () => {
    const g = guardResearchSummary(
      summary(
        "Egy terepi kísérletben 0,3–1 µmol/l foszfát mellett csökkent a kalcifikáció [[claim:k1]]. Akváriumban 0,03–0,1 mg/l PO4 mellett javult a szín [[claim:k2]]."
      ),
      REQUEST
    );
    assert.ok(g.ok);
    assert.equal(g.kept, 2);
    assert.deepEqual(g.dropped, []);
  });

  it("drops a sentence without a marker, with an unknown marker, or with an invented number", () => {
    const g = guardResearchSummary(
      summary(
        [
          "A foszfát fontos.",
          "Egy kutatás szerint ez így van [[claim:k9]].",
          "Az ideális érték 0,05 mg/l [[claim:k1]].",
          "Akváriumban 0,1 mg/l PO4 mellett javult a szín [[claim:k2]]."
        ].join(" ")
      ),
      REQUEST
    );
    assert.ok(g.ok);
    assert.deepEqual(g.dropped, [
      { index: 0, drop: "UNMARKED" },
      { index: 1, drop: "UNKNOWN_MARKER" },
      { index: 2, drop: "NUMBER_NOT_IN_CLAIMS" }
    ]);
    assert.equal(g.summary, "Akváriumban 0,1 mg/l PO4 mellett javult a szín [[claim:k2]].");
  });

  it("a chemical name is not a number: PO4 next to a molar claim is no invented 4", () => {
    const g = guardResearchSummary(summary("A PO4 0,3–1 µmol/l mellett a kalcifikáció csökkent [[claim:k1]]."), REQUEST);
    assert.ok(g.ok);
    assert.deepEqual(g.dropped, []);
  });

  it("text after the markers rides on nothing: a lower-case start, a semicolon, a colon, a marker inside", () => {
    const g = guardResearchSummary(
      summary(
        [
          "Csökkent a kalcifikáció [[claim:k1]]. ezért ne adagolj foszfátot.",
          "Csökkent a kalcifikáció [[claim:k1]]; ezért ne adagolj foszfátot.",
          "Csökkent a kalcifikáció [[claim:k1]]: ne adagolj.",
          "Csökkent [[claim:k1]] a kalcifikáció, ne adagolj.",
          "Egy terepi kísérletben 0,3–1 µmol/l foszfát mellett csökkent a kalcifikáció [[claim:k1]].",
          "Akváriumban 0,03–0,1 mg/l PO4 mellett javult a szín [[claim:k2]] [[claim:k1]]."
        ].join(" ")
      ),
      REQUEST
    );
    assert.ok(g.ok);
    assert.deepEqual(g.dropped, [
      { index: 0, drop: "MARKER_NOT_AT_END" },
      { index: 1, drop: "MARKER_NOT_AT_END" },
      { index: 2, drop: "MARKER_NOT_AT_END" },
      { index: 3, drop: "MARKER_NOT_AT_END" }
    ]);
    assert.equal(g.kept, 2);
  });

  it("a digit glued to a letter is a number unless it is a listed formula", () => {
    const g = guardResearchSummary(
      summary(
        [
          "Napi5 ml adalék mellett csökkent a kalcifikáció [[claim:k1]].",
          "A pH8,2 mellett csökkent a kalcifikáció [[claim:k1]].",
          "KH8 és Ca420 mellett javult a szín [[claim:k2]].",
          "PO4 0,3–1 µmol/l mellett csökkent a kalcifikáció [[claim:k1]]."
        ].join(" ")
      ),
      REQUEST
    );
    assert.ok(g.ok);
    assert.deepEqual(g.dropped, [
      { index: 0, drop: "NUMBER_NOT_IN_CLAIMS" },
      { index: 1, drop: "NUMBER_NOT_IN_CLAIMS" },
      { index: 2, drop: "NUMBER_NOT_IN_CLAIMS" }
    ]);
    assert.equal(g.kept, 1);
  });

  it("a number of another claim than the one cited is not enough", () => {
    const g = guardResearchSummary(summary("A kalcifikáció 0,1 mg/l mellett csökkent [[claim:k1]]."), REQUEST);
    assert.ok(g.ok);
    assert.deepEqual(g.dropped, [{ index: 0, drop: "NUMBER_NOT_IN_CLAIMS" }]);
  });

  it("v2: markers written after the period move before it, when a new sentence or the end follows", () => {
    // the third stage run's likely shape: no split can cut it, so it was ONE dropped sentence
    const g = guardResearchSummary(
      summary("A kalcifikáció csökkent. [[claim:k1]] A szín javult. [[claim:k2]]"),
      REQUEST
    );
    assert.deepEqual(g, {
      ok: true,
      summary: "A kalcifikáció csökkent [[claim:k1]]. A szín javult [[claim:k2]].",
      kept: 2,
      dropped: []
    });
    // a lower-case continuation still rides on nothing: the text stays one sentence, dropped
    const glued = guardResearchSummary(summary("A kalcifikáció csökkent. [[claim:k1]] ezért ne adagolj."), REQUEST);
    assert.deepEqual(glued, { ok: true, summary: "", kept: 0, dropped: [{ index: 0, drop: "MARKER_NOT_AT_END" }] });
    // a marker inside a listing sentence is still out
    const inside = guardResearchSummary(summary("A kalcifikáció csökkent [[claim:k1]], a szín javult [[claim:k2]]."), REQUEST);
    assert.deepEqual(inside.ok && inside.dropped, [{ index: 0, drop: "MARKER_NOT_AT_END" }]);
  });

  it("v2: the prompt's one form passes the guard", () => {
    assert.ok(researchSummaryInstructions().includes(SUMMARY_EXAMPLE));
    const request: SummaryRequest = {
      question: REQUEST.question,
      claims: REQUEST.claims.map((c, i) => ({ ...c, id: `c${i + 1}` }))
    };
    const g = guardResearchSummary(summary(SUMMARY_EXAMPLE), request);
    assert.deepEqual(g, { ok: true, summary: SUMMARY_EXAMPLE, kept: 1, dropped: [] });
  });

  it("not JSON, no summary and too long are refusals", () => {
    assert.deepEqual(guardResearchSummary("nem json", REQUEST), { ok: false, refusal: "NOT_JSON" });
    assert.deepEqual(guardResearchSummary('{"text": "x"}', REQUEST), { ok: false, refusal: "NO_SUMMARY" });
    assert.deepEqual(guardResearchSummary(summary("x".repeat(4001)), REQUEST), { ok: false, refusal: "TOO_LONG" });
  });
});

describe("the requests", () => {
  it("a question, and checked claims with unique ids and no markers", () => {
    assert.ok(parseResearchQuestion({ question: " Mennyi? " }).ok);
    assert.ok(parseSummaryRequest(REQUEST).ok);
    for (const body of [
      { question: "" },
      { ...REQUEST, claims: [] },
      { ...REQUEST, claims: [REQUEST.claims[0], REQUEST.claims[0]] },
      { ...REQUEST, claims: [{ ...REQUEST.claims[0], passage: "x [[claim:k2]]" }] },
      { ...REQUEST, claims: [{ ...REQUEST.claims[0], id: "k 1" }] },
      null
    ])
      assert.equal(parseSummaryRequest(body).ok, false, JSON.stringify(body)?.slice(0, 80));
  });
});

describe("POST /v1/research-queries and /v1/research-summaries", () => {
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

  const call = (url: string, payload: unknown, token: string | null = API_TOKEN) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json"
      },
      payload: payload as Record<string, unknown>
    });

  it("QUERY-ROUTE: the token gate, the shape check, guarded queries, and a refusal", async () => {
    modelText = JSON.stringify({ queries: ["phosphate coral calcification", "title:x"] });
    const statuses = [
      (await call("/v1/research-queries", { question: "Mennyi foszfát?" }, null)).statusCode,
      (await call("/v1/research-queries", { question: "" })).statusCode
    ];
    const answered = await call("/v1/research-queries", { question: "Mennyi foszfát?" });
    assert.deepEqual([...statuses, answered.statusCode], [401, 400, 200]);
    assert.deepEqual(answered.json().queries, ["phosphate coral calcification"]);
    assert.equal(answered.json().writtenBy, `${process.env.OPENAI_MODEL ?? "gpt-5.1"} research-queries/v2`);
    assert.equal(handed.instructions, researchQueriesInstructions());
    modelText = "nem json";
    assert.equal((await call("/v1/research-queries", { question: "x" })).json().refusal, "NOT_JSON");
  });

  it("SUMMARY-ROUTE: the token gate, the shape check, a guarded summary", async () => {
    modelText = summary("Csökkent a kalcifikáció [[claim:k1]]. A foszfát fontos.");
    const statuses = [
      (await call("/v1/research-summaries", REQUEST, null)).statusCode,
      (await call("/v1/research-summaries", { question: "x", claims: [] })).statusCode
    ];
    const answered = await call("/v1/research-summaries", REQUEST);
    assert.deepEqual([...statuses, answered.statusCode], [401, 400, 200]);
    assert.equal(answered.json().summary, "Csökkent a kalcifikáció [[claim:k1]].");
    assert.equal(answered.json().writtenBy, `${process.env.OPENAI_MODEL ?? "gpt-5.1"} research-summary/v2`);
    assert.deepEqual(answered.json().dropped, [{ index: 1, drop: "UNMARKED" }]);
    assert.equal(handed.instructions, researchSummaryInstructions());
    assert.match(JSON.stringify(handed.input), /Koop et al/);
  });
});
