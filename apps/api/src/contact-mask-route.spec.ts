import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { buildApp, type AppDependencies, type AppLogger, type ConversationStore } from "./app.js";
import { CONTACT_PLACEHOLDER, MASK_CONTACTS_ENV } from "./contact-mask.js";

/*
  THE MODEL'S INPUT HAS NO CONTACT DATA (matrix S11 of the slice 4 plan; barracuda point 2; acrobot 46739): the real `/v1/chat` with a
  fake store and a fake model that records what it was handed. The messages are PASS decisions (they hold a topic word), the history
  carries a contact from an earlier turn, and the stored rows stay as they were typed.
*/
const API_TOKEN = "contact-mask-teszt-kulcs";
const CONVERSATION = "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c31";

type Stored = { id: string; role: "user" | "assistant" | "system"; content: string; model?: string };

function fixture(seed: Stored[] = []) {
  const messages: Stored[] = [...seed];
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
    setMessageOutcome: async () => undefined,
    getConversationMessages: async () => messages.slice(-20).map(({ role, content }) => ({ role, content }))
  } as unknown as ConversationStore;
  const inputs: Array<Array<{ role: string; content: string }>> = [];
  const openai = {
    responses: {
      create: async (args: { input: Array<{ role: string; content: string }> }) => {
        inputs.push(args.input);
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
  return { store, openai, logger, messages, inputs, lines };
}

const saved = { ...process.env };
before(() => {
  process.env.NODE_ENV = "test";
  process.env.API_ACCESS_TOKEN = API_TOKEN;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ACROPORA_OS_BASE_URL;
  delete process.env.AI_CHAT_PREFILTER;
});
after(() => {
  process.env = saved;
});
beforeEach(() => {
  delete process.env[MASK_CONTACTS_ENV];
});
afterEach(() => {
  delete process.env[MASK_CONTACTS_ENV];
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

const EMAIL = "kovacs.janos@example.hu";
const PHONE = "+36 30 123 4567";
const joined = (input: Array<{ content: string }>) => input.map((m) => m.content).join("\n");

describe("the model input holds no e-mail address or telephone number", () => {
  it("S11: the CURRENT message: a topic message with a contact goes to the model with the contact replaced", async () => {
    const fx = fixture();
    const { status } = await ask(fx, `Milyen korallokat ajánlasz az akváriumomba? Hívjon: ${PHONE}, vagy írjon ${EMAIL}.`);
    assert.equal(status, 200);
    const seen = joined(fx.inputs[0]!);
    assert.equal(seen.includes("123 4567"), false);
    assert.equal(seen.includes("example.hu"), false);
    assert.equal(seen.includes("kovacs"), false);
    assert.equal(seen.includes(CONTACT_PLACEHOLDER), true);
    assert.equal(seen.includes("Milyen korallokat ajánlasz az akváriumomba?"), true, "the rest of the question is untouched");
  });

  it("S11: the HISTORY too: a contact typed turns ago is not sent again on the next turns", async () => {
    const fx = fixture([
      { id: "m1", role: "user", content: `Az akváriumom miatt keresem: ${EMAIL}` },
      { id: "m2", role: "assistant", content: "Köszönöm, miben segíthetek az akváriumról?" },
      { id: "m3", role: "user", content: `Telefonszámom 06-20/987-6543, a koralloknál tartunk.` },
      { id: "m4", role: "assistant", content: "Értem." }
    ]);
    await ask(fx, "Milyen világítás kell a korallokhoz?", CONVERSATION);
    const seen = joined(fx.inputs[0]!);
    for (const raw of ["example.hu", "kovacs", "987", "6543", "06-20"]) assert.equal(seen.includes(raw), false, raw);
    assert.equal(fx.inputs[0]!.length, 5, "every message of the history still goes, only the contact is replaced");
  });

  it("the stored rows are NOT changed here: the user's message is saved as typed", async () => {
    const fx = fixture();
    await ask(fx, `Az akváriumom miatt: ${EMAIL}`);
    assert.equal(fx.messages[0]!.content, `Az akváriumom miatt: ${EMAIL}`);
  });

  it("an order number or a price in a question is NOT masked (the narrow pattern)", async () => {
    const fx = fixture();
    await ask(fx, "A rendelésem száma 1234567890, 120 000 Ft volt, mikor érkezik meg a szállítás?");
    assert.equal(joined(fx.inputs[0]!).includes("1234567890"), true);
    assert.equal(joined(fx.inputs[0]!).includes("120 000 Ft"), true);
    assert.equal(joined(fx.inputs[0]!).includes(CONTACT_PLACEHOLDER), false);
  });

  it("the log carries only the NUMBER of replacements, never a fragment of the contact", async () => {
    const fx = fixture();
    await ask(fx, `Akvárium: ${PHONE} és ${EMAIL}`);
    const line = fx.lines.find((l) => "maskedContacts" in (l as object)) as { maskedContacts: number };
    assert.equal(line.maskedContacts, 2);
    const own = fx.lines.filter((l) => !("req" in (l as object)) && !("res" in (l as object)));
    for (const raw of ["123 4567", "example.hu", "kovacs"]) assert.equal(JSON.stringify(own).includes(raw), false, raw);
  });

  it("without a contact nothing is logged and the input is exactly the history", async () => {
    const fx = fixture();
    await ask(fx, "Milyen korallokat ajánlasz az akváriumomba?");
    assert.deepEqual(fx.inputs[0], [{ role: "user", content: "Milyen korallokat ajánlasz az akváriumomba?" }]);
    assert.equal(fx.lines.some((l) => "maskedContacts" in (l as object)), false);
  });

  it("exactly `false` switches the masking off (the raw history goes, as before); any other value leaves it on", async () => {
    process.env[MASK_CONTACTS_ENV] = "false";
    const off = fixture();
    await ask(off, `Akvárium: ${EMAIL}`);
    assert.equal(joined(off.inputs[0]!).includes(EMAIL), true);

    for (const value of ["", "FALSE", "0"]) {
      process.env[MASK_CONTACTS_ENV] = value;
      const on = fixture();
      await ask(on, `Akvárium: ${EMAIL}`);
      assert.equal(joined(on.inputs[0]!).includes(EMAIL), false, JSON.stringify(value));
    }
  });

  it("the masking comes BEFORE the call and also with the pre-filter on (a pass decision still goes masked)", async () => {
    process.env.AI_CHAT_PREFILTER = "true";
    try {
      const fx = fixture();
      await ask(fx, `Milyen korall kell az akváriumomba? ${EMAIL}`);
      assert.equal(fx.inputs.length, 1);
      assert.equal(joined(fx.inputs[0]!).includes("example.hu"), false);
    } finally {
      delete process.env.AI_CHAT_PREFILTER;
    }
  });
});
