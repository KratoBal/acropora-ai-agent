import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  buildApp,
  type AppDependencies,
  type AppLogger,
  type ConversationStore
} from "./app.js";
import {
  CONTACT_ASK_KIND,
  CONTACT_FORWARDED_ANSWER,
  CONTACT_NOT_FORWARDED_ANSWER,
  CONTACT_OFFER,
  CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS,
  CONTACT_OFFER_KIND,
  CONTACT_REQUEST_ENV,
  CONTACT_REQUEST_MODEL_LABEL,
  resetContactRequestSettingsCache
} from "./contact-request-flow.js";
import { CONTACT_PLACEHOLDER } from "./contact-mask.js";
import { COLLEAGUE_OFFER_ENV, PREFILTER_ENV } from "./request-prefilter-answers.js";
import { COLLEAGUE_OFFER, COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS } from "./request-prefilter-turns.js";

/*
  THE CONTACT REQUEST IN THE CHAT ROUTE (slice 4c/4d, card f5b8f7ba): the real `/v1/chat` handler, a fake conversation store, a fake
  model, and a stub `fetch` that routes by URL (the OS settings, the OS hand-over, the catalogue) and records every call.

  What is measured (plan matrix S7, S8, S14 and the gates): a reply to the flagged offer that holds a contact is handed to the OS with
  the message id as the key, NO model call; ONLY after the OS recorded it the stored message is masked and the local answer says
  forwarded; on any failure the stored row is untouched and the answer claims no delivery; a contact without the offer before it, or
  with the gates off, is no request; the offer asks for the contact and flags its row only while the flow is on; the value is in no
  log line.
*/
const API_TOKEN = "contact-teszt-kulcs";
const CONVERSATION = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";
const PHONE = "06 30 123 4567";

type Stored = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  localKind?: string | null;
};

const offerRow = (content = `Válasz.\n\n${CONTACT_OFFER}`): Stored => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  role: "assistant",
  content,
  localKind: CONTACT_OFFER_KIND
});

