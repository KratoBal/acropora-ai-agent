import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import { CHAT_SETTINGS_TOKEN_ENV } from "./chat-settings.js";
import {
  OFFTOPIC_THRESHOLD_CACHE_MS,
  OFFTOPIC_THRESHOLD_PATH,
  clearOffTopicThresholdCache,
  readOffTopicThreshold
} from "./offtopic-threshold.js";
import { PREFILTER_BLOCK_ANSWER, PREFILTER_ENV } from "./request-prefilter-answers.js";
import { OFFTOPIC_SERIES_FIRM_AT, PREFILTER_FIRM_BLOCK_ANSWER } from "./request-prefilter-turns.js";

/**
 * THE OFF-TOPIC THRESHOLD FROM THE OS (card f5b8f7ba; Balázs 2026-11-11 08:51: 5, settable in the Settings). WHAT TURNS IT RED:
 * the saved value is not used; a failure, a missing field or a value outside 2 to 20 reads as anything but 5 (or is moved to the
 * nearest legal value); the token travels in a failure; the OS is asked on every turn, or a failure is cached; the route asks the
 * OS for a question that is not off-topic, or answers with the firmer text before the threshold.
 */
const BASE = "http://os.invalid";
const TOKEN = "kuszob-olvaso-titok";
const env = { ACROPORA_OS_BASE_URL: BASE, [CHAT_SETTINGS_TOKEN_ENV]: TOKEN };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counting = (answer: () => Response | Promise<Response>) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return answer();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

beforeEach(() => clearOffTopicThresholdCache());

describe("readOffTopicThreshold", () => {
  it("the saved value, read from the settings reader of the OS", async () => {
    const { calls, fetchImpl } = counting(() => json({ offTopicFirmAt: 3, messageRetentionDays: 180 }));
    assert.deepEqual(await readOffTopicThreshold({ environment: env, fetchImpl }), { ok: true, firmAt: 3, source: "os" });
    assert.deepEqual(calls, [`${BASE}${OFFTOPIC_THRESHOLD_PATH}`]);
  });

  it("an OS before the field: Balázs's 5, said so, not a broken answer", async () => {
    const { fetchImpl } = counting(() => json({ messageRetentionDays: 180 }));
    assert.deepEqual(await readOffTopicThreshold({ environment: env, fetchImpl }), {
      ok: true,
      firmAt: 5,
      source: "os_without_field"
    });
  });

  it("a value outside 2 to 20, a fraction or a text is the default, never the nearest legal value", async () => {
    for (const value of [1, 21, 4.5, "5", null]) {
      clearOffTopicThresholdCache();
      const { fetchImpl } = counting(() => json({ offTopicFirmAt: value }));
      assert.deepEqual(
        await readOffTopicThreshold({ environment: env, fetchImpl }),
        { ok: false, firmAt: OFFTOPIC_SERIES_FIRM_AT, reason: "bad_response" },
        JSON.stringify(value)
      );
    }
  });

  it("not configured, refused or unreachable: 5, the reason named, the token nowhere in it", async () => {
    assert.deepEqual(await readOffTopicThreshold({ environment: {} }), {
      ok: false,
      firmAt: 5,
      reason: "not_configured"
    });
    const refused = await readOffTopicThreshold({ environment: env, fetchImpl: counting(() => json({}, 401)).fetchImpl });
    assert.deepEqual(refused, { ok: false, firmAt: 5, reason: "unauthorized" });
    const down = await readOffTopicThreshold({ environment: env, fetchImpl: counting(() => json({}, 503)).fetchImpl });
    assert.deepEqual(down, { ok: false, firmAt: 5, reason: "unavailable" });
    assert.equal(JSON.stringify([refused, down]).includes(TOKEN), false);
  });

  it("one read a minute; a failed read is not cached", async () => {
    const good = counting(() => json({ offTopicFirmAt: 7 }));
    await readOffTopicThreshold({ environment: env, fetchImpl: good.fetchImpl, now: 1_000 });
    await readOffTopicThreshold({ environment: env, fetchImpl: good.fetchImpl, now: 1_000 + OFFTOPIC_THRESHOLD_CACHE_MS - 1 });
    assert.equal(good.calls.length, 1);
    await readOffTopicThreshold({ environment: env, fetchImpl: good.fetchImpl, now: 1_000 + OFFTOPIC_THRESHOLD_CACHE_MS });
    assert.equal(good.calls.length, 2);

    clearOffTopicThresholdCache();
    const bad = counting(() => json({}, 503));
    await readOffTopicThreshold({ environment: env, fetchImpl: bad.fetchImpl, now: 1_000 });
    await readOffTopicThreshold({ environment: env, fetchImpl: bad.fetchImpl, now: 1_001 });
    assert.equal(bad.calls.length, 2);
  });
});

describe("the chat route takes the firmer text from the threshold the OS holds", () => {
  const API_TOKEN = "kuszob-teszt-kulcs";
  const OFF_TOPIC = "Ki nyerte tegnap a meccset?";
  const AQUARIUM = "Milyen világítás kell a korallokhoz az akváriumban?";
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let settingsCalls = 0;
  let settingsBody: unknown = { offTopicFirmAt: 3 };
  let settingsStatus = 200;

  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ACROPORA_OS_BASE_URL = BASE;
    process.env[CHAT_SETTINGS_TOKEN_ENV] = TOKEN;
    process.env[PREFILTER_ENV] = "true";
    // the catalogue search is not configured: only the settings read goes to the stub
    delete process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
  });
  after(() => {
    process.env = saved;
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    settingsCalls = 0;
    settingsBody = { offTopicFirmAt: 3 };
    settingsStatus = 200;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith(OFFTOPIC_THRESHOLD_PATH)) settingsCalls++;
      return json(settingsBody, settingsStatus);
    }) as typeof fetch;
  });

  /** The answer to the last of `questions`, the earlier ones already in the history with a local answer each. */
  const answerTo = async (questions: string[]) => {
    const history = questions.flatMap((content, index) =>
      index < questions.length - 1
        ? [
            { role: "user", content },
            { role: "assistant", content: PREFILTER_BLOCK_ANSWER }
          ]
        : [{ role: "user", content }]
    );
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async () => "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f",
      setMessageOutcome: async () => {},
      getConversationMessages: async () => history
    } as unknown as ConversationStore;
    const openai = {
      responses: { create: async () => ({ output_text: "A modell válasza." }) }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { message: questions.at(-1) }
      });
      return (response.json() as { answer: string }).answer;
    } finally {
      await app.close();
    }
  };
  const offTopic = (count: number) => Array.from({ length: count }, () => OFF_TOPIC);

  it("the setting 3: the second off-topic question is still friendly, the third is firm", async () => {
    assert.equal(await answerTo(offTopic(2)), PREFILTER_BLOCK_ANSWER);
    assert.equal(await answerTo(offTopic(3)), PREFILTER_FIRM_BLOCK_ANSWER);
    // one read a minute, whatever the turns
    assert.equal(settingsCalls, 1);
  });

  it("the setting unreadable: Balázs's 5, the fourth friendly and the fifth firm", async () => {
    settingsStatus = 503;
    assert.equal(await answerTo(offTopic(4)), PREFILTER_BLOCK_ANSWER);
    assert.equal(await answerTo(offTopic(5)), PREFILTER_FIRM_BLOCK_ANSWER);
  });

  it("an aquarium question does not ask the OS for the threshold", async () => {
    await answerTo([AQUARIUM]);
    assert.equal(settingsCalls, 0);
  });
});
