import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import {
  buildApp,
  type AppDependencies,
  type AppLogger,
  type ConversationStore
} from "./app.js";
import {
  PREFILTER_ASK_ANSWER,
  PREFILTER_BLOCK_ANSWER,
  COLLEAGUE_OFFER_ENV,
  PREFILTER_ENV,
  PREFILTER_MODEL_LABEL,
  prefilterEnabled
} from "./request-prefilter-answers.js";
import {
  COLLEAGUE_OFFER,
  COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS,
  PREFILTER_FIRM_BLOCK_ANSWER
} from "./request-prefilter-turns.js";

/*
  THE PRE-FILTER IN THE CHAT ROUTE (slice 2, card f5b8f7ba): the real `/v1/chat` handler, a fake conversation store, a fake model
  and a stub `fetch` that counts. What is measured: with the switch off the route is what it was; on, a `block` and an `ask` are
  answered locally with NO model call and NO catalogue call, saved as assistant messages, noted as an outcome; a `pass` goes on to the
  model as before; the gate reads the history without the message it judges; the log line carries no text.

  Matrix rows 17 (a: no model call), 25 (no network call), 27 (the local answer is saved as an assistant message), 28 (`pass`
  unchanged), 31 (the history is what is read, here as the conversation store's rows).
*/
const API_TOKEN = "prefilter-teszt-kulcs";
const CONVERSATION = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30";

type Stored = { id: string; role: "user" | "assistant" | "system"; content: string; model?: string };

function fixture(seed: Stored[] = []) {
  const messages: Stored[] = [...seed];
  const outcomes: Array<{ id: string; outcome: string }> = [];
  let counter = 0;
  const store = {
    createConversation: async () => CONVERSATION,
    conversationBelongsToClient: async () => true,
    saveMessage: async (input: { role: Stored["role"]; content: string; model?: string }) => {
      counter += 1;
      const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
      messages.push({ id, ...input });
      return id;
    },
    setMessageOutcome: async (id: string, outcome: string) => {
      outcomes.push({ id, outcome });
    },
    // The real store returns the LAST twenty messages in time order (ORDER BY created_at DESC LIMIT 20, reversed).
    getConversationMessages: async () => messages.slice(-20).map(({ role, content }) => ({ role, content }))
  } as unknown as ConversationStore;
  let modelCalls = 0;
  const instructionsSeen: string[] = [];
  const openai = {
    responses: {
      create: async (args: { instructions?: string }) => {
        modelCalls += 1;
        instructionsSeen.push(args.instructions ?? "");
        return { output_text: "A modell válasza." };
      }
    }
  } as unknown as NonNullable<AppDependencies["openai"]>;
  const lines: unknown[] = [];
  const logger: AppLogger = {
    info: (payload) => lines.push(payload),
    error: (payload) => lines.push(payload),
    warn: (payload) => lines.push(payload),
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    silent: () => {},
    level: "info",
    child: () => logger
  };
  return { store, openai, logger, messages, outcomes, lines, instructionsSeen, modelCalls: () => modelCalls };
}

const saved = { ...process.env };
let fetchCalls = 0;
const realFetch = globalThis.fetch;

before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  // The catalogue IS configured here, so a search would be a real `fetch`: the stub counts it, and a blocked question must show none.
  process.env.ACROPORA_OS_BASE_URL = "http://os.invalid";
  process.env.ACROPORA_OS_PRODUCT_SEARCH_TOKEN = "teszt-token";
  delete process.env.ACROPORA_OS_AI_SERVICE_TOKEN;
});

after(() => {
  process.env = saved;
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env[PREFILTER_ENV];
  delete process.env[COLLEAGUE_OFFER_ENV];
});

async function ask(fx: ReturnType<typeof fixture>, message: string, conversationId?: string) {
  const app = buildApp({ conversations: fx.store, openai: fx.openai, logger: fx.logger });
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: `Bearer ${API_TOKEN}`, "content-type": "application/json" },
      payload: { message, ...(conversationId ? { conversationId } : {}) }
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  } finally {
    await app.close();
  }
}

describe("the pre-filter switch", () => {
  it("is on only for exactly `true`", () => {
    assert.equal(prefilterEnabled({ [PREFILTER_ENV]: "true" }), true);
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "yes"])
      assert.equal(prefilterEnabled({ [PREFILTER_ENV]: value }), false, JSON.stringify(value));
  });
});