function fixture(seed: Stored[] = [], options: { maskFails?: boolean } = {}) {
  const messages: Stored[] = [...seed];
  const outcomes: Array<{ id: string; outcome: string }> = [];
  const masks: Array<{ id: string; content: string }> = [];
  let counter = 0;
  const store = {
    createConversation: async () => CONVERSATION,
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: Omit<Stored, "id">) => {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      messages.push({ id, ...input });
      return id;
    },
    setMessageOutcome: async (id: string, outcome: string) => {
      outcomes.push({ id, outcome });
    },
    maskUserMessage: async (id: string, content: string) => {
      if (options.maskFails) throw new Error(`database said no ${PHONE}`);
      masks.push({ id, content });
      const row = messages.find((message) => message.id === id);
      if (row) row.content = content;
    },
    getConversationMessages: async () =>
      messages.slice(-20).map(({ role, content, localKind }) => ({ role, content, localKind }))
  } as unknown as ConversationStore;
  let modelCalls = 0;
  const instructionsSeen: string[] = [];
  const modelInputs: string[] = [];
  const openai = {
    responses: {
      create: async (args: { instructions?: string; input?: Array<{ content: string }> }) => {
        modelCalls += 1;
        instructionsSeen.push(args.instructions ?? "");
        modelInputs.push(JSON.stringify(args.input ?? []));
        return { output_text: "A modell válasza." };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;
  const lines: unknown[] = [];
  const logger: AppLogger = {
    info: (payload: unknown, msg?: string) => lines.push(msg ? { ...(payload as object), msg } : payload),
    error: (payload: unknown, msg?: string) => lines.push(msg ? { ...(payload as object), msg } : payload),
    warn: (payload: unknown, msg?: string) => lines.push(msg ? { ...(payload as object), msg } : payload),
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    silent: () => {},
    level: "info",
    child: () => logger
  };
  return { store, openai, logger, messages, outcomes, masks, lines, instructionsSeen, modelInputs, modelCalls: () => modelCalls };
}

type OsBehaviour = {
  settings: () => Response | Promise<Response>;
  contact: () => Response | Promise<Response>;
};
const settingsView = (contactRequestEnabled: boolean) =>
  new Response(
    JSON.stringify({ offerEnabled: true, contactRequestEnabled, messageRetentionDays: 180, linkSources: [] }),
    { status: 200 }
  );
const receipt = () =>
  new Response(JSON.stringify({ id: "req-1", recorded: true, duplicate: false, notified: true }), { status: 200 });

let os: OsBehaviour;
let contactCalls: Array<{ body: Record<string, unknown>; authorization: string }>;
let settingsCalls: number;
let catalogueCalls: number;
const saved = { ...process.env };
const realFetch = globalThis.fetch;

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ACROPORA_OS_BASE_URL = "http://os.invalid";
  process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN = "catalogue-token";
  process.env.ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN = "settings-token";
  process.env.ACROPORA_OS_AI_CONTACT_TOKEN = "contact-token";
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

after(() => {
  process.env = saved;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetContactRequestSettingsCache();
  contactCalls = [];
  settingsCalls = 0;
  catalogueCalls = 0;
  os = { settings: () => settingsView(true), contact: receipt };
  process.env[PREFILTER_ENV] = "true";
  process.env[COLLEAGUE_OFFER_ENV] = "true";
  process.env[CONTACT_REQUEST_ENV] = "true";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("/integrations/ai-chat/contact-requests")) {
      contactCalls.push({
        body: JSON.parse(String(init?.body)),
        authorization: (init?.headers as Record<string, string>).authorization
      });
      return os.contact();
    }
    if (url.includes("/integrations/ai-chat-settings/service")) {
      settingsCalls += 1;
      return os.settings();
    }
    catalogueCalls += 1;
    return new Response(JSON.stringify({ hits: [] }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  for (const key of [PREFILTER_ENV, COLLEAGUE_OFFER_ENV, CONTACT_REQUEST_ENV]) delete process.env[key];
});

async function ask(fx: ReturnType<typeof fixture>, message: string) {
  const app = buildApp({ conversations: fx.store, openai: fx.openai, logger: fx.logger });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      payload: { message, conversationId: CONVERSATION }
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  } finally {
    await app.close();
  }
}

const seedAfterOffer = (): Stored[] => [
  { id: "00000000-0000-4000-8000-0000000000a0", role: "user", content: "Mi a helyzet a koralljaimmal?" },
  offerRow()
];
// Fastify's own request/response lines (`req`, `res`) hold the raw request as the fixture's logger receives it; production logs
// them through pino's serializers (method, url, host), never the body. What is measured here are the lines this service writes.
const noValueInLogs = (fx: ReturnType<typeof fixture>) => {
  const own = fx.lines.filter((line) => !("req" in (line as object)) && !("res" in (line as object)));
  assert.ok(own.length > 0, "the service wrote no log line of its own: the check would prove nothing");
  assert.ok(!JSON.stringify(own).includes("30 123"), "the contact value is in a log line");
};

describe("the reply to the offer that holds a contact: handed to the OS, answered locally", () => {
  it("S7 and S8: the OS is called once with the token and the message id as the key, then the stored message is masked, then the answer says forwarded; no model call, no catalogue call", async () => {
    const fx = fixture(seedAfterOffer());
    const { status, body } = await ask(fx, `Igen, kérem, a számom: ${PHONE}`);
    assert.equal(status, 200);
    assert.equal(fx.modelCalls(), 0);
    assert.equal(catalogueCalls, 0);
    assert.equal(contactCalls.length, 1);
    const sent = contactCalls[0]!;
    assert.equal(sent.authorization, "Bearer contact-token");
    const userRow = fx.messages.find((row) => row.role === "user" && row.content.includes("Igen, kérem"))!;
    assert.deepEqual(sent.body, {
      channel: "PHONE",
      value: PHONE,
      conversationRef: CONVERSATION,
      requestKey: userRow.id
    });
    // masked AFTER the receipt: the stored row has the placeholder, the rest of the text stays
    assert.equal(fx.masks.length, 1);
    assert.equal(userRow.content, `Igen, kérem, a számom: ${CONTACT_PLACEHOLDER}`);
    assert.equal(body.answer, CONTACT_FORWARDED_ANSWER);
    assert.equal(body.model, CONTACT_REQUEST_MODEL_LABEL);
    assert.equal((body.productContext as { state: string }).state, "not_asked");
    assert.equal(fx.messages.at(-1)?.content, CONTACT_FORWARDED_ANSWER);
    assert.equal(fx.messages.at(-1)?.model, CONTACT_REQUEST_MODEL_LABEL);
    assert.equal(fx.outcomes.at(-1)?.outcome, "contact_forwarded");
    noValueInLogs(fx);
  });

  it("an e-mail address is a request too, over the EMAIL channel", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, "vasarlo@example.hu");
    assert.equal(contactCalls[0]?.body.channel, "EMAIL");
    assert.equal(contactCalls[0]?.body.value, "vasarlo@example.hu");
  });

  it("S14: when the OS fails, refuses, or sends a body that is not the receipt, the stored row is UNTOUCHED, the answer claims no delivery, and no model runs", async () => {
    const failures: Array<() => Response | Promise<Response>> = [
      () => new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 409 }),
      () => new Response("{}", { status: 400 }),
      () => new Response("{}", { status: 401 }),
      () => new Response(JSON.stringify({ id: "x", recorded: false, duplicate: false, notified: false }), { status: 200 }),
      () => {
        throw Object.assign(new Error(`down ${PHONE}`), { name: "TypeError" });
      }
    ];
    for (const failing of failures) {
      os.contact = failing;
      const fx = fixture(seedAfterOffer());
      const { body } = await ask(fx, `Igen, a számom: ${PHONE}`);
      const userRow = fx.messages.find((row) => row.role === "user" && row.content.includes("Igen"))!;
      assert.equal(userRow.content, `Igen, a számom: ${PHONE}`, "the raw value must stay when nothing was delivered");
      assert.equal(fx.masks.length, 0);
      assert.equal(body.answer, CONTACT_NOT_FORWARDED_ANSWER);
      assert.equal(fx.modelCalls(), 0);
      assert.equal(fx.outcomes.at(-1)?.outcome, "contact_not_forwarded");
      noValueInLogs(fx);
    }
  });

  it("a failed masking after a recorded request still answers forwarded (the OS has it), logs the failure without the value or its text", async () => {
    const fx = fixture(seedAfterOffer(), { maskFails: true });
    const { body } = await ask(fx, `Igen, a számom: ${PHONE}`);
    assert.equal(body.answer, CONTACT_FORWARDED_ANSWER);
    assert.equal(contactCalls.length, 1);
    assert.ok(JSON.stringify(fx.lines).includes("could not mask the stored message"));
    assert.ok(!JSON.stringify(fx.lines).includes("database said no"));
    noValueInLogs(fx);
  });

  it("the contact log line names the channel and the outcome only", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, PHONE);
    const line = fx.lines.find((entry) => (entry as { contactRequest?: unknown }).contactRequest) as {
      contactRequest: Record<string, unknown>;
    };
    assert.deepEqual(line.contactRequest, { channel: "PHONE", ok: true, duplicate: false, notified: true });
  });
});

