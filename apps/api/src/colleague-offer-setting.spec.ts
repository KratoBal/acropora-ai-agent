import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { buildApp, type AppDependencies, type ConversationStore } from "./app.js";
import { CHAT_SETTINGS_PATH, CHAT_SETTINGS_TOKEN_ENV } from "./chat-settings.js";
import {
  colleagueOfferActive,
  offerEnabledInOs,
  resetColleagueOfferSettingCache
} from "./colleague-offer-setting.js";
import { CONTACT_REQUEST_ENV, contactFlowActive, resetContactRequestSettingsCache } from "./contact-request-flow.js";
import { CONTACT_REQUEST_TOKEN_ENV } from "./contact-request.js";
import { COLLEAGUE_OFFER_ENV, PREFILTER_ENV } from "./request-prefilter-answers.js";
import { COLLEAGUE_OFFER } from "./request-prefilter-turns.js";

/**
 * THE COLLEAGUE OFFER READS THE OS BOX (card f5b8f7ba, acrobot 49021). WHAT TURNS IT RED: the OS box is ignored (a saved "off"
 * still offers); the environment's gate is bypassed by an OS "on"; an unreadable OS turns the offer off (it must leave the
 * environment to decide, as before the box was read); the OS is asked on every message; an OS "off" still opens the contact request
 * (the offer is its only door); the route appends the sentence against the box.
 */
const BASE = "http://os.invalid";
const TOKEN = "felajanlas-olvaso-titok";
const view = (offerEnabled: boolean, contactRequestEnabled = false) => ({
  offerEnabled,
  contactRequestEnabled,
  messageRetentionDays: 180
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counting = (answer: () => Response) => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
};
const on = {
  ACROPORA_OS_BASE_URL: BASE,
  [CHAT_SETTINGS_TOKEN_ENV]: TOKEN,
  [PREFILTER_ENV]: "true",
  [COLLEAGUE_OFFER_ENV]: "true"
};

beforeEach(() => {
  resetColleagueOfferSettingCache();
  resetContactRequestSettingsCache();
});

describe("colleagueOfferActive", () => {
  it("the environment's gate first: switched off, there is no offer and the OS is not asked, whatever it says", async () => {
    for (const environment of [{ ...on, [COLLEAGUE_OFFER_ENV]: "false" }, { ...on, [PREFILTER_ENV]: "" }]) {
      const os = counting(() => json(view(true)));
      assert.equal(await colleagueOfferActive(environment, os.fetchImpl), false);
      assert.equal(os.calls(), 0);
    }
  });

  it("with the gate on, the OS box decides: a saved off is no offer, a saved on is one", async () => {
    assert.equal(await colleagueOfferActive(on, counting(() => json(view(false))).fetchImpl), false);
    resetColleagueOfferSettingCache();
    assert.equal(await colleagueOfferActive(on, counting(() => json(view(true))).fetchImpl), true);
  });

  it("an OS that cannot be read leaves the environment to decide, as before the box was read", async () => {
    for (const answer of [() => json({}, 503), () => json({}, 401), () => json({ nonsense: true })]) {
      resetColleagueOfferSettingCache();
      assert.equal(await colleagueOfferActive(on, counting(answer).fetchImpl), true);
    }
    resetColleagueOfferSettingCache();
    const unconfigured = { [PREFILTER_ENV]: "true", [COLLEAGUE_OFFER_ENV]: "true" };
    assert.equal(await colleagueOfferActive(unconfigured), true);
  });

  it("one read a minute; a failure is asked again after ten seconds", async () => {
    const good = counting(() => json(view(true)));
    await offerEnabledInOs(1_000, good.fetchImpl, on);
    await offerEnabledInOs(1_000 + 59_999, good.fetchImpl, on);
    assert.equal(good.calls(), 1);
    await offerEnabledInOs(1_000 + 60_000, good.fetchImpl, on);
    assert.equal(good.calls(), 2);

    resetColleagueOfferSettingCache();
    const down = counting(() => json({}, 503));
    await offerEnabledInOs(1_000, down.fetchImpl, on);
    await offerEnabledInOs(1_000 + 9_999, down.fetchImpl, on);
    assert.equal(down.calls(), 1);
    await offerEnabledInOs(1_000 + 10_000, down.fetchImpl, on);
    assert.equal(down.calls(), 2);
  });

  it("an OS off closes the contact request too: the offer is its only door", async () => {
    const environment = { ...on, [CONTACT_REQUEST_ENV]: "true", [CONTACT_REQUEST_TOKEN_ENV]: "kapcsolat-iro-titok" };
    assert.equal(await contactFlowActive(environment, counting(() => json(view(false, true))).fetchImpl), false);
    resetColleagueOfferSettingCache();
    resetContactRequestSettingsCache();
    assert.equal(await contactFlowActive(environment, counting(() => json(view(true, true))).fetchImpl), true);
  });
});

describe("the chat route appends the offer sentence only when the OS box allows it", () => {
  const API_TOKEN = "felajanlas-teszt-kulcs";
  const AQUARIUM = "Milyen világítás kell a korallokhoz az akváriumban?";
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  let box: boolean | "down" = true;

  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_ACCESS_TOKEN = API_TOKEN;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ACROPORA_OS_BASE_URL = BASE;
    process.env[CHAT_SETTINGS_TOKEN_ENV] = TOKEN;
    process.env[PREFILTER_ENV] = "true";
    process.env[COLLEAGUE_OFFER_ENV] = "true";
    delete process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN;
    delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
    delete process.env[CONTACT_REQUEST_ENV];
  });
  after(() => {
    process.env = saved;
    globalThis.fetch = realFetch;
  });
  beforeEach(() => {
    box = true;
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith(CHAT_SETTINGS_PATH) && box !== "down" ? json(view(box)) : json({}, 503)) as typeof fetch;
  });

  /** The answer to the FOURTH customer question: the offer's turn. */
  const fourthAnswer = async () => {
    const history = [
      ...[1, 2, 3].flatMap(() => [
        { role: "user", content: AQUARIUM },
        { role: "assistant", content: "A modell válasza." }
      ]),
      { role: "user", content: AQUARIUM }
    ];
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
        payload: { message: AQUARIUM }
      });
      return (response.json() as { answer: string }).answer;
    } finally {
      await app.close();
    }
  };

  it("box on: the sentence is there; box off: it is not; OS down: the environment's on decides", async () => {
    assert.equal((await fourthAnswer()).includes(COLLEAGUE_OFFER), true);
    resetColleagueOfferSettingCache();
    box = false;
    assert.equal((await fourthAnswer()).includes(COLLEAGUE_OFFER), false);
    resetColleagueOfferSettingCache();
    box = "down";
    assert.equal((await fourthAnswer()).includes(COLLEAGUE_OFFER), true);
  });
});
