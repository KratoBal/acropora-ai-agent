import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { answerSize, DOSE_GUARD_FALLBACK } from "./answer-dose-guard.js";
import { LINK_GUARD_FALLBACK, LINK_RULE_ENV } from "./answer-link-guard.js";
import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import { httpSender, main, runQuestionSet, type RunReport, type SendQuestion } from "./question-set-run.js";

/*
  THE SIZE OF AN ANSWER BEFORE A GUARD REPLACED IT (task t-20261117-csere-elotti-meret; acrobot 55186). Two numbers, no text, only to the
  question-set runner (its own client key AND the instance switch), only in the response it reads. WHAT TURNS IT RED: the field going to an OS key, to the
  runner's key with the switch off, to an answer no guard replaced; any text of the model's answer travelling in it; the stored row changing; the
  runner dropping the numbers, or reading a text or a negative number as a size.
*/
const API_TOKEN = "meret-teszt-kulcs";
// the dose sentence is first; "Utána mérd a KH-t." is the SAFE rest that a replacement throws away: it must never travel in the response
const DOSE_ANSWER = "Adagolj napi 5 ml-t 100 literenként. Utána mérd a KH-t.";
const SAFE_REST = "Utána mérd a KH-t";
const EXTERNAL = "A legjobb ár itt: https://www.reefsupplies.ca/salt?q=a+vevo+szavai Ez a második mondat.";

