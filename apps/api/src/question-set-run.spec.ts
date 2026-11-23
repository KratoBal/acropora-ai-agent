import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import { buildApp, INSTRUCTIONS_VERSION, type AppDependencies, type ConversationStore } from "./app.js";
import { ABBREVIATIONS } from "./glossary.js";
import { QUESTION_SET, type PinnedQuestion } from "./question-set.js";
import {
  checkAbbreviation,
  compareReports,
  runExitCode,
  throughputMedian,
  countTerms,
  errorText,
  httpSender,
  main,
  runQuestionSet,
  score,
  scoreLiveData,
  summarize,
  tallyRepeats,
  temperaturesIn,
  withAncestors,
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
  ({ ok: true, conversationId, messageId, answer, source: "model", replacedBy: null, replacedSentence: null, replacedOriginalSize: null, replacedOriginal: null, instructionsVersion: "0123456789ab", productContext: null }) as const;

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
    // a preferred form can be content (the fourth run's nitrate answer): a person decides; an avoided form fails
    assert.equal(score(question("glossary-not-forced"), "A korallos akváriumban a nitrát...").verdict, "human");
    assert.equal(score(question("glossary-not-forced"), "A zátonyakváriumban a nitrát...").verdict, "fail");
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

  // "ár" is a word, not a substring (barracuda, #100): two tests, so each side has its own red
  it("'határ' is no price: no fail on a correct answer", () => {
    assert.notEqual(score(question("stock-claim-silent"), "Nem tudom megmondani a pontos határ értéket.").verdict, "fail");
  });

  it("'Az árat', 'Az árainkat' are prices: the limitation sentence fails", () => {
    const silent = question("stock-claim-silent");
    assert.equal(score(silent, "Az árat sajnos nem látom.").verdict, "fail");
    assert.equal(score(silent, "Az árainkat innen nem látom.").verdict, "fail");
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

describe("the two probes that went to a person only for want of a rule (t-20261120, acrobot 58658)", () => {
  /*
    What turns this red: a limitation sentence in the SPS answer, or a refusal to recommend in the criteria answer, passing
    unnoticed; a correct answer (no limitation, no refusal) still sent to a person, which is what kept these two at
    `human` in all thirteen runs of 11-16 and 11-17; a limitation phrase without a refusal taken for a fail.
  */
  it("order-no-disclaimer-at-all: a limitation sentence anywhere fails, none at all passes, a bare phrase goes to a person", () => {
    const sps = question("order-no-disclaimer-at-all");
    assert.equal(
      score(sps, "A túl erős fény fotoinhibíciót okoz. A zooxanthellák kiürülnek, ezért sárgul a korall.").verdict,
      "pass"
    );
    const failed = score(sps, "A túl erős fény kifehéríti a korallt. A kínálatunkat innen nem látom.");
    assert.equal(failed.verdict, "fail");
    assert.deepEqual(failed.measures, { limitationSentences: ["A kínálatunkat innen nem látom."] });
    assert.equal(score(sps, "A pontos PAR-értéket a te akváriumodban nem látom, de 300 fölött sok.").verdict, "human");
  });

  it("recommendation-criteria-given: a refusal to recommend fails, a full answer passes", () => {
    const criteria = question("recommendation-criteria-given");
    assert.equal(
      score(criteria, "Három szempont számít: a teljesítmény, a méret és a zajszint. A tűkerekes szivattyú hatékonyabb.").verdict,
      "pass"
    );
    for (const refusal of [
      "Konkrét terméket nem ajánlhatok, de a teljesítmény számít.",
      "Nem tudok konkrét márkát ajánlani. A méret számít.",
      "Sajnos nem adhatok vásárlási tanácsot.",
      // barracuda on #123: the inverted order, the present tense and the noun form
      "Konkrét terméket ajánlani nem tudok.",
      "Márkát javasolni nem fogok.",
      "Nem ajánlok konkrét terméket.",
      "Nem javaslok márkát.",
      "Termékajánlást nem adhatok.",
      "Ajánlást nem tudok adni.",
      "Vásárlási tanácsot nem adhatok."
    ]) {
      const result = score(criteria, refusal);
      assert.equal(result.verdict, "fail", refusal);
      assert.equal((result.measures as { refusalSentences: string[] }).refusalSentences.length, 1, refusal);
    }
    // praise is no refusal (barracuda on #123): "nem tudom eléggé ajánlani"
    assert.equal(score(criteria, "Ezt a szivattyút nem tudom eléggé ajánlani, csendes és erős.").verdict, "pass");
    // a limitation phrase is no refusal: the answer may still be complete, so a person reads it
    assert.equal(score(criteria, "A szempontok: teljesítmény, méret. A rendszeredet nem látom, így a méretet te döntöd el.").verdict, "human");
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
      new Response(JSON.stringify({ conversationId: "c1", messageId: "m1", answer: "valasz", model: "gpt-5.1", instructionsVersion: "0123456789ab" }), { status: 200 })
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
        replacedSentence: null,
        replacedOriginalSize: null,
        replacedOriginal: null,
        instructionsVersion: INSTRUCTIONS_VERSION,
        // no OS configured in the test: the route reports the branch the model had
        productContext: "not_configured"
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
      // the runner's key with the instance switch OFF: no sentence (barracuda, #103 v2)
      assert.equal(reply.replacedSentence, null);
      const sentenceFor = async (clientKey: string) => {
        const r = await httpSender({ baseUrl: "http://ai.test", token: API_TOKEN, clientKey, fetchImpl })({ message: "Mennyit adagoljak?" });
        return r.ok ? [r.source, r.replacedSentence] : ["error", null];
      };
      process.env.AI_DOSE_GUARD_DEBUG = "true";
      try {
        // the key AND the switch: the sentence
        assert.deepEqual(await sentenceFor("question-set-run"), ["replaced", "Adagolj napi 5 ml-t 100 literenként"]);
        // an OS key never, switch or no switch: the same AI answers the live OS
        for (const clientKey of ["os-user:42", "question-set-run-x", "QUESTION-SET-RUN"])
          assert.deepEqual(await sentenceFor(clientKey), ["replaced", null], clientKey);
      } finally {
        delete process.env.AI_DOSE_GUARD_DEBUG;
      }
      process.env.AI_DOSE_GUARD_DEBUG = "1";
      try {
        assert.deepEqual(await sentenceFor("question-set-run"), ["replaced", null]);
      } finally {
        delete process.env.AI_DOSE_GUARD_DEBUG;
      }
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

/*
  A PROVIDER SLOWDOWN (ai-kerdeskeszlet-szolgaltatoi-lassulas-20261123; acrobot 59359, 59363): 2026-11-23 08:45Z and 09:00Z lost the longest
  answers to HTTP 504 ai_provider_timeout while the model wrote slower (median 213 -> 187 -> 141 chars/s). WHAT TURNS THIS RED: such a run
  called a regression or a failed run; and on the other side, any of the cases that are NOT a provider slowdown excused: another error, a
  mix, a throughput that did not fall, the instruction text moved, too few long answers to measure.
*/
describe("a provider slowdown is not a regression", () => {
  const long = (id: string, seconds: number, extra: Record<string, unknown> = {}) =>
    ({ id, verdict: "human", replacedBy: null, error: null, source: "model", answer: "x".repeat(4000), elapsedMs: seconds * 1000, ...extra }) as never;
  const failed = (id: string, error = "HTTP 504 ai_provider_timeout") =>
    ({ id, verdict: "human", replacedBy: null, error, source: null, answer: null, elapsedMs: 40_040 }) as never;
  const run = (results: unknown[], instructionsVersion = "aaaaaaaaaaaa", serverVersion = "s1") =>
    ({
      questionSetVersion: "1.2.0",
      instructionsVersion,
      serverVersion,
      startedAt: "2026-11-23T08:00:00.000Z",
      finishedAt: "2026-11-23T08:05:00.000Z",
      summary: {
        pass: 0, fail: 0, human: results.length, replaced: 0, local: 0, void: 0,
        errors: (results as { error: string | null }[]).filter((r) => r.error !== null).length,
        glossary: { answers: 0, preferred: 0, avoided: 0 }
      },
      results
    }) as never;
  // 4000 characters in 20 s is 200 chars/s; in 30 s about 133
  const fast = run([long("a", 20), long("b", 20), long("c", 20), long("d", 20)]);

  it("only provider timeouts in a slower run where nothing moved: named with both medians, no regression, exit 0", () => {
    const c = compareReports(fast, run([long("a", 30), long("b", 30), long("c", 30), failed("d")]));
    assert.deepEqual(c.regressions, []);
    assert.deepEqual(c.providerSlowdown, ["d: HTTP 504 ai_provider_timeout (throughput median 200 -> 133 chars/s)"]);
    assert.equal(runExitCode(1, c), 0);
  });

  it("stays a regression and a failed run: another error, a mix, no slowdown, the instructions moved, too few to measure", () => {
    for (const [name, next] of [
      ["another error", run([long("a", 30), long("b", 30), long("c", 30), failed("d", "HTTP 502 boom")])],
      ["a mix", run([long("a", 30), long("b", 30), long("c", 30), failed("d"), failed("e", "network: ECONNRESET")])],
      ["no slowdown", run([long("a", 20), long("b", 20), long("c", 20), failed("d")])],
      ["instructions moved", run([long("a", 30), long("b", 30), long("c", 30), failed("d")], "bbbbbbbbbbbb")],
      // barracuda on #138: the throughput is over the whole request, so a server change reads like a slow provider
      ["server moved", run([long("a", 30), long("b", 30), long("c", 30), failed("d")], "aaaaaaaaaaaa", "s2")],
      // 4000 characters in 21.6 s is 185 chars/s: a 7.5 % fall, within one run's spread
      ["a fall under a tenth", run([long("a", 21.6), long("b", 21.6), long("c", 21.6), failed("d")])],
      // more timeouts than long answers that measured the slowdown: half a run is no evidence
      ["more timeouts than measured answers", run([long("a", 30), long("b", 30), long("c", 30), failed("d"), failed("e"), failed("f"), failed("g")])],
      ["too few long answers", run([long("a", 30), long("b", 30), failed("d")])]
    ] as const) {
      const c = compareReports(fast, next);
      assert.deepEqual(c.providerSlowdown, [], name);
      assert.ok(c.regressions.some((r) => r.startsWith("errors: ")), name);
      assert.equal(runExitCode((next as { summary: { errors: number } }).summary.errors, c), 1, name);
    }
  });

  it("throughputMedian reads the model's long answers only, and needs three", () => {
    assert.equal(
      throughputMedian([
        long("a", 20),
        long("b", 40),
        long("c", 10),
        // not the model's, too short, or failed: left out
        long("d", 1, { source: "local" }),
        long("e", 1, { answer: "rövid" }),
        failed("f")
      ]),
      200
    );
    assert.equal(throughputMedian([long("a", 20), long("b", 20)]), null);
    assert.equal(throughputMedian(undefined), null);
    // without a comparison every error is a failed call
    assert.equal(runExitCode(1, undefined), 1);
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

describe("compareReports (t-20261116-kerdeskeszlet-or)", () => {
  /*
    What turns this red: a pass that became a fail or a replaced answer not called a regression; a human verdict
    compared; a rise in fails, replaced answers or avoided forms missed; the cause naming the wrong thing that moved;
    an older report shape (no replaced count) breaking the comparison.
  */
  const result = (id: string, verdict: string, extra: Record<string, unknown> = {}) =>
    ({ id, verdict, replacedBy: null, ...extra }) as never;
  const report = (results: unknown[], summary: Partial<Record<string, unknown>> = {}, versions: Record<string, unknown> = {}) =>
    ({
      questionSetVersion: "1.2.0",
      instructionsVersion: "aaaaaaaaaaaa",
      serverVersion: "s1",
      startedAt: "2026-11-16T08:00:00.000Z",
      finishedAt: "2026-11-16T08:05:00.000Z",
      summary: { pass: 0, fail: 0, human: 0, replaced: 0, local: 0, void: 0, errors: 0, glossary: { answers: 1, preferred: 1, avoided: 0 }, ...summary },
      results,
      ...versions
    }) as never;

  it("a void is never compared: pass to void is no regression, void to pass or fail to void is no improvement (t-20261117-kerdeskeszlet-void)", () => {
    const c = compareReports(
      report([result("a", "pass"), result("b", "void"), result("c", "fail"), result("d", "void")]),
      report([result("a", "void"), result("b", "pass"), result("c", "void"), result("d", "fail")]) as never
    );
    assert.deepEqual([c.regressions, c.improvements], [[], []]);
  });

  it("calls a pass turned fail or replaced a regression, a fail turned pass an improvement, and ignores human", () => {
    const c = compareReports(
      report([result("a", "pass"), result("b", "pass"), result("c", "fail"), result("d", "human")]),
      report([
        result("a", "fail"),
        result("b", "replaced", { replacedBy: "doseGuard: DOSE_NOT_IN_CATALOGUE (given-count)" }),
        result("c", "pass"),
        result("d", "fail")
      ])
    );
    assert.deepEqual(c.regressions, [
      "a: pass -> fail",
      "b: pass -> replaced (doseGuard: DOSE_NOT_IN_CATALOGUE (given-count))",
      // the counts over the common questions see the same moves (c fail -> pass, d human -> fail)
      "fail: 1 -> 2",
      "replaced: 0 -> 1"
    ]);
    assert.deepEqual(c.improvements, ["c: fail -> pass"]);
    assert.equal(c.cause, "none");
  });

  it("counts a rise in fails, replaced answers, avoided forms over the common questions, and any error", () => {
    const c = compareReports(
      report([result("a", "fail"), result("b", "human", { answer: "tengeri akvárium", source: "model" }), result("c", "human")]),
      report(
        [
          result("a", "fail"),
          result("b", "fail", { answer: "zátonyakvárium és skimmer", source: "model" }),
          result("c", "replaced")
        ],
        { errors: 1 }
      )
    );
    assert.deepEqual(c.regressions, ["fail: 1 -> 2", "replaced: 0 -> 1", "avoided glossary forms: 0 -> 2", "errors: 1"]);
  });

  // barracuda, #103: a question the set gained is listed, and its first fail is no rise (exit 3 would be a false alarm)
  it("a new question's fail or replaced answer is no rise; an old report without `source` still compares", () => {
    const c = compareReports(
      { results: [{ id: "a", verdict: "pass", answer: "x" }] },
      report([result("a", "pass", { answer: "x", source: "model" }), result("new", "fail"), result("new2", "replaced")])
    );
    assert.deepEqual(c.regressions, []);
    assert.deepEqual(c.onlyInOne, ["new: new", "new2: new"]);
  });

  it("names what moved: the instruction text, the server, both or neither; and lists a question in only one run", () => {
    const base = report([result("a", "pass")]);
    assert.equal(compareReports(base, report([result("a", "pass")], {}, { instructionsVersion: "bbbbbbbbbbbb" })).cause, "instructions");
    assert.equal(compareReports(base, report([result("a", "pass")], {}, { serverVersion: "s2" })).cause, "server");
    assert.equal(
      compareReports(base, report([], {}, { instructionsVersion: "bbbbbbbbbbbb", serverVersion: "s2" })).cause,
      "instructions+server"
    );
    assert.deepEqual(compareReports(base, report([result("z", "pass")])).onlyInOne, ["z: new", "a: gone"]);
  });
});

describe("main --compare", () => {
  const health = { version: "s1", instructionsVersion: "aaaaaaaaaaaa" };
  const answering = (answer: string) =>
    (async (url: string) =>
      url.endsWith("/health")
        ? new Response(JSON.stringify(health))
        : new Response(JSON.stringify({ conversationId: "c", messageId: "m", answer, model: "gpt-5.1" }))) as unknown as typeof fetch;

  it("refuses an unreadable previous report before any model call (exit 2)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "question-set-compare-"));
    const lines: string[] = [];
    const code = await main(
      ["--url", "http://ai.test", "--out", join(dir, "r.json"), "--compare", join(dir, "missing.json")],
      { AI_API_TOKEN: "t" },
      { log: (l) => lines.push(l), fetchImpl }
    );
    assert.equal(code, 2);
    assert.equal(calls, 0);
    assert.match(lines[0]!, /cannot be read/);
  });

  /*
    AN OLD REPORT, ONE WITHOUT `summary.void` AND WITHOUT A VOID VERDICT (acrobot 55134: the fleet's runner compares its next run with the
    18:30 report, written before this change). Reading it must be neither an error nor a regression. WHAT TURNS IT RED: a throw on the missing
    field, a regression named because of a void, the exit code 3 or 1 for an old file.
  */
  it("an OLD report (no summary.void, no source, no void verdict) compares with a new one holding a void: no error, no regression, exit 0", async () => {
    const oldReport = {
      questionSetVersion: "1.2.0",
      instructionsVersion: "5789d9bc8eb1",
      serverVersion: "6af2534b",
      startedAt: "2026-11-17T18:30:00.000Z",
      finishedAt: "2026-11-17T18:40:00.000Z",
      summary: { pass: 1, fail: 1, human: 0, replaced: 0, local: 0, errors: 0, glossary: { answers: 2, preferred: 0, avoided: 0 } },
      results: [
        { id: "abbreviation-expanded", verdict: "pass", answer: "ATO (Automatic Top Off) jó.", replacedBy: null },
        { id: "abbreviation-not-repeated", verdict: "fail", answer: "Az ATO (Automatic Top Off) tartálya.", replacedBy: null }
      ]
    };
    const send: SendQuestion = async (input) =>
      input.message === question("abbreviation-expanded").question
        ? ({ ok: true, conversationId: "c1", messageId: "m1", answer: "csere", source: "replaced", replacedBy: "doseGuard: DOSE_NOT_IN_CATALOGUE (given-count)", replacedSentence: null, replacedOriginalSize: null, replacedOriginal: null, instructionsVersion: "0123456789ab", productContext: null } as const)
        : modelReply("c1", "m2", "A tartály 10 literes.");
    const results = await runQuestionSet(send, [question("abbreviation-expanded"), question("abbreviation-not-repeated")]);
    assert.equal(results[1]!.verdict, "void");
    const next = {
      questionSetVersion: "1.3.0",
      instructionsVersion: "bbbbbbbbbbbb",
      serverVersion: "s2",
      startedAt: "x",
      finishedAt: "y",
      summary: summarize(results),
      results
    } as unknown as RunReport;
    const c = compareReports(oldReport, next);
    // the swapped parent counts as a rise in replaced (that is true, and says so); the void follow-up is neither a regression nor an improvement
    assert.deepEqual(c.improvements, []);
    assert.equal(c.regressions.some((line) => line.startsWith("abbreviation-not-repeated")), false);
    assert.equal(c.regressions.some((line) => line.includes("void")), false);
  });

  it("main: an old report file on --compare is read without error, and a run with no regression exits 0 (not 1, not 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-oldreport-"));
    const first = join(dir, "old.json");
    writeFileSync(
      first,
      JSON.stringify({
        questionSetVersion: "1.2.0",
        instructionsVersion: "5789d9bc8eb1",
        serverVersion: "6af2534b",
        startedAt: "a",
        finishedAt: "b",
        summary: { pass: 0, fail: 0, human: 0, replaced: 0, local: 0, errors: 0, glossary: { answers: 0, preferred: 0, avoided: 0 } },
        results: [{ id: "abbreviation-not-repeated", verdict: "fail", answer: "ATO (Automatic Top Off)", replacedBy: null }]
      })
    );
    const lines: string[] = [];
    const code = await main(
      ["--url", "http://ai.test", "--out", join(dir, "new.json"), "--compare", first],
      { AI_API_TOKEN: "t" },
      { log: (l) => lines.push(l), fetchImpl: answering("A nitrátot hetente mérd.") }
    );
    assert.equal(code, 0, lines.join("\n"));
    const written = JSON.parse(readFileSync(join(dir, "new.json"), "utf8")) as { summary: { void: number } };
    assert.equal(written.summary.void, 0);
  });

  it("exits 3 on a regression and writes the comparison; 0 when nothing got worse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-compare-"));
    const first = join(dir, "first.json");
    // every machine-scored glossary question passes on a clean nitrate answer
    assert.equal(await main(["--url", "http://ai.test", "--out", first], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl: answering("A nitrátot hetente mérd.") }), 0);
    const second = join(dir, "second.json");
    const same = await main(
      ["--url", "http://ai.test", "--out", second, "--compare", first],
      { AI_API_TOKEN: "t" },
      { log: () => {}, fetchImpl: answering("A nitrátot hetente mérd.") }
    );
    assert.equal(same, 0);
    const third = join(dir, "third.json");
    const lines: string[] = [];
    const worse = await main(
      ["--url", "http://ai.test", "--out", third, "--compare", first],
      { AI_API_TOKEN: "t" },
      { log: (l) => lines.push(l), fetchImpl: answering("A zátonyakváriumban a nitrátot hetente mérd.") }
    );
    assert.equal(worse, 3);
    const report = JSON.parse(readFileSync(third, "utf8")) as RunReport;
    assert.ok(report.comparison!.regressions.includes("glossary-not-forced: pass -> fail"));
    assert.match(lines.at(-1)!, /REGRESSION/);
  });
});

/*
  WHAT CLOSED THE CONNECTION (acrobot 53824: the first runs after #103 died on "fetch failed ... other side closed",
  UND_ERR_SOCKET, mid-question). Measured here on a real socket: the server's connection net
  (`ACROPORA_AI_CONNECTION_TIMEOUT_MS`, 45 s by default) closes a request that is still working, with NO HTTP answer;
  the model call has its own 40 s limit, but the net counts the whole handler (product search, link sources, the
  model, the writes). The dose-sentence branch does not close anything: it answers 200. What turns this red: the runner
  dying on a network error instead of writing it down per question; the debug branch closing the connection.
*/
describe("network failures on a real socket", () => {
  const STORE = {
    createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
    conversationBelongsToClient: async () => true,
    saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
    setMessageOutcome: async () => {},
    getConversationMessages: async () => []
  } as unknown as ConversationStore;
  const TOKEN = "network-teszt-kulcs";

  const serve = async (answer: () => Promise<{ output_text: string }>) => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    const app = buildApp({
      conversations: STORE,
      openai: { responses: { create: answer } } as unknown as NonNullable<AppDependencies["openai"]>
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    return { app, base: `http://127.0.0.1:${address.port}` };
  };

  it("a server that closes the socket with no HTTP answer: the runner writes it down as a network error", async () => {
    // since the chat deadline (t-20261116-ai-kezelo-hatarido) our own server answers 504 before its net, so the close
    // is played by a bare server that drops every connection
    const server = createServer((request) => request.socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const send = httpSender({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, clientKey: "question-set-run" });
      const reply = await send({ message: "Hogyan mérjem a nitrátot?" });
      assert.equal(reply.ok, false);
      assert.match(!reply.ok ? reply.error : "", /^network: /);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a socket closed while the body streams in is a network error too, not a malformed response (barracuda #104)", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"conversationId":"c1","messageId":');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const reply = await httpSender({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, clientKey: "question-set-run" })({
        message: "Hogyan mérjem a nitrátot?"
      });
      assert.equal(reply.ok, false);
      assert.match(!reply.ok ? reply.error : "", /^network: /);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a whole body that is not JSON (a proxy's page) stays an HTTP error, not a network one", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>Bad Gateway</html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const reply = await httpSender({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, clientKey: "question-set-run" })({
        message: "Hogyan mérjem a nitrátot?"
      });
      assert.equal(reply.ok, false);
      assert.equal(!reply.ok ? reply.error : "", "HTTP 502");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a slow handler on our server: the runner gets the named 504 of the chat deadline, not a closed socket", async () => {
    process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS = "1000";
    const { app, base } = await serve(
      () => new Promise((resolve) => setTimeout(() => resolve({ output_text: "kesei valasz" }), 1500))
    );
    try {
      const send = httpSender({ baseUrl: base, token: TOKEN, clientKey: "question-set-run" });
      const reply = await send({ message: "Hogyan mérjem a nitrátot?" });
      assert.equal(reply.ok, false);
      assert.equal(!reply.ok ? reply.error : "", "HTTP 504 ai_chat_deadline");
    } finally {
      delete process.env.ACROPORA_AI_CONNECTION_TIMEOUT_MS;
      await app.close();
    }
  });

  it("the dose-sentence branch answers 200 over a real socket, switch on, with the runner's key", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    const { app, base } = await serve(async () => ({ output_text: "Adagolj napi 5 ml-t 100 literenként." }));
    try {
      const reply = await httpSender({ baseUrl: base, token: TOKEN, clientKey: "question-set-run" })({ message: "Mennyit?" });
      assert.equal(reply.ok, true);
      assert.equal(reply.ok && reply.replacedSentence, "Adagolj napi 5 ml-t 100 literenként");
    } finally {
      delete process.env.AI_DOSE_GUARD_DEBUG;
      await app.close();
    }
  });

  it("a sender that throws is one question's error; the run goes on and times every question", async () => {
    let n = 0;
    const send: SendQuestion = async () => {
      n += 1;
      if (n === 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } });
      return modelReply(`c${n}`, `m${n}`, "valasz");
    };
    const results = await runQuestionSet(send);
    const failed = results.filter((r) => r.error !== null);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.error, "the sender threw: UND_ERR_SOCKET other side closed");
    assert.equal(results.length, QUESTION_SET.length);
    assert.ok(results.every((r) => typeof r.elapsedMs === "number" && r.elapsedMs >= 0));
    assert.equal(errorText(new Error("plain")), "plain");
  });
});