describe("what is NOT a request", () => {
  it("a contact typed WITHOUT the offer before it: no hand-over, the model answers (the model input is masked), the stored row is untouched", async () => {
    const fx = fixture([
      { id: "00000000-0000-4000-8000-0000000000a1", role: "user", content: "Mi a helyzet a koralljaimmal?" },
      { id: "00000000-0000-4000-8000-0000000000a0", role: "assistant", content: "Üdv!" }
    ]);
    const { body } = await ask(fx, `A számom ${PHONE}, mi a helyzet a koralljaimmal?`);
    assert.equal(contactCalls.length, 0);
    assert.equal(fx.modelCalls(), 1);
    assert.equal(body.answer, "A modell válasza.");
    assert.ok(!fx.modelInputs[0]!.includes("30 123"), "the model must not see the number");
    assert.equal(fx.masks.length, 0);
    assert.ok(fx.messages.some((row) => row.content.includes(PHONE)));
  });

  it("an ordinary assistant row that merely holds the offer SENTENCE (no flag) is not the offer: the flag, not the text, decides", async () => {
    const fx = fixture([
      { id: "00000000-0000-4000-8000-0000000000a1", role: "user", content: "Mi a helyzet a koralljaimmal?" },
      { id: "00000000-0000-4000-8000-0000000000a0", role: "assistant", content: `Válasz.\n\n${COLLEAGUE_OFFER}` }
    ]);
    await ask(fx, `${PHONE} a koralljaim miatt`);
    assert.equal(contactCalls.length, 0);
    assert.equal(fx.modelCalls(), 1);
  });

  it("a reply to the offer with NO contact goes to the model, with the instruction to ask for the contact", async () => {
    const fx = fixture(seedAfterOffer());
    const { body } = await ask(fx, "Igen, kérem");
    assert.equal(contactCalls.length, 0);
    assert.equal(fx.modelCalls(), 1);
    assert.equal(body.answer, "A modell válasza.");
    assert.ok(fx.instructionsSeen[0]!.includes(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS));
    assert.ok(!fx.instructionsSeen[0]!.includes(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS));
    // the model's answer asks for the contact, so ITS row is flagged: the next message is read as the reply
    assert.equal(fx.messages.at(-1)?.role, "assistant");
    assert.equal(fx.messages.at(-1)?.localKind, CONTACT_ASK_KIND);
  });

  it("an order number in the reply is no contact", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, "a rendelésszámom 123456");
    assert.equal(contactCalls.length, 0);
    assert.equal(fx.modelCalls(), 1);
  });

  it("the contact is read from the message right after the offer only: an older offer row does not count", async () => {
    const fx = fixture([...seedAfterOffer(), { id: "00000000-0000-4000-8000-0000000000b0", role: "user", content: "Mi az a bio-pellet?" }, {
      id: "00000000-0000-4000-8000-0000000000b1",
      role: "assistant",
      content: "Egy táplálék."
    }]);
    await ask(fx, PHONE);
    assert.equal(contactCalls.length, 0);
  });
});