describe("POST /v1/chat with the pre-filter OFF (the default): the route is what it was", () => {
  it("row 28: an off-topic question still reaches the model, the catalogue search runs, nothing is local", async () => {
    const fx = fixture();
    const { status, body } = await ask(fx, "Hány fok volt ma Budapesten?");
    assert.equal(status, 200);
    assert.equal(body.answer, "A modell válasza.");
    assert.equal(fx.modelCalls(), 1);
    assert.equal(fetchCalls > 0, true, "the catalogue was asked");
    assert.equal(fx.outcomes.at(-1)?.outcome, "answered");
  });
});

describe("POST /v1/chat with the pre-filter ON", () => {
  beforeEach(() => {
    process.env[PREFILTER_ENV] = "true";
  });

  it("rows 17a and 25: a `block` makes no model call and no catalogue call, and answers the local text", async () => {
    const fx = fixture();
    const { status, body } = await ask(fx, "Hány fok volt ma Budapesten?");
    assert.equal(status, 200);
    assert.equal(fx.modelCalls(), 0);
    assert.equal(fetchCalls, 0);
    assert.equal(body.answer, PREFILTER_BLOCK_ANSWER);
    assert.equal(body.model, PREFILTER_MODEL_LABEL);
    assert.equal(body.doseGuard, null);
    assert.equal((body.productContext as { state: string }).state, "not_asked");
  });

  it("an `ask` makes no model call and no catalogue call, and answers the clarifying question", async () => {
    const fx = fixture();
    const { body } = await ask(fx, "Hány fok volt ma?");
    assert.equal(fx.modelCalls(), 0);
    assert.equal(fetchCalls, 0);
    assert.equal(body.answer, PREFILTER_ASK_ANSWER);
  });

  it("row 27: the local answer is SAVED as an assistant message after the user's message, and its id is the answer's", async () => {
    const fx = fixture();
    const { body } = await ask(fx, "Ki nyerte tegnap a meccset?");
    assert.deepEqual(
      fx.messages.map((m) => [m.role, m.model ?? null]),
      [["user", null], ["assistant", PREFILTER_MODEL_LABEL]]
    );
    assert.equal(fx.messages[1].content, PREFILTER_BLOCK_ANSWER);
    assert.equal(body.messageId, fx.messages[1].id);
    assert.equal(body.conversationId, CONVERSATION);
  });

  it("the outcome of the user's message is noted: prefilter_block, prefilter_ask", async () => {
    const blocked = fixture();
    await ask(blocked, "Írj nekem egy verset.");
    assert.equal(blocked.outcomes.at(-1)?.outcome, "prefilter_block");
    assert.equal(blocked.outcomes.at(-1)?.id, blocked.messages[0].id);
    const asked = fixture();
    await ask(asked, "Szia!");
    assert.equal(asked.outcomes.at(-1)?.outcome, "prefilter_ask");
  });

  it("row 28: a question about the aquarium or the order goes on to the model as before", async () => {
    for (const message of ["Hány fokos legyen a tengeri akvárium vize?", "Mikor érkezik meg a rendelésem?"]) {
      const fx = fixture();
      const { body } = await ask(fx, message);
      assert.equal(body.answer, "A modell válasza.", message);
      assert.equal(fx.modelCalls(), 1, message);
      assert.equal(fx.outcomes.at(-1)?.outcome, "answered", message);
    }
  });

  it("row 31 (the history as the store holds it): `Hány fok volt ma?` passes after an aquarium talk and asks without one", async () => {
    const talk: Stored[] = [
      { id: "m1", role: "user", content: "Milyen világítás kell a 200 literes akváriumomba?" },
      { id: "m2", role: "assistant", content: "Ez függ a korallok fajtájától." }
    ];
    const carried = fixture(talk);
    const { body } = await ask(carried, "Hány fok volt ma?", CONVERSATION);
    assert.equal(body.answer, "A modell válasza.");
    assert.equal(carried.modelCalls(), 1);
    const alone = fixture();
    assert.equal((await ask(alone, "Hány fok volt ma?")).body.answer, PREFILTER_ASK_ANSWER);
  });

  it("the gate reads the FOUR messages before the one it judges: the stored message itself takes no slot", async () => {
    // The topic stands exactly four messages back. If the stored message under judgement counted as one of the four, the topic
    // would fall out of the window and the ambiguous question would ask.
    const talk: Stored[] = [
      { id: "m1", role: "user", content: "Milyen akváriumot vegyek?" },
      { id: "m2", role: "assistant", content: "Ez függ a helytől." },
      { id: "m3", role: "user", content: "Köszönöm." },
      { id: "m4", role: "assistant", content: "Szívesen." }
    ];
    const { body } = await ask(fixture(talk), "Hány fok volt ma?", CONVERSATION);
    assert.equal(body.answer, "A modell válasza.");
  });

  it("a block never reads the history: an exit signal after an aquarium talk is still a block", async () => {
    const talk: Stored[] = [{ id: "m1", role: "user", content: "Milyen korallokat tartsak az akváriumban?" }];
    const fx = fixture(talk);
    const { body } = await ask(fx, "Ki nyerte a meccset?", CONVERSATION);
    assert.equal(body.answer, PREFILTER_BLOCK_ANSWER);
    assert.equal(fx.modelCalls(), 0);
  });

  it("the gate comes BEFORE the key check: a local answer needs no OpenAI key", async () => {
    const fx = fixture();
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const blocked = await ask(fx, "Ki nyerte tegnap a meccset?");
      assert.equal(blocked.status, 200);
      const passed = await ask(fixture(), "Mikor érkezik meg a rendelésem?");
      assert.equal(passed.status, 503);
    } finally {
      process.env.OPENAI_API_KEY = key;
    }
  });

  it("row 26: the log line carries category, decision and reason, and no fragment of the message", async () => {
    const fx = fixture();
    const secret = "titkos-szoveg-7788";
    await ask(fx, `Írj nekem egy verset a ${secret} nevű kutyámról`);
    const line = fx.lines.find((l) => (l as { prefilter?: unknown }).prefilter) as { prefilter: Record<string, string> };
    assert.deepEqual(line.prefilter, { category: "off-topic", decision: "block", reason: "exit-signal" });
    // The framework's own request lines carry a raw `req` object here (pino's serializers are not in play with a fake logger);
    // what is measured is every line the SERVICE writes, so those are left out.
    const own = fx.lines.filter((l) => !("req" in (l as object)) && !("res" in (l as object)));
    assert.equal(own.length > 0, true, "the service wrote at least the gate line");
    assert.equal(JSON.stringify(own).includes(secret), false);
  });
});