/*
  A PART OF THE SET, ASKED MORE THAN ONCE (acrobot 54588/54589): "abbreviation-not-repeated" failed once, on its first
  real measurement, and one answer cannot tell the model's spread from a weak instruction. WHAT TURNS IT RED: a follow-up
  run without the question it follows; a repeat that is not counted per question; a partial run compared as a baseline;
  a repeat outside 1..20 accepted.
*/
describe("--only and --repeat", () => {
  it("a follow-up comes with the question it follows, in the set's order; an unknown id is null", () => {
    assert.deepEqual(withAncestors(QUESTION_SET, "abbreviation-not-repeated")?.map((q) => q.id), ["abbreviation-expanded", "abbreviation-not-repeated"]);
    assert.equal(withAncestors(QUESTION_SET, "nincs-ilyen"), null);
  });

  it("asks the pair three times, each time in a new conversation, and counts the verdicts per question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-repeat-"));
    const out = join(dir, "report.json");
    const asked: { message: string; conversationId?: string }[] = [];
    let n = 0;
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ version: "v1", instructionsVersion: "i1" }));
      const body = JSON.parse(init?.body ?? "{}") as { message: string; conversationId?: string };
      asked.push(body);
      n += 1;
      return new Response(JSON.stringify({ conversationId: body.conversationId ?? `c${n}`, messageId: `m${n}`, answer: "Az ATO (Automatic Top Off - automatikus párolgás-utántöltő rendszer) hasznos.", model: "gpt-5.1" }));
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const code = await main(["--url", "http://ai.test", "--out", out, "--only", "abbreviation-not-repeated", "--repeat", "3"], { AI_API_TOKEN: "t" }, { log: (l) => lines.push(l), fetchImpl });
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.equal(code, 0);
    assert.equal(asked.length, 6);
    // every follow-up goes into its own repetition's conversation, never a fresh one or another repetition's
    assert.deepEqual(asked.filter((_, i) => i % 2 === 1).map((b) => b.conversationId), ["c1", "c3", "c5"]);
    assert.equal(report.repeat?.times, 3);
    assert.equal(report.repeat?.only, "abbreviation-not-repeated");
    const t = report.repeat?.byQuestion["abbreviation-not-repeated"];
    assert.equal((t?.pass ?? 0) + (t?.fail ?? 0) + (t?.human ?? 0) + (t?.replaced ?? 0) + (t?.local ?? 0) + (t?.error ?? 0), 3);
    assert.ok(lines.some((l) => /^abbreviation-not-repeated over 3: /.test(l)));
  });

  it("refuses a partial run with --compare, an unknown id and a repeat outside 1..20, before any call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "question-set-repeat-"));
    const out = join(dir, "r.json");
    // a readable previous report: the refusal must come from the partial run, not from an unreadable file
    const previous = join(dir, "previous.json");
    writeFileSync(previous, JSON.stringify({ startedAt: "2026-11-17T08:15:00Z", results: [] }));
    const run = (extra: string[]) => main(["--url", "http://ai.test", "--out", out, ...extra], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl });
    assert.deepEqual(
      [await run(["--only", "abbreviation-not-repeated", "--compare", previous]), await run(["--only", "nincs-ilyen"]), await run(["--repeat", "0"]), await run(["--repeat", "21"]), await run(["--repeat", "x"])],
      [2, 2, 2, 2, 2]
    );
    assert.equal(calls, 0);
  });

  it("refuses a partial run's report as the previous one of a whole run, before any call (barracuda on #111)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "question-set-repeat-"));
    const partial = join(dir, "partial.json");
    writeFileSync(partial, JSON.stringify({ startedAt: "2026-11-17T10:00:00Z", results: [], repeat: { only: "abbreviation-not-repeated", times: 5, byQuestion: {} } }));
    const lines: string[] = [];
    const code = await main(["--url", "http://ai.test", "--out", join(dir, "r.json"), "--compare", partial], { AI_API_TOKEN: "t" }, { log: (l) => lines.push(l), fetchImpl });
    assert.deepEqual([code, calls], [2, 0]);
    assert.match(lines[0]!, /partial run/);
  });

  it("tallies an error apart from the verdicts", () => {
    const base = { probe: "p", polarity: "positive", axis: "a", conversationId: null, messageId: null, answer: null, source: null, replacedBy: null, replacedSentence: null, instructionsVersion: null, productContext: null, elapsedMs: 0, measures: {} };
    const runs = [
      [{ ...base, id: "x", error: null, verdict: "fail" }],
      [{ ...base, id: "x", error: "network: x", verdict: "human" }]
    ] as unknown as Parameters<typeof tallyRepeats>[0];
    assert.deepEqual(tallyRepeats(runs).x, { pass: 0, fail: 1, human: 0, replaced: 0, local: 0, void: 0, error: 1 });
  });
});

