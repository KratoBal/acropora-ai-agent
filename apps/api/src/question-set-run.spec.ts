import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { buildApp, INSTRUCTIONS_VERSION, type AppDependencies, type ConversationStore } from "./app.js";
import { ABBREVIATIONS } from "./glossary.js";
import { QUESTION_SET, type PinnedQuestion } from "./question-set.js";
import {
  checkAbbreviation,
  countTerms,
  httpSender,
  main,
  runQuestionSet,
  score,
  scoreLiveData,
  summarize,
  temperaturesIn,
  type RunReport,
  type SendQuestion
} from "./question-set-run.js";

/**
 * THE QUESTION-SET RUNNER (card 7a5ea203). What turns this red: a form counted twice or not at all (a suffix, a
 * longer form that contains a shorter one); an ATO inside another word read as the abbreviation; a machine verdict
 * on a question whose criterion is not a count; a follow-up asked in a fresh conversation; one failed call ending
 * the run; a 429 not retried; the token or the run's own key missing from the call; the server's instruction
 * version not in the report.
 */
const ATO = ABBREVIATIONS.find((entry) => entry.abbreviation === "ATO")!;
const question = (id: string) => QUESTION_SET.find((q) => q.id === id)!;
/** A model answer as the sender hands it on. */
const modelReply = (conversationId: string, messageId: string, answer: string) =>
  ({ ok: true, conversationId, messageId, answer, source: "model", replacedBy: null, instructionsVersion: "116fb9eccedc" }) as const;

describe("countTerms", () => {
  it("counts a longer form once, not also the shorter form inside it, and a suffixed word as its form", () => {
    const counts = countTerms("A fehérjelehabzó jó, a lehabzó is. A zátonyakváriumot nem mondjuk, sem a Skimmert.");
    assert.deepEqual(counts.preferred, { fehérjelehabzó: 1, lehabzó: 1 });
    assert.deepEqual(counts.avoided, { zátonyakvárium: 1, skimmer: 1 });
  });

  it("finds nothing in an answer about something else", () => {
    assert.deepEqual(countTerms("A nitrátot hetente mérd."), { preferred: {}, avoided: {} });
  });
});

describe("checkAbbreviation", () => {
  it("sees the expansion right after the first ATO, and ignores an ATO inside another word", () => {
    const check = checkAbbreviation(
      "Az ATO (Automatic Top Off - automatikus párolgás-utántöltő rendszer) hasznos. Az ATOM más. Az ATO-t...",
      ATO
    );
    assert.deepEqual(check, { occurrences: 2, firstExpanded: true, expansions: 1 });
  });

  it("an expansion that comes only later is not a first-occurrence expansion", () => {
    const check = checkAbbreviation("Kell ATO. Az ATO (Automatic Top Off) pótolja a vizet.", ATO);
    assert.equal(check.firstExpanded, false);
    assert.equal(check.expansions, 1);
  });
});

describe("score", () => {
  it("scores the four count questions both ways", () => {
    assert.equal(score(question("glossary-preferred-term"), "Egy tengeri akvárium indítása...").verdict, "pass");
    assert.equal(score(question("glossary-preferred-term"), "Egy zátonyakvárium, vagyis tengeri akvárium...").verdict, "fail");
    assert.equal(score(question("glossary-not-forced"), "A nitrátot hetente mérd.").verdict, "pass");
    assert.equal(score(question("glossary-not-forced"), "A korallos akváriumban a nitrát...").verdict, "fail");
    assert.equal(score(question("abbreviation-expanded"), "ATO (Automatic Top Off - automatikus) kell.").verdict, "pass");
    assert.equal(score(question("abbreviation-expanded"), "Kell ATO.").verdict, "fail");
    assert.equal(score(question("abbreviation-not-repeated"), "Az ATO tartálya 10 liter.").verdict, "pass");
    assert.equal(score(question("abbreviation-not-repeated"), "Az ATO (Automatic Top Off) tartálya...").verdict, "fail");
  });

  it("scores the live-data questions with scoreLiveData, and lists the temperatures as a hint", () => {
    const result = score(question("live-data-no-value"), "Erről nincs információm. Az akvárium vize 25-26 fok legyen.");
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.measures, { temperatures: ["25-26 fok"] });
    assert.deepEqual(temperaturesIn("28,5 °C és 27 fok"), ["28,5 °C", "27 fok"]);
  });

  it("a failed call is not scored", () => {
    assert.equal(score(question("glossary-not-forced"), null).verdict, "human");
  });
});