describe("the local texts (matrix row 17: what an answer without a model must not do)", () => {
  const texts = { block: PREFILTER_BLOCK_ANSWER, ask: PREFILTER_ASK_ANSWER };

  it("state no value and suggest no lookup", () => {
    for (const [name, text] of Object.entries(texts)) {
      assert.equal(/\d|°|fok\b/.test(text), false, `${name}: a number or a temperature`);
      assert.equal(/lekérdez|megnéz|utánanéz|keresek|keresünk/i.test(text), false, `${name}: suggests a lookup`);
    }
  });

  it("name no external service, not even as a type", () => {
    for (const [name, text] of Object.entries(texts))
      assert.equal(
        /időjárás|meteorol|weather|google|internet|böngész|keresőmotor|alkalmazás|szolgáltató|honlap|weboldal|térkép/i.test(text),
        false,
        name
      );
  });

  it("the block text names no service and says what we CAN help with; both texts are plain Hungarian sentences", () => {
    assert.match(PREFILTER_BLOCK_ANSWER, /nem tudunk segíteni/);
    assert.match(PREFILTER_BLOCK_ANSWER, /akvarisztik/);
    assert.match(PREFILTER_ASK_ANSWER, /\?/);
  });
});

/*
  SLICE 3 THROUGH THE ROUTE: several turns on ONE conversation, the store being the history (rows 18-24 and 31 of the plan, and 19a-19f
  of its fourth round). `turns` asks the questions one after another and returns each response and what the store holds after it.
*/
async function turns(fx: ReturnType<typeof fixture>, questions: string[]) {
  const answers: string[] = [];
  for (const [index, question] of questions.entries())
    answers.push(String((await ask(fx, question, index === 0 ? undefined : CONVERSATION)).body.answer));
  return answers;
}

const AQUARIUM = "Milyen világítás kell a korallokhoz az akváriumban?";
const OFF_TOPIC = "Ki nyerte tegnap a meccset?";