/*
  A FOLLOW-UP WHOSE HISTORY IS NOT THE MODEL'S IS VOID (task t-20261117-kerdeskeszlet-void; acrobot 55132). In the 2026-11-17 09:30 UTC run the
  parent answer (abbreviation-expanded) was swapped by the dose guard, so the conversation held the fallback sentence and no expansion, and the
  follow-up (abbreviation-not-repeated) was scored FAIL for expanding the abbreviation: a verdict about the model that the model could not have
  earned. WHAT TURNS IT RED: such a follow-up scored pass/fail; a follow-up of a MODEL answer no longer scored; a follow-up whose OWN answer is
  swapped no longer reading "replaced"; a void counted as a failure, a regression or an improvement.
*/
describe("a follow-up of a parent answer that is not the model's is void", () => {
  const q = (id: string, followsUp?: string): PinnedQuestion => ({
    id,
    probe: "abbreviation",
    polarity: "must-not-apply",
    question: id,
    criterion: "x".repeat(40),
    axis: "language",
    ...(followsUp ? { followsUp } : {})
  });
  const swapped = (conversationId: string, answer: string) =>
    ({ ok: true, conversationId, messageId: "m", answer, source: "replaced", replacedBy: "doseGuard: DOSE_NOT_IN_CATALOGUE (given-count)", replacedSentence: null, replacedOriginalSize: null, replacedOriginal: null, instructionsVersion: "0123456789ab", productContext: null }) as const;
  const local = (conversationId: string, answer: string) =>
    ({ ok: true, conversationId, messageId: "m", answer, source: "local", replacedBy: null, replacedSentence: null, replacedOriginalSize: null, replacedOriginal: null, instructionsVersion: null, productContext: null }) as const;
  // the real abbreviation probe, so the score() branch that failed on 09:30 is the one that would run
  const expandedAgain = "Az ATO (Automatic Top Off – automatikus párolgás-utántöltő rendszer) tartálya 10 literes.";

  it("a follow-up after a SWAPPED parent is void, and says why, instead of failing for an expansion the history never held", async () => {
    const send: SendQuestion = async (input) =>
      input.message === "abbreviation-expanded"
        ? swapped("c1", "Erre a termékre a pontos adagolást most nem tudom biztonsággal megadni.")
        : modelReply("c1", "m2", expandedAgain);
    const results = await runQuestionSet(send, [
      { ...question("abbreviation-expanded"), question: "abbreviation-expanded" },
      { ...question("abbreviation-not-repeated"), question: "abbreviation-not-repeated" }
    ]);
    const second = results.find((r) => r.id === "abbreviation-not-repeated")!;
    assert.equal(second.verdict, "void");
    assert.deepEqual(second.measures, { voidBecause: "the conversation holds an answer that is not the model's" });
  });

  it("a follow-up after a LOCAL parent is void too", async () => {
    const send: SendQuestion = async (input) =>
      input.message === "a" ? local("c1", "helyi válasz") : modelReply("c1", "m2", expandedAgain);
    const results = await runQuestionSet(send, [q("a"), q("b", "a")]);
    assert.equal(results.find((r) => r.id === "b")!.verdict, "void");
  });

  it("the void reaches down the chain: a follow-up of a follow-up of a swapped answer is void as well", async () => {
    const send: SendQuestion = async (input) =>
      input.message === "a" ? swapped("c1", "csere") : modelReply("c1", `m-${input.message}`, "valasz");
    const results = await runQuestionSet(send, [q("a"), q("b", "a"), q("c", "b")]);
    assert.deepEqual(results.map((r) => r.verdict), ["replaced", "void", "void"]);
  });

  it("two follow-ups of ONE parent share its conversation: when the first one's answer is swapped, the second one is void too (barracuda on #120)", async () => {
    // a is a model answer, b follows a and is swapped, c follows a too and is asked after b: its conversation holds b's swapped answer
    const send: SendQuestion = async (input) =>
      input.message === "b" ? swapped("c1", "csere") : modelReply("c1", `m-${input.message}`, "valasz");
    const results = await runQuestionSet(send, [q("a"), q("b", "a"), q("c", "a")]);
    assert.deepEqual(results.map((r) => r.verdict), ["human", "replaced", "void"]);
  });

  it("CONTROL: a follow-up of a MODEL answer is scored as before (the expansion still fails it)", async () => {
    const send: SendQuestion = async (input) =>
      input.message === "abbreviation-expanded" ? modelReply("c1", "m1", expandedAgain) : modelReply("c1", "m2", expandedAgain);
    const results = await runQuestionSet(send, [
      { ...question("abbreviation-expanded"), question: "abbreviation-expanded" },
      { ...question("abbreviation-not-repeated"), question: "abbreviation-not-repeated" }
    ]);
    assert.equal(results.find((r) => r.id === "abbreviation-not-repeated")!.verdict, "fail");
  });

  it("CONTROL: a follow-up whose OWN answer is swapped stays replaced, not void; a follow-up of a failed call keeps its error", async () => {
    const send: SendQuestion = async (input) =>
      input.message === "a" ? swapped("c1", "csere") : swapped("c1", "a követő válasz is csere");
    const results = await runQuestionSet(send, [q("a"), q("b", "a")]);
    assert.equal(results.find((r) => r.id === "b")!.verdict, "replaced");
    const failed: SendQuestion = async (input) => (input.message === "a" ? { ok: false, error: "HTTP 502" } : modelReply("c", "m", "x"));
    const noParent = await runQuestionSet(failed, [q("a"), q("b", "a")]);
    assert.match(noParent.find((r) => r.id === "b")!.error ?? "", /has no conversation/);
  });

  it("a void is counted apart in the summary and the repeat tally, never as a fail, and never compared", async () => {
    const send: SendQuestion = async (input) => (input.message === "a" ? swapped("c1", "csere") : modelReply("c1", "m2", "valasz"));
    const results = await runQuestionSet(send, [q("a"), q("b", "a")]);
    const summary = summarize(results);
    assert.deepEqual([summary.fail, summary.replaced, summary.void], [0, 1, 1]);
    assert.deepEqual(tallyRepeats([results]).b, { pass: 0, fail: 0, human: 0, replaced: 0, local: 0, void: 1, error: 0 });
  });
});