describe("the shop-limitation sentence (acrobot 53747)", () => {
  /*
    What turns this red: a sentence that says it cannot see our stock or prices passes the silent question or opens the
    order question unnoticed; a limitation phrase without a shop word (or a shop word without one) read as such a
    sentence; a machine pass where a limitation phrase stands.
  */
  it("stock-claim-silent: fails on such a sentence, passes with no limitation phrase at all, otherwise a person", () => {
    const silent = question("stock-claim-silent");
    assert.equal(score(silent, "A lehabzó a szerves anyagot habbal vonja ki. Az árak széles skálán mozognak.").verdict, "pass");
    const failed = score(silent, "A lehabzó a szerves anyagot vonja ki. A készletünket sajnos nem látom.");
    assert.equal(failed.verdict, "fail");
    assert.deepEqual(failed.measures, { limitationSentences: ["A készletünket sajnos nem látom."] });
    assert.equal(score(silent, "A lehabzó kivonja a szerves anyagot. Hogy a te rendszeredben mennyit, azt nem látom.").verdict, "human");
  });

  it("order-world-knowledge-first: fails when the first sentence is the limitation, passes when it carries none", () => {
    const order = question("order-world-knowledge-first");
    // the first sentence of both stage runs (2026-11-16)
    assert.equal(
      score(order, "A konkrét árakról és arról, hogy nálunk mi van készleten, nincs információm, ezt nem látom. Általában...").verdict,
      "fail"
    );
    assert.equal(
      score(order, "Egy jó lehabzót a vízmennyiség és a terhelés szerint választunk. Az árainkat innen nem látom.").verdict,
      "pass"
    );
    assert.equal(score(order, "Pontosan nem tudom megmondani, de a méret számít. Az ár nálunk...").verdict, "human");
  });
});

describe("scoreLiveData, the second stage run's wording", () => {
  it("'nincs élő adatom' and 'hány fok van most kint' pass; a claim of the weather next to it does not", () => {
    assert.equal(
      scoreLiveData("live-data-no-value", "Nincs élő adatom, nem tudom megmondani, hány fok van most kint. A víz 24–26 °C legyen."),
      "pass"
    );
    assert.equal(scoreLiveData("live-data-no-value", "Nincs információm, de most kint meleg van, hűts."), "human");
  });
});

describe("runQuestionSet", () => {
  it("asks the follow-up in the conversation of the question it follows, after it, and keeps the set's order in the report", async () => {
    const asked: { message: string; conversationId?: string }[] = [];
    let n = 0;
    const send: SendQuestion = async (input) => {
      asked.push(input);
      n += 1;
      return modelReply(input.conversationId ?? `c${n}`, `m${n}`, "valasz");
    };
    const results = await runQuestionSet(send);
    const expanded = results.find((r) => r.id === "abbreviation-expanded")!;
    const followUp = asked.find((a) => a.message === question("abbreviation-not-repeated").question)!;
    assert.equal(followUp.conversationId, expanded.conversationId);
    assert.ok(asked.indexOf(followUp) > asked.findIndex((a) => a.message === question("abbreviation-expanded").question));
    assert.deepEqual(results.map((r) => r.id), QUESTION_SET.map((q) => q.id));
    assert.equal(asked.filter((a) => a.conversationId === undefined).length, QUESTION_SET.length - 1);
  });

  it("writes a failed call down and goes on; a follow-up of a failed question is not asked in a new conversation", async () => {
    const send: SendQuestion = async (input) =>
      input.message === question("abbreviation-expanded").question
        ? { ok: false, error: "HTTP 502 model unavailable" }
        : modelReply("c", "m", "valasz");
    const results = await runQuestionSet(send);
    assert.equal(results.find((r) => r.id === "abbreviation-expanded")!.error, "HTTP 502 model unavailable");
    assert.match(results.find((r) => r.id === "abbreviation-not-repeated")!.error ?? "", /has no conversation/);
    assert.equal(results.filter((r) => r.error === null).length, QUESTION_SET.length - 2);
    assert.equal(summarize(results).errors, 2);
  });
});

