import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  CONTACT_ASK_KIND,
  CONTACT_FORWARDED_ANSWER,
  CONTACT_OFFER_KIND,
  CONTACT_NOT_FORWARDED_ANSWER,
  CONTACT_OFFER,
  CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS,
  CONTACT_REQUEST_ENV,
  contactFlowActive,
  contactRequestEnabledInOs,
  contactRequestSwitch,
  maskHandedOver,
  opensContactReply,
  resetContactRequestSettingsCache,
  withContactOffer
} from "./contact-request-flow.js";
import { COLLEAGUE_OFFER_ENV, PREFILTER_ENV } from "./request-prefilter-answers.js";
import { COLLEAGUE_OFFER } from "./request-prefilter-turns.js";

/*
  THE GATES AND THE TEXTS OF THE CONTACT FLOW (slice 4c/4d). WHAT TURNS IT RED: the flow on while any one gate is off; an OS that
  cannot be read (or says anything but `true`) leaving the request on, also from a cached "on"; the cache holding longer than its
  time; a proposed text that promises a time, a person or a delivery it cannot keep, or carries a dash.
*/
const ON: NodeJS.ProcessEnv = {
  [PREFILTER_ENV]: "true",
  [COLLEAGUE_OFFER_ENV]: "true",
  [CONTACT_REQUEST_ENV]: "true",
  ACROPORA_OS_BASE_URL: "http://os.invalid",
  ACROPORA_OS_AI_CONTACT_TOKEN: "contact-token",
  ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN: "settings-token"
};
const view = (contactRequestEnabled: unknown) => ({
  offerEnabled: true,
  contactRequestEnabled,
  messageRetentionDays: 180,
  linkSources: []
});
const reading = (status: number, body: unknown, counter?: { n: number }) =>
  (async () => {
    if (counter) counter.n += 1;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

beforeEach(() => resetContactRequestSettingsCache());

describe("the contact switch", () => {
  it("is on only for exactly `true`", () => {
    assert.equal(contactRequestSwitch({ [CONTACT_REQUEST_ENV]: "true" }), true);
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "yes"])
      assert.equal(contactRequestSwitch({ [CONTACT_REQUEST_ENV]: value }), false, JSON.stringify(value));
  });
});

describe("contactFlowActive: every gate must hold, each fails closed", () => {
  it("is on with all gates, and the OS says true", async () => {
    assert.equal(await contactFlowActive(ON, reading(200, view(true))), true);
  });

  it("is off when any ONE env gate is off, and the OS is not even asked", async () => {
    const asked = { n: 0 };
    for (const key of [
      PREFILTER_ENV,
      COLLEAGUE_OFFER_ENV,
      CONTACT_REQUEST_ENV,
      "ACROPORA_OS_BASE_URL",
      "ACROPORA_OS_AI_CONTACT_TOKEN"
    ]) {
      const env = { ...ON };
      delete env[key];
      resetContactRequestSettingsCache();
      assert.equal(await contactFlowActive(env, reading(200, view(true), asked)), false, key);
    }
    assert.equal(asked.n, 0);
  });

  it("is off when the OS says false, says anything but a real `true`, fails, or cannot be read", async () => {
    const answers: Array<typeof fetch> = [
      reading(200, view(false)),
      reading(200, view("true")),
      reading(200, view(1)),
      reading(200, { offerEnabled: true }),
      reading(401, {}),
      reading(500, {}),
      (async () => {
        throw Object.assign(new Error("down"), { name: "TypeError" });
      }) as typeof fetch
    ];
    for (const fetchImpl of answers) {
      resetContactRequestSettingsCache();
      assert.equal(await contactFlowActive(ON, fetchImpl), false);
    }
  });

  it("is off when the OS settings token is not configured (the reader cannot be asked)", async () => {
    const env = { ...ON };
    delete env.ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN;
    assert.equal(await contactFlowActive(env, reading(200, view(true))), false);
  });
});