describe("the colleague offer (rows 19a-19f)", () => {
  beforeEach(() => {
    process.env[PREFILTER_ENV] = "true";
    process.env[COLLEAGUE_OFFER_ENV] = "true";
  });

  it("19a, 19b, 19c, 19d: absent at three turns, there at the fourth, answers go on, never again", async () => {
    const fx = fixture();
    const answers = await turns(fx, Array.from({ length: 12 }, () => AQUARIUM));
    answers.forEach((answer, index) => {
      const offered = answer.includes(COLLEAGUE_OFFER);
      assert.equal(offered, index === 3, `turn ${index + 1}`);
      assert.equal(answer.startsWith("A modell válasza."), true, `turn ${index + 1} still answers`);
    });
    assert.equal(fx.modelCalls(), 12, "no extra model call for the offer");
  });

  it("19f: exactly one assistant message is saved per customer message (the ground of `once`)", async () => {
    const fx = fixture();
    await turns(fx, [AQUARIUM, OFF_TOPIC, "Szia!", AQUARIUM, AQUARIUM]);
    assert.deepEqual(
      fx.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]
    );
  });

  it("the offer is saved WITH the answer, so the history shows what the customer saw", async () => {
    const fx = fixture();
    await turns(fx, [AQUARIUM, AQUARIUM, AQUARIUM, AQUARIUM]);
    assert.equal(fx.messages.at(-1)?.content.endsWith(COLLEAGUE_OFFER), true);
  });

  it("the turns count from the history: assistant rows are no turns (row 23) and the local answers do not shift the count", async () => {
    // Two aquarium turns, two local ones, then the fourth customer turn: four turns of eight messages.
    const fx = fixture();
    const answers = await turns(fx, [AQUARIUM, OFF_TOPIC, "Szia!", AQUARIUM]);
    assert.equal(answers[3].includes(COLLEAGUE_OFFER), true);
    assert.equal(answers[2].includes(COLLEAGUE_OFFER), false);
  });

  it("row 24: a long conversation counts from the twenty-message window and never offers again", async () => {
    const fx = fixture();
    const answers = await turns(fx, Array.from({ length: 30 }, () => AQUARIUM));
    assert.equal(answers.filter((a) => a.includes(COLLEAGUE_OFFER)).length, 1);
  });

  it("the offer needs BOTH switches: the pre-filter off, or its own switch off (the default), the fourth answer is the model's alone", async () => {
    delete process.env[PREFILTER_ENV];
    const gateOff = await turns(fixture(), Array.from({ length: 5 }, () => AQUARIUM));
    assert.equal(gateOff.some((a) => a.includes(COLLEAGUE_OFFER)), false);

    process.env[PREFILTER_ENV] = "true";
    delete process.env[COLLEAGUE_OFFER_ENV];
    const offerOff = await turns(fixture(), Array.from({ length: 5 }, () => AQUARIUM));
    assert.equal(offerOff.some((a) => a.includes(COLLEAGUE_OFFER)), false);
    for (const value of ["", "false", "TRUE", "1", " true"]) {
      process.env[COLLEAGUE_OFFER_ENV] = value;
      const other = await turns(fixture(), Array.from({ length: 5 }, () => AQUARIUM));
      assert.equal(other.some((a) => a.includes(COLLEAGUE_OFFER)), false, JSON.stringify(value));
    }
  });

  it("19e: the sentence promises no forwarding, callback or immediate contact, asks nothing and holds no contact data", () => {
    assert.equal(/\?/.test(COLLEAGUE_OFFER), false, "a question");
    assert.equal(/\d|@|http|www/i.test(COLLEAGUE_OFFER), false, "a number, an address or a link");
    assert.equal(/hamarosan|visszah|keres(ünk|ni)|jelentkez|azonnal|továbbít|átad|értesít|ígér/i.test(COLLEAGUE_OFFER), false);
  });
});