describe("runQuestionSet ordering", () => {
  it("asks a follow-up of a follow-up after its parent, whatever the list order", async () => {
    const q = (id: string, followsUp?: string): PinnedQuestion => ({
      id,
      probe: "abbreviation",
      polarity: "must-apply",
      question: id,
      criterion: "x".repeat(40),
      axis: "language",
      ...(followsUp ? { followsUp } : {})
    });
    const asked: { message: string; conversationId?: string }[] = [];
    const send: SendQuestion = async (input) => {
      asked.push(input);
      return modelReply(input.conversationId ?? `c-${input.message}`, "m", "a");
    };
    await runQuestionSet(send, [q("c", "b"), q("b", "a"), q("a")]);
    assert.deepEqual(asked, [
      { message: "a" },
      { message: "b", conversationId: "c-a" },
      { message: "c", conversationId: "c-a" }
    ]);
  });
});

describe("httpSender", () => {
  it("sends the token and the run's key, and waits out one 429", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const waits: number[] = [];
    const responses = [
      new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429, headers: { "retry-after": "2" } }),
      new Response(JSON.stringify({ conversationId: "c1", messageId: "m1", answer: "valasz", model: "gpt-5.1", instructionsVersion: "116fb9eccedc" }), { status: 200 })
    ];
    const send = httpSender({
      baseUrl: "http://ai.test/",
      token: "t0ken",
      clientKey: "question-set-run",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return responses.shift()!;
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      }
    });
    const reply = await send({ message: "kérdés" });
    assert.deepEqual(reply, modelReply("c1", "m1", "valasz"));
    assert.deepEqual(waits, [2000]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "http://ai.test/v1/chat");
    assert.equal(calls[0]!.headers.authorization, "Bearer t0ken");
    assert.equal(calls[0]!.headers["x-client-key"], "question-set-run");
  });

  it("names the status and the error code of a refused call", async () => {
    const send = httpSender({
      baseUrl: "http://ai.test",
      token: "t",
      clientKey: "k",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "missing x-client-key" }), { status: 400 })) as unknown as typeof fetch
    });
    assert.deepEqual(await send({ message: "x" }), { ok: false, error: "HTTP 400 missing x-client-key" });
  });
});

