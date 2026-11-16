import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ABBREVIATIONS } from "./glossary.js";
import { QUESTION_SET, type PinnedQuestion } from "./question-set.js";
import {
  checkAbbreviation,
  countTerms,
  httpSender,
  main,
  runQuestionSet,
  score,
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

  it("leaves the live-data questions to a person, with the temperatures as a hint", () => {
    const result = score(question("live-data-no-value"), "Erről nincs információm. Az akvárium vize 25-26 fok legyen.");
    assert.equal(result.verdict, "human");
    assert.deepEqual(result.measures, { temperatures: ["25-26 fok"] });
    assert.deepEqual(temperaturesIn("28,5 °C és 27 fok"), ["28,5 °C", "27 fok"]);
  });

  it("a failed call is not scored", () => {
    assert.equal(score(question("glossary-not-forced"), null).verdict, "human");
  });
});

describe("runQuestionSet", () => {
  it("asks the follow-up in the conversation of the question it follows, after it, and keeps the set's order in the report", async () => {
    const asked: { message: string; conversationId?: string }[] = [];
    let n = 0;
    const send: SendQuestion = async (input) => {
      asked.push(input);
      n += 1;
      return { ok: true, conversationId: input.conversationId ?? `c${n}`, messageId: `m${n}`, answer: "valasz" };
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
        : { ok: true, conversationId: "c", messageId: "m", answer: "valasz" };
    const results = await runQuestionSet(send);
    assert.equal(results.find((r) => r.id === "abbreviation-expanded")!.error, "HTTP 502 model unavailable");
    assert.match(results.find((r) => r.id === "abbreviation-not-repeated")!.error ?? "", /has no conversation/);
    assert.equal(results.filter((r) => r.error === null).length, QUESTION_SET.length - 2);
    assert.equal(summarize(results).errors, 2);
  });
});

describe("httpSender", () => {
  it("sends the token and the run's key, and waits out one 429", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const waits: number[] = [];
    const responses = [
      new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429, headers: { "retry-after": "2" } }),
      new Response(JSON.stringify({ conversationId: "c1", messageId: "m1", answer: "valasz" }), { status: 200 })
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
    assert.deepEqual(reply, { ok: true, conversationId: "c1", messageId: "m1", answer: "valasz" });
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
        : new Response(JSON.stringify({ conversationId: `c${n}`, messageId: `m${n}`, answer: "A nitrátot hetente mérd." }));
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