describe("the customer who is asked for the contact again (barracuda on #80): the answer that asks is flagged, for ONE step", () => {
  const userRowOf = (fx: ReturnType<typeof fixture>, text: string) =>
    fx.messages.find((row) => row.role === "user" && row.content.includes(text))!;

  it("offer, 'Igen, kérem', the model's answer, then the number: the number is handed over and answered forwarded", async () => {
    const fx = fixture(seedAfterOffer());
    const first = await ask(fx, "Igen, kérem");
    assert.equal(first.body.answer, "A modell válasza.");
    assert.equal(contactCalls.length, 0);
    const second = await ask(fx, `a számom: ${PHONE}`);
    assert.equal(contactCalls.length, 1);
    assert.equal(contactCalls[0]?.body.value, PHONE);
    assert.equal(second.body.answer, CONTACT_FORWARDED_ANSWER);
    assert.equal(userRowOf(fx, "a számom").content, `a számom: ${CONTACT_PLACEHOLDER}`);
    // the answer to a message that followed a `contact_ask` row never carries a flag (a forwarded answer is unflagged)
    assert.equal(fx.messages.at(-1)?.localKind ?? null, null);
    assert.equal(fx.modelCalls(), 1);
  });

  it("offer, the number, an OS failure, the number again: handed over the second time (the not-forwarded answer is flagged: a retry is allowed)", async () => {
    const fx = fixture(seedAfterOffer());
    os.contact = () => new Response("{}", { status: 500 });
    const failed = await ask(fx, `a számom: ${PHONE}`);
    assert.equal(failed.body.answer, CONTACT_NOT_FORWARDED_ANSWER);
    assert.equal(fx.messages.at(-1)?.localKind, CONTACT_ASK_KIND);
    assert.equal(contactCalls.length, 1);
    os.contact = receipt;
    const again = await ask(fx, `újra a számom: ${PHONE}`);
    assert.equal(contactCalls.length, 2);
    assert.equal(again.body.answer, CONTACT_FORWARDED_ANSWER);
    // each attempt is its own message and its own key
    assert.notEqual(contactCalls[0]?.body.requestKey, contactCalls[1]?.body.requestKey);
    // the first (failed) message keeps its raw number, the delivered one is masked
    assert.equal(userRowOf(fx, "a számom:").content, `a számom: ${PHONE}`);
    assert.equal(userRowOf(fx, "újra a számom").content, `újra a számom: ${CONTACT_PLACEHOLDER}`);
  });

  it("the flag runs out after ONE step: a model answer after a `contact_ask` row is unflagged, and a number after it is no request", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, "Igen, kérem");
    assert.equal(fx.messages.at(-1)?.localKind, CONTACT_ASK_KIND);
    await ask(fx, "Mi a bio-pellet a koralljaimnak?");
    assert.equal(fx.messages.at(-1)?.role, "assistant");
    assert.equal(fx.messages.at(-1)?.localKind ?? null, null);
    // (this is the customer's fourth turn, so the fresh offer is appended to the answer: the model answered, nothing was handed over)
    await ask(fx, `a koralljaim miatt a számom ${PHONE}`);
    assert.equal(contactCalls.length, 0);
    assert.equal(fx.modelCalls(), 3);
    // and the raw number stays in the stored row (it was no request)
    assert.ok(userRowOf(fx, "a koralljaim miatt").content.includes(PHONE));
  });

  it("only a flagged offer or ask row opens the reading: an unflagged assistant row between is enough to close it", async () => {
    const fx = fixture([...seedAfterOffer(), { id: "00000000-0000-4000-8000-0000000000c0", role: "user", content: "Mi a bio-pellet?" }, {
      id: "00000000-0000-4000-8000-0000000000c1",
      role: "assistant",
      content: "Egy táplálék.",
    }]);
    await ask(fx, `a koralljaim miatt: ${PHONE}`);
    assert.equal(contactCalls.length, 0);
  });

  it("a second contact in the same message is NOT masked (it was not handed over): only the delivered value is replaced", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, `${PHONE} vagy vasarlo@example.hu`);
    assert.equal(contactCalls.length, 1);
    assert.equal(contactCalls[0]?.body.channel, "PHONE");
    const row = userRowOf(fx, "vagy");
    assert.equal(row.content, `${CONTACT_PLACEHOLDER} vagy vasarlo@example.hu`);
  });

  it("the delivered value is masked wherever it repeats in the message", async () => {
    const fx = fixture(seedAfterOffer());
    await ask(fx, `${PHONE}, tehát ${PHONE}`);
    const row = userRowOf(fx, "tehát");
    assert.equal(row.content, `${CONTACT_PLACEHOLDER}, tehát ${CONTACT_PLACEHOLDER}`);
  });
});