describe("httpSender against the real /v1/chat answer", () => {
  /*
    The other sender tests use a stand-in body of the sender's own shape: a renamed field on either side would keep
    them green. This one gives the sender what buildApp's route really returns (barracuda, #96).
  */
  const API_TOKEN = "question-set-run-teszt-kulcs";
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });

  it("receives the model's answer, the conversation and the message id", async () => {
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: Record<string, unknown>) =>
        input.role === "assistant" ? "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f" : "0d9c8b7a-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
      setMessageOutcome: async () => {},
      getConversationMessages: async () => []
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: "A nitrátot hetente mérd." }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const res = await app.inject({
          method: "POST",
          url: new URL(url).pathname,
          headers: init.headers as Record<string, string>,
          payload: init.body as string
        });
        return new Response(res.body, { status: res.statusCode });
      }) as unknown as typeof fetch;
      const send = httpSender({ baseUrl: "http://ai.test", token: API_TOKEN, clientKey: "question-set-run", fetchImpl });
      assert.deepEqual(await send({ message: "Hogyan mérjem a nitrátot?" }), {
        ok: true,
        conversationId: "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
        messageId: "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
        answer: "A nitrátot hetente mérd.",
        source: "model",
        replacedBy: null,
        instructionsVersion: INSTRUCTIONS_VERSION
      });
    } finally {
      await app.close();
    }
  });

  it("an answer the dose guard swapped arrives as replaced, with the guard's reason, on the real route", async () => {
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
      setMessageOutcome: async () => {},
      getConversationMessages: async () => []
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: "Adagolj napi 5 ml-t 100 literenként." }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const res = await app.inject({
          method: "POST",
          url: new URL(url).pathname,
          headers: init.headers as Record<string, string>,
          payload: init.body as string
        });
        return new Response(res.body, { status: res.statusCode });
      }) as unknown as typeof fetch;
      const send = httpSender({ baseUrl: "http://ai.test", token: API_TOKEN, clientKey: "question-set-run", fetchImpl });
      const reply = await send({ message: "Mennyit adagoljak?" });
      assert.equal(reply.ok, true);
      if (!reply.ok) return;
      assert.equal(reply.source, "replaced");
      assert.match(reply.replacedBy ?? "", /^doseGuard: NO_FIXED_DOSE \(no-fixed-dose\)$/);
    } finally {
      await app.close();
    }
  });

  it("a 200 without one of the three fields is a failed call, not an answer", async () => {
    for (const missing of ["conversationId", "messageId", "answer"]) {
      const body: Record<string, unknown> = { conversationId: "c", messageId: "m", answer: "valasz" };
      delete body[missing];
      const send = httpSender({
        baseUrl: "http://ai.test",
        token: "t",
        clientKey: "k",
        fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
      });
      assert.deepEqual(await send({ message: "x" }), { ok: false, error: `malformed response: ${missing}` }, missing);
    }
  });
});

describe("who wrote the answer", () => {
  const sendWith = (body: Record<string, unknown>) =>
    httpSender({
      baseUrl: "http://ai.test",
      token: "t",
      clientKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ conversationId: "c", messageId: "m", answer: "a", ...body }))) as unknown as typeof fetch
    })({ message: "x" });

  it("the pre-filter and the contact flow are local; a link swapped under enforce is replaced; a link logged is the model's", async () => {
    const sourceOf = async (body: Record<string, unknown>) => {
      const reply = await sendWith(body);
      return reply.ok ? [reply.source, reply.replacedBy] : ["error", null];
    };
    assert.deepEqual(await sourceOf({ model: "local-prefilter", doseGuard: null, linkGuard: null }), ["local", null]);
    assert.deepEqual(await sourceOf({}), ["local", null]);
    assert.deepEqual(await sourceOf({ model: "gpt-5.1", doseGuard: null, linkGuard: { mode: "enforce", reason: "external-host" } }), ["replaced", "linkGuard: external-host"]);
    assert.deepEqual(await sourceOf({ model: "gpt-5.1", doseGuard: null, linkGuard: { mode: "log", reason: "external-host" } }), ["model", null]);
    assert.deepEqual(await sourceOf({ model: "gpt-5.1", doseGuard: null, linkGuard: null }), ["model", null]);
  });

  it("a replaced answer is not scored and stays out of the glossary totals", async () => {
    const send: SendQuestion = async (input) =>
      input.message === question("glossary-not-forced").question
        ? { ...modelReply("c", "m", "Erre a termékre a pontos adagolást most nem tudom..."), source: "replaced", replacedBy: "doseGuard: no-fixed-dose", instructionsVersion: null }
        : modelReply("c", "m", "Egy tengeri akvárium...");
    const results = await runQuestionSet(send);
    const replaced = results.find((r) => r.id === "glossary-not-forced")!;
    assert.deepEqual([replaced.verdict, replaced.measures, replaced.replacedBy], ["replaced", {}, "doseGuard: no-fixed-dose"]);
    const summary = summarize(results);
    assert.equal(summary.replaced, 1);
    assert.equal(summary.glossary.answers, QUESTION_SET.length - 1);
  });
});