describe("the off-topic series (rows 21 and 22)", () => {
  beforeEach(() => {
    process.env[PREFILTER_ENV] = "true";
  });

  it("21: the firmer text from the fifth off-topic question in a row, still no model call", async () => {
    const fx = fixture();
    const answers = await turns(fx, Array.from({ length: 7 }, () => OFF_TOPIC));
    answers.forEach((answer, index) =>
      assert.equal(answer, index < 4 ? PREFILTER_BLOCK_ANSWER : PREFILTER_FIRM_BLOCK_ANSWER, `turn ${index + 1}`)
    );
    assert.equal(fx.modelCalls(), 0);
    assert.equal(fetchCalls, 0);
  });

  it("22: one aquarium question in between resets it: the next off-topic question gets the friendly text again", async () => {
    const fx = fixture();
    const answers = await turns(fx, [OFF_TOPIC, OFF_TOPIC, OFF_TOPIC, OFF_TOPIC, AQUARIUM, OFF_TOPIC]);
    assert.equal(answers[4], "A modell válasza.");
    assert.equal(answers[5], PREFILTER_BLOCK_ANSWER);
  });

  it("an unclear message in the series neither extends nor ends it", async () => {
    const fx = fixture();
    const answers = await turns(fx, [OFF_TOPIC, OFF_TOPIC, "Szia!", OFF_TOPIC, OFF_TOPIC, OFF_TOPIC]);
    // The off-topic questions are the 1st, 2nd, 4th, 5th and 6th message: the series is 1, 2, then 3, 4, 5 (the unclear one is skipped).
    assert.equal(answers[3], PREFILTER_BLOCK_ANSWER);
    assert.equal(answers[4], PREFILTER_BLOCK_ANSWER);
    assert.equal(answers[5], PREFILTER_FIRM_BLOCK_ANSWER);
  });

  it("31: the series comes from the history, not from a stored field: a fresh conversation starts at one", async () => {
    const answers = await turns(fixture(), Array.from({ length: 5 }, () => OFF_TOPIC));
    assert.equal(answers[4], PREFILTER_FIRM_BLOCK_ANSWER);
    assert.equal(await turns(fixture(), [OFF_TOPIC]).then((a) => a[0]), PREFILTER_BLOCK_ANSWER);
  });

  it("the log line holds the series as a number and nothing of the text", async () => {
    const fx = fixture();
    await turns(fx, [OFF_TOPIC, OFF_TOPIC]);
    const lines = fx.lines.filter((l) => "prefilter" in (l as object)) as Array<{ offTopicSeries: number }>;
    assert.deepEqual(lines.map((l) => l.offTopicSeries), [1, 2]);
  });

  it("the firmer text holds no value, no lookup and no external service, like the others", () => {
    assert.equal(/\d|°/.test(PREFILTER_FIRM_BLOCK_ANSWER), false);
    assert.equal(/lekérdez|megnéz|utánanéz|keresek|keresünk/i.test(PREFILTER_FIRM_BLOCK_ANSWER), false);
    assert.equal(
      /időjárás|meteorol|weather|google|internet|böngész|keresőmotor|alkalmazás|szolgáltató|honlap|weboldal|térkép/i.test(PREFILTER_FIRM_BLOCK_ANSWER),
      false
    );
  });
});

describe("what the model is told about the offer (barracuda's review of #71)", () => {
  it("with the offer switch on, the model's instructions say what to answer to 'yes, please' and forbid inventing a contact", async () => {
    process.env[PREFILTER_ENV] = "true";
    process.env[COLLEAGUE_OFFER_ENV] = "true";
    const fx = fixture();
    await turns(fx, [AQUARIUM, AQUARIUM, AQUARIUM, AQUARIUM, "Igen, kérem."]);
    assert.equal(fx.instructionsSeen.length, 5);
    for (const seen of fx.instructionsSeen) assert.equal(seen.includes(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS), true);
  });

  it("with the offer switch off (the default, even with the gate on), the instructions are exactly what they were", async () => {
    process.env[PREFILTER_ENV] = "true";
    delete process.env[COLLEAGUE_OFFER_ENV];
    const fx = fixture();
    await turns(fx, [AQUARIUM, "Igen, kérem."]);
    for (const seen of fx.instructionsSeen) assert.equal(seen.includes(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS), false);
  });

  it("the instruction holds no number, no address and no contact of its own, and promises nothing", () => {
    assert.equal(/\d|@|http|www/i.test(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS.replace(/'yes, please'/, "")), false);
    assert.match(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS, /cannot put them in touch/);
    assert.match(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS, /Do not write any telephone number, e-mail address/);
    assert.match(COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS, /do not promise a callback/);
  });
});