describe("the gates: any one off, and the route is what it was (no hand-over, the old offer text and instruction)", () => {
  const gates: Array<[string, () => void]> = [
    ["the contact switch off", () => delete process.env[CONTACT_REQUEST_ENV]],
    ["the offer switch off", () => delete process.env[COLLEAGUE_OFFER_ENV]],
    ["the pre-filter off", () => delete process.env[PREFILTER_ENV]],
    ["the OS setting off", () => {
      os.settings = () => settingsView(false);
    }],
    ["the OS settings unreadable", () => {
      os.settings = () => new Response("{}", { status: 500 });
    }],
    ["the write token missing", () => delete process.env.ACROPORA_OS_AI_CONTACT_TOKEN]
  ];

  for (const [name, close] of gates)
    it(name, async () => {
      const token = process.env.ACROPORA_OS_AI_CONTACT_TOKEN;
      close();
      try {
        const fx = fixture(seedAfterOffer());
        const { body } = await ask(fx, `Igen, a számom: ${PHONE}`);
        assert.equal(contactCalls.length, 0, "no hand-over");
        assert.equal(fx.masks.length, 0);
        assert.equal(body.answer, "A modell válasza.");
        assert.ok(!fx.modelInputs[0]!.includes("30 123"), "the model input stays masked");
      } finally {
        if (token) process.env.ACROPORA_OS_AI_CONTACT_TOKEN = token;
      }
    });

  it("with the contact switch off the OS settings are not even read (the default route makes no extra call)", async () => {
    delete process.env[CONTACT_REQUEST_ENV];
    const fx = fixture(seedAfterOffer());
    await ask(fx, "Igen, kérem");
    assert.equal(settingsCalls, 0);
  });
});

describe("the offer (4d): with the flow on it asks for the contact and flags its row; off, it is the old sentence", () => {
  const turns = async (fx: ReturnType<typeof fixture>) => {
    const answers: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const { body } = await ask(fx, `Mi a helyzet a koralljaimmal ${index}?`);
      answers.push(String(body.answer));
    }
    return answers;
  };

  it("the fourth answer carries the request for the contact, its row is flagged, and the model got the ask-for-the-contact instruction", async () => {
    const fx = fixture();
    const answers = await turns(fx);
    assert.ok(answers[3]!.includes(CONTACT_OFFER));
    assert.ok(answers.slice(0, 3).every((answer) => !answer.includes(COLLEAGUE_OFFER)));
    const flagged = fx.messages.filter((row) => row.localKind === CONTACT_OFFER_KIND);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0]!.content, answers[3]);
    assert.ok(fx.instructionsSeen.every((text) => text.includes(CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS)));
  });

  it("the reply to that very offer, end to end, is a request", async () => {
    const fx = fixture();
    await turns(fx);
    const { body } = await ask(fx, `Igen, ${PHONE}`);
    assert.equal(body.answer, CONTACT_FORWARDED_ANSWER);
    assert.equal(contactCalls.length, 1);
  });

  it("with the OS setting off the fourth answer is the OLD sentence (no ask for a contact), unflagged, with the old instruction", async () => {
    os.settings = () => settingsView(false);
    const fx = fixture();
    const answers = await turns(fx);
    assert.ok(answers[3]!.endsWith(COLLEAGUE_OFFER));
    assert.ok(!answers[3]!.includes(CONTACT_OFFER));
    assert.equal(fx.messages.filter((row) => row.localKind).length, 0);
    assert.ok(fx.instructionsSeen.every((text) => text.includes(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS)));
  });
});