describe("the OS setting is cached for a minute, and a failure never keeps an old `on`", () => {
  it("reads once inside the minute, again after it", async () => {
    const asked = { n: 0 };
    const fetchImpl = reading(200, view(true), asked);
    assert.equal(await contactRequestEnabledInOs(1_000, fetchImpl, ON), true);
    assert.equal(await contactRequestEnabledInOs(30_000, fetchImpl, ON), true);
    assert.equal(asked.n, 1);
    assert.equal(await contactRequestEnabledInOs(61_001, fetchImpl, ON), true);
    assert.equal(asked.n, 2);
  });

  it("a switch-off in the OS reaches the flow within the minute, and a failed read after an `on` is `off`, not the old value", async () => {
    const asked = { n: 0 };
    assert.equal(await contactRequestEnabledInOs(0, reading(200, view(true), asked), ON), true);
    assert.equal(await contactRequestEnabledInOs(61_000, reading(200, view(false), asked), ON), false);
    assert.equal(await contactRequestEnabledInOs(130_000, reading(200, view(true), asked), ON), true);
    assert.equal(await contactRequestEnabledInOs(200_000, reading(500, {}, asked), ON), false);
  });

  it("a failed read is remembered only for a few seconds", async () => {
    const asked = { n: 0 };
    assert.equal(await contactRequestEnabledInOs(0, reading(500, {}, asked), ON), false);
    assert.equal(await contactRequestEnabledInOs(5_000, reading(200, view(true), asked), ON), false);
    assert.equal(asked.n, 1);
    assert.equal(await contactRequestEnabledInOs(11_000, reading(200, view(true), asked), ON), true);
    assert.equal(asked.n, 2);
  });
});

describe("the customer-facing proposals (4d): constraints, not wording", () => {
  const texts = {
    CONTACT_OFFER,
    CONTACT_FORWARDED_ANSWER,
    CONTACT_NOT_FORWARDED_ANSWER
  };

  it("carry no dash (em dash or double hyphen), no link and no number", () => {
    for (const [name, text] of Object.entries(texts)) {
      assert.equal(/—|–| -- /.test(text), false, `${name}: a dash`);
      assert.equal(/http|www\.|@|\d/i.test(text), false, `${name}: a link, an address or a number`);
    }
  });

  it("promise no time, no named person and nothing immediate", () => {
    for (const [name, text] of Object.entries(texts))
      assert.equal(
        /azonnal|hamarosan|percen belül|órán belül|napon belül|visszahív|még ma|mindjárt/i.test(text),
        false,
        name
      );
  });

  it("the offer keeps the approved sentence and the request for the contact stays a request (no claim before the customer answers)", () => {
    assert.ok(CONTACT_OFFER.startsWith(COLLEAGUE_OFFER));
    assert.ok(/e-mail-címedet vagy a telefonszámodat/.test(CONTACT_OFFER));
    assert.ok(!/továbbítottuk|megkaptuk/.test(CONTACT_OFFER));
  });

  it("the not-forwarded answer claims no delivery, and the forwarded one is the only text that says forwarded", () => {
    assert.ok(/nem sikerült/.test(CONTACT_NOT_FORWARDED_ANSWER));
    assert.ok(!/továbbítottuk/.test(CONTACT_NOT_FORWARDED_ANSWER));
    assert.ok(/továbbítottuk/.test(CONTACT_FORWARDED_ANSWER));
  });

  it("withContactOffer appends the offer after the model's answer, once", () => {
    const text = withContactOffer("A válasz.");
    assert.ok(text.startsWith("A válasz.\n\n"));
    assert.equal(text.split(CONTACT_OFFER).length, 2);
  });

  it("the model is told to ask for the contact and to invent nothing, and the instruction itself carries no number or address", () => {
    assert.ok(/next message/.test(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS));
    assert.ok(/Do not write any telephone number, e-mail address/.test(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS));
    assert.ok(/do not promise a callback, a time or a reply/.test(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS));
    assert.equal(/\d|@|http/.test(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS), false);
  });
});

describe("the flags and the masking of the handed-over value", () => {
  it("only a contact_offer or a contact_ask row opens the reading of the next message", () => {
    assert.equal(opensContactReply(CONTACT_OFFER_KIND), true);
    assert.equal(opensContactReply(CONTACT_ASK_KIND), true);
    for (const kind of [null, undefined, "", "other", "CONTACT_OFFER", "contact"])
      assert.equal(opensContactReply(kind), false, String(kind));
  });

  it("maskHandedOver replaces every occurrence of the value and nothing else", () => {
    assert.equal(maskHandedOver("a 06 30 123 4567 és 06 30 123 4567", "06 30 123 4567", "[x]"), "a [x] és [x]");
    assert.equal(maskHandedOver("06301234567 vagy a@b.hu", "06301234567", "[x]"), "[x] vagy a@b.hu");
    assert.equal(maskHandedOver("semmi", "06301234567", "[x]"), "semmi");
    assert.equal(maskHandedOver("szöveg", "", "[x]"), "szöveg");
  });
});