describe("scoreLiveData", () => {
  it("no value: a clean answer passes; a lookup, a named service or an outside temperature goes to a person, never fail", () => {
    const clean = "Nincs információm arról, hány fok van most Budapesten. A döntés alapja a vízhőmérséklet: 24–26 °C a cél.";
    assert.equal(scoreLiveData("live-data-no-value", clean), "pass");
    for (const answer of [
      "Nincs információm, de az előrejelzés szerint meleg lesz.",
      "Nincs információm; nézd meg egy időjárás-alkalmazásban.",
      "Nincs információm, de Budapesten ma 31 fok van.",
      // the type words (barracuda, #97)
      "Nincs információm; nézd meg egy meteorológiai szolgálat adatait.",
      "Nincs információm, az időjárás-widgeted megmutatja.",
      "Nincs információm, keress rá a telefonodon.",
      "Budapesten most 31 fok van, hűts."
    ])
      assert.equal(scoreLiveData("live-data-no-value", answer), "human", answer);
  });

  it("own measurement: working with the 28,5 passes; saying there is no information goes to a person", () => {
    assert.equal(scoreLiveData("live-data-own-measurement", "A 28,5 °C sok egy korallos akváriumnak."), "pass");
    assert.equal(scoreLiveData("live-data-own-measurement", "Erről nincs információm."), "human");
  });
});

describe("main", () => {
  it("refuses to run without the token, the url or the output", async () => {
    const lines: string[] = [];
    assert.equal(await main(["--url", "http://ai.test"], {}, { log: (l) => lines.push(l) }), 2);
    assert.match(lines[0]!, /Usage/);
  });

  it("writes the report with the server's instruction version, and exits 1 when a call failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-run-"));
    const out = join(dir, "report.json");
    let n = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/health"))
        return new Response(JSON.stringify({ version: "dda8546", instructionsVersion: "116fb9eccedc" }));
      n += 1;
      return n === 3
        ? new Response(JSON.stringify({ error: "boom" }), { status: 502 })
        : new Response(JSON.stringify({ conversationId: `c${n}`, messageId: `m${n}`, answer: "A nitrátot hetente mérd.", model: "gpt-5.1" }));
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const code = await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: (l) => lines.push(l), fetchImpl });
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.equal(code, 1);
    assert.equal(report.instructionsVersion, "116fb9eccedc");
    assert.equal(report.serverVersion, "dda8546");
    assert.equal(report.results.length, QUESTION_SET.length);
    assert.equal(report.summary.errors, 1);
    assert.match(lines[0]!, /instructions 116fb9eccedc/);
  });
});

describe("the question set's follow-ups", () => {
  it("each names an existing question that is not itself a follow-up", () => {
    const followUps = QUESTION_SET.filter((q): q is PinnedQuestion & { followsUp: string } => q.followsUp !== undefined);
    assert.ok(followUps.length > 0);
    for (const q of followUps) {
      const target = QUESTION_SET.find((other) => other.id === q.followsUp);
      assert.ok(target, `${q.id}: ${q.followsUp} nincs a készletben`);
      assert.equal(target.followsUp, undefined, `${q.id}: láncolt folytatás`);
    }
  });
});

describe("main, with a server that predates the /health field", () => {
  it("takes the instruction version from the answers when /health does not name it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-run-"));
    const out = join(dir, "report.json");
    const fetchImpl = (async (url: string) =>
      url.endsWith("/health")
        ? new Response(JSON.stringify({ version: "unknown" }))
        : new Response(
            JSON.stringify({ conversationId: "c", messageId: "m", answer: "a", model: "gpt-5.1", instructionsVersion: "116fb9eccedc" })
          )) as unknown as typeof fetch;
    await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl });
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.equal(report.instructionsVersion, "116fb9eccedc");
    assert.equal(report.serverVersion, "unknown");
  });
});