describe("the size of an answer before a guard replaced it", () => {
  const saved = { ...process.env };
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.ACROPORA_OS_BASE_URL;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });
  after(() => {
    process.env = saved;
  });
  afterEach(() => {
    delete process.env.AI_DOSE_GUARD_DEBUG;
    delete process.env[LINK_RULE_ENV];
  });

  const ask = async (clientKey: string, modelText: string) => {
    const stored: string[] = [];
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: { role: string; content: string }) => {
        if (input.role === "assistant") stored.push(input.content);
        return "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";
      },
      setMessageOutcome: async () => {},
      getConversationMessages: async () => [{ role: "user", content: "Hogyan emeljem a KH-t?" }]
    } as unknown as ConversationStore;
    const openai = { responses: { create: async () => ({ output_text: modelText }) } } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${API_TOKEN}`, "x-client-key": clientKey },
        payload: { message: "Hogyan emeljem a KH-t?" }
      });
      return { raw: response.body, body: response.json() as Record<string, unknown>, stored };
    } finally {
      await app.close();
    }
  };

  it("answerSize counts the characters and the sentences the way the guard does, and carries no text", () => {
    assert.deepEqual(answerSize(DOSE_ANSWER), { chars: DOSE_ANSWER.length, sentences: 2 });
    assert.deepEqual(answerSize(""), { chars: 0, sentences: 0 });
    assert.deepEqual(Object.keys(answerSize("Egy. Kettő.")).sort(), ["chars", "sentences"]);
  });

  it("the runner key with the switch ON gets the size of a dose-guard swap: two numbers, none of the safe rest", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    const { raw, body, stored } = await ask("question-set-run", DOSE_ANSWER);
    assert.deepEqual(body.replacedOriginalSize, { chars: DOSE_ANSWER.length, sentences: 2 });
    assert.equal(body.answer, DOSE_GUARD_FALLBACK);
    assert.equal(raw.includes(SAFE_REST), false, "the safe sentence the replacement throws away must not travel");
    assert.deepEqual(stored, [DOSE_GUARD_FALLBACK], "the stored row is the replacement, unchanged");
  });

  it("a link-guard swap under `enforce` reports its size too", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    process.env[LINK_RULE_ENV] = "enforce";
    const { body } = await ask("question-set-run", EXTERNAL);
    assert.equal(body.answer, LINK_GUARD_FALLBACK);
    assert.deepEqual(body.replacedOriginalSize, { chars: EXTERNAL.length, sentences: answerSize(EXTERNAL).sentences });
  });

  it("an OS key, the runner key with the switch off or not exactly true, and a look-alike key never get it", async () => {
    for (const [clientKey, enabled] of [
      ["os-user:42", "true"],
      ["question-set-run-x", "true"],
      ["QUESTION-SET-RUN", "true"],
      ["question-set-run", undefined],
      ["question-set-run", "1"]
    ] as const) {
      if (enabled === undefined) delete process.env.AI_DOSE_GUARD_DEBUG;
      else process.env.AI_DOSE_GUARD_DEBUG = enabled;
      const { body } = await ask(clientKey, DOSE_ANSWER);
      assert.equal(body.answer, DOSE_GUARD_FALLBACK, `${clientKey}/${enabled}`);
      assert.equal("replacedOriginalSize" in body, false, `${clientKey}/${enabled}`);
    }
  });

  it("an answer no guard replaced carries no size, nor does a link-guard `log` (not replaced)", async () => {
    process.env.AI_DOSE_GUARD_DEBUG = "true";
    const clean = await ask("question-set-run", "A KH-t hetente mérd.");
    assert.equal("replacedOriginalSize" in clean.body, false);
    process.env[LINK_RULE_ENV] = "log";
    const logged = await ask("question-set-run", EXTERNAL);
    assert.equal(logged.body.answer, EXTERNAL);
    assert.equal("replacedOriginalSize" in logged.body, false);
  });
});

describe("the runner reads the size", () => {
  const fetchWith = (extra: Record<string, unknown>) =>
    (async () =>
      new Response(
        JSON.stringify({ conversationId: "c", messageId: "m", answer: "csere", model: "gpt-5.1", doseGuard: "DOSE_NOT_IN_CATALOGUE", doseGuardRule: "given-count", ...extra })
      )) as unknown as typeof fetch;
  const send = (extra: Record<string, unknown>) => httpSender({ baseUrl: "http://ai.test", token: "t", clientKey: "question-set-run", fetchImpl: fetchWith(extra) })({ message: "x" });

  it("two whole non-negative numbers are kept; text, a negative, a fraction or a missing key are dropped", async () => {
    const ok = await send({ replacedOriginalSize: { chars: 340, sentences: 6 } });
    assert.deepEqual(ok.ok && ok.replacedOriginalSize, { chars: 340, sentences: 6 });
    for (const bad of [
      { chars: "a long answer text", sentences: 6 },
      { chars: -1, sentences: 6 },
      { chars: 3.5, sentences: 6 },
      { chars: 340 },
      "Adagolj napi 5 ml-t",
      null
    ]) {
      const dropped = await send({ replacedOriginalSize: bad });
      assert.equal(dropped.ok && dropped.replacedOriginalSize, null, JSON.stringify(bad));
    }
    const none = await send({});
    assert.equal(none.ok && none.replacedOriginalSize, null);
  });

  it("the size is in the result and in the written report", async () => {
    const sender: SendQuestion = async () => ({
      ok: true,
      conversationId: "c",
      messageId: "m",
      answer: "csere",
      source: "replaced",
      replacedBy: "doseGuard: DOSE_NOT_IN_CATALOGUE (given-count)",
      replacedSentence: null,
      replacedOriginalSize: { chars: 120, sentences: 3 },
      instructionsVersion: "0123456789ab",
      productContext: null
    });
    const results = await runQuestionSet(sender);
    assert.ok(results.every((r) => r.replacedOriginalSize?.chars === 120 && r.replacedOriginalSize.sentences === 3));
    const dir = mkdtempSync(join(tmpdir(), "question-set-size-"));
    const out = join(dir, "r.json");
    const fetchImpl = (async (url: string) =>
      url.endsWith("/health")
        ? new Response(JSON.stringify({ version: "s1" }))
        : new Response(
            JSON.stringify({ conversationId: "c", messageId: "m", answer: "csere", model: "gpt-5.1", doseGuard: "DOSE_NOT_IN_CATALOGUE", doseGuardRule: "given-count", replacedOriginalSize: { chars: 77, sentences: 2 } })
          )) as unknown as typeof fetch;
    await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl });
    const report = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    assert.ok(report.results.every((r) => r.replacedOriginalSize?.chars === 77));
  });
});
