import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import {
  AUTHORITY_TOPIC,
  LINK_GUARD_FALLBACK,
  LINK_REQUEST,
  LINK_RULE_ENV,
  LINK_RULE_INSTRUCTIONS,
  SPELLED_SEPARATOR_STOPWORDS,
  findLinks,
  guardAnswerLinks,
  linkRuleMode,
  type LinkGuardInput,
  type StoredLinkSource
} from "./answer-link-guard.js";
import { buildApp, chatInstructions, type AppDependencies, type ConversationStore } from "./app.js";
import { IANA_TLDS, IANA_TLD_SNAPSHOT } from "./iana-tlds.js";
import type { ProductSearchOutcome } from "./product-search.js";
import {
  PREFILTER_ASK_ANSWER,
  PREFILTER_BLOCK_ANSWER,
  PREFILTER_ENV,
  PREFILTER_MODEL_LABEL
} from "./request-prefilter-answers.js";
import { PREFILTER_FIRM_BLOCK_ANSWER } from "./request-prefilter-turns.js";

/**
 * THE ANSWER'S LINKS (Acropora OS card 9d060f5c; plan v3, matrix 5.2). WHAT
 * TURNS IT RED: an external host leaves under a disguise (no scheme, bracketed,
 * spelled out, IDN, an IP, userinfo before our name, our name as a prefix or a
 * suffix); ordinary text (a pH value, a file, a product line) is taken for an
 * address; an exception lets a host through without its own condition (the
 * brand of a hit for K2, the topic for K3); the route sends a link under
 * `enforce` or changes anything under `off`.
 */
const noSearch = { ok: false, error: "not_configured", detail: "" } as unknown as ProductSearchOutcome;
const hitsOf = (...brands: (string | null)[]): ProductSearchOutcome =>
  ({ ok: true, result: { hits: brands.map((brand, i) => ({ productId: `p${i}`, brand })) } }) as ProductSearchOutcome;

const guard = (answer: string, extra: Partial<LinkGuardInput> = {}) =>
  guardAnswerLinks({ answer, userMessage: "Mit javasolsz?", outcome: noSearch, sources: [], ...extra });

const manufacturer: StoredLinkSource = {
  host: "redseafish.com",
  category: "MANUFACTURER_DOCUMENT",
  brand: "Red Sea",
  note: "gyártói adatlapok"
};
const authority: StoredLinkSource = { host: "nebih.gov.hu", category: "AUTHORITY", brand: null };

describe("the IANA TLD snapshot", () => {
  it("is loaded, dated and holds more than a thousand TLDs, IDN ones in punycode", () => {
    assert.ok(IANA_TLDS.size > 1000, String(IANA_TLDS.size));
    assert.match(IANA_TLD_SNAPSHOT.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const tld of ["com", "hu", "ca", "zip", "mov", "xn--p1ai"]) assert.ok(IANA_TLDS.has(tld), tld);
    for (const word of ["pdf", "light", "y", "12", "stb"]) assert.ok(!IANA_TLDS.has(word), word);
    assert.ok([...IANA_TLDS].every((tld) => /^[a-z0-9-]+$/.test(tld)));
  });
});

describe("the AI_LINK_RULE switch", () => {
  it("is `log` or `enforce` only exactly so; anything else is `off`", () => {
    assert.equal(linkRuleMode({ [LINK_RULE_ENV]: "log" }), "log");
    assert.equal(linkRuleMode({ [LINK_RULE_ENV]: "enforce" }), "enforce");
    for (const value of [undefined, "", "off", "LOG", "Enforce", " log", "true", "1"])
      assert.equal(linkRuleMode({ [LINK_RULE_ENV]: value }), "off", JSON.stringify(value));
  });
});

describe("matrix 5.2: what the gate reads as an address", () => {
  it("row 1: an answer with no address passes", () => {
    assert.deepEqual(guard("Előbb mérd a KH-t, utána adagolj."), {
      ok: true,
      reason: null,
      hosts: [],
      allowedByException: 0,
      ownLinks: 0,
      ownProductPathLinks: 0
    });
  });

  it("row 2: our own domain passes and is counted apart", () => {
    const result = guard("Itt: https://shop.acropora.hu/x és https://acropora.hu");
    assert.deepEqual([result.ok, result.ownLinks, result.hosts], [true, 2, []]);
  });

  it("row 3: an external URL is EXTERNAL_LINK, with the host and not the URL", () => {
    const result = guard("Nézd meg: https://www.reefsupplies.ca/x?ref=valaki");
    assert.deepEqual([result.ok, result.reason, result.hosts], [false, "EXTERNAL_LINK", ["www.reefsupplies.ca"]]);
  });

  it("row 4: no scheme is no way out (`//`, `www.`, a bare domain on a real TLD)", () => {
    for (const [answer, host] of [
      ["Lásd //evil.com/x itt.", "evil.com"],
      ["Lásd www.evil.com oldalt.", "www.evil.com"],
      ["Lásd a reefsupplies.ca oldalt.", "reefsupplies.ca"],
      // a Hungarian case ending after a hyphen is grammar, not a label
      ["Rendeld a reefsupplies.ca-n.", "reefsupplies.ca"],
      ["Írj az info@redsea.com címre.", "redsea.com"]
    ] as const)
      assert.deepEqual(guard(answer).hosts, [host], answer);
  });

  it("row 5: a markdown and an HTML link", () => {
    assert.deepEqual(guard("[itt](https://x.com)").hosts, ["x.com"]);
    assert.deepEqual(guard('<a href="https://x.com">itt</a>').hosts, ["x.com"]);
  });

  it("row 6: an IP is never ours", () => {
    assert.deepEqual(guard("http://203.0.113.5/x").hosts, ["203.0.113.5"]);
    assert.deepEqual(guard("http://[2001:db8::1]/").hosts, ["2001:db8::1"]);
    assert.deepEqual(guard("Szerver: 203.0.113.5 és [2001:db8::1]").hosts, ["2001:db8::1", "203.0.113.5"]);
  });

  // CALIBRATED: `endsWith("acropora.hu")` with no label boundary turns this red
  it("row 7: our name as a prefix, a suffix or userinfo is not our domain", () => {
    for (const [answer, host] of [
      ["Lásd acropora.hu.evil.com oldalt.", "acropora.hu.evil.com"],
      ["Lásd evil-acropora.hu oldalt.", "evil-acropora.hu"],
      ["Lásd https://shop.acropora.hu@evil.com/ oldalt.", "evil.com"]
    ] as const) {
      const result = guard(answer);
      assert.deepEqual([result.ok, result.hosts, result.ownLinks], [false, [host], 0], answer);
    }
  });

  // CALIBRATED: comparing the host as written, without normalising, turns this red
  it("row 8: an IDN look-alike and an undecodable punycode label are not our domain", () => {
    for (const [answer, host] of [
      ["Lásd ácropora.hu oldalt.", "xn--cropora-gwa.hu"],
      ["Lásd https://ácropora.hu/x oldalt.", "xn--cropora-gwa.hu"],
      ["Lásd xn--cropora-gwa.hu oldalt.", "xn--cropora-gwa.hu"],
      ["Lásd xn--cropora-2wa.hu oldalt.", "xn--cropora-2wa.hu"]
    ] as const) {
      const result = guard(answer);
      assert.deepEqual([result.ok, result.hosts], [false, [host]], answer);
    }
  });

  it("row 9: a port, a trailing dot, upper case and brackets do not hide our domain", () => {
    for (const answer of [
      "Lásd shop.acropora.hu:8080/x oldalt.",
      "Lásd acropora.hu. Ott minden van.",
      "Itt van (HTTPS://Shop.Acropora.hu/x).",
      "Lásd az acropora.hu-n."
    ]) {
      const result = guard(answer);
      assert.deepEqual([result.ok, result.ownLinks], [true, 1], answer);
    }
  });

  it("row 10: a bracketed or spelled-out dot", () => {
    for (const answer of ["evil[.]com", "evil(.)com", "evil{.}com", "evil [.] co [.] uk", "evil pont com", "evil dot com", "evil (pont) com"])
      assert.equal(guard(`Lásd ${answer} oldalt.`).ok, false, answer);
  });

  // CALIBRATED: reading any "letters after a dot" as a domain turns this red
  it("row 11: ordinary text is not an address", () => {
    for (const answer of [
      "A pH 8.2 legyen, a dKH 7.5.",
      "Adj 1.5 ml-t belőle.",
      "Az ICP-OES mérés pontos.",
      "A Red Sea Coral Pro só jó választás.",
      "A Balling.Light készlet is jó.",
      "Benne van a manual.pdf fájlban.",
      "A cikkszáma AB.12.",
      "Az x.y alak nem cím.",
      "A kezelesi.zip csomagban van.",
      "Pl. a kalcium, stb. is számít.",
      "Írj e-mailt nekünk.",
      // "pont" and "dot" as words, before a word that is also a TLD
      "Ez pont az, amit kerestél.",
      "Pont ma érkezett meg.",
      "Ez pont is jó.",
      "Ez pont jó és pont ott van.",
      "Pont mint a múltkor.",
      "The white dot is harmless.",
      "Ebben az időpontban hu, de ez nem cím.",
      "Kérlek, nézd meg a szempontokat."
    ])
      assert.deepEqual(findLinks(answer), [], answer);
  });

  it("the spelled-out stopwords are all TLDs, so each one is a decision, not a leftover", () => {
    for (const word of SPELLED_SEPARATOR_STOPWORDS) assert.ok(IANA_TLDS.has(word), word);
  });

  it("row 12: the UNAS platform domains are not ours (acrobot 46815)", () => {
    for (const answer of ["https://acropora.unas.hu/x", "https://shop.unas.hu/x"])
      assert.equal(guard(answer).reason, "EXTERNAL_LINK", answer);
  });
});

describe("matrix 5.2: the three exceptions, each with its own condition", () => {
  it("row 13: K1 asked, but the list is empty: EXCEPTION_WITHOUT_STORED_SOURCE", () => {
    const result = guard("https://redseafish.com/manual", { userMessage: "Küldj linket a gyártóhoz!" });
    assert.deepEqual([result.ok, result.reason], [false, "EXCEPTION_WITHOUT_STORED_SOURCE"]);
  });

  it("row 14: K1 asked, and the host is on the list (any category)", () => {
    for (const source of [manufacturer, authority]) {
      const result = guard(`https://${source.host}/x`, {
        userMessage: "Van erről forrás, ahol olvashatok?",
        sources: [source]
      });
      assert.deepEqual([result.ok, result.allowedByException], [true, 1], source.host);
    }
  });

  it("row 15: a listed host with neither K1, K2 nor K3", () => {
    for (const source of [manufacturer, authority]) {
      const result = guard(`https://${source.host}/x`, { userMessage: "Mit etessek?", sources: [source] });
      assert.deepEqual([result.ok, result.reason], [false, "EXTERNAL_LINK"], source.host);
    }
  });

  it("row 16: K2, a manufacturer document of the brand of a hit, unasked", () => {
    const result = guard("A gyártó adatlapja: https://redseafish.com/coral-pro.pdf", {
      userMessage: "Mennyi a Coral Pro sótartalma?",
      outcome: hitsOf("Tropic Marin", "RED SEA"),
      sources: [manufacturer]
    });
    assert.deepEqual([result.ok, result.allowedByException], [true, 1]);
  });

  // CALIBRATED: dropping the brand binding turns this red
  it("row 17: K2 is false with another brand among the hits, with no hits, and with no brand on the entry", () => {
    for (const [outcome, source] of [
      [hitsOf("Tropic Marin"), manufacturer],
      [hitsOf(), manufacturer],
      [noSearch, manufacturer],
      [hitsOf("Red Sea"), { ...manufacturer, brand: null }]
    ] as const) {
      const result = guard("https://redseafish.com/x", { userMessage: "Mennyi a sótartalma?", outcome, sources: [source] });
      assert.deepEqual([result.ok, result.reason], [false, "EXTERNAL_LINK"]);
    }
  });

  it("row 18: K3, an authority host on a warranty question", () => {
    for (const userMessage of ["Mi a garancia erre?", "Kell CITES engedély a korallhoz?", "Veszélyes ez a szer?"]) {
      const result = guard("https://nebih.gov.hu/x", { userMessage, sources: [authority] });
      assert.equal(result.ok, true, userMessage);
    }
  });

  // CALIBRATED: dropping the topic condition turns this red
  it("row 19: K3 is false on a feeding question", () => {
    const result = guard("https://nebih.gov.hu/x", { userMessage: "Mit etessek a halaknak?", sources: [authority] });
    assert.deepEqual([result.ok, result.reason], [false, "EXTERNAL_LINK"]);
  });

  it("a K3 topic over an empty list says the exception had no stored source", () => {
    const result = guard("https://nebih.gov.hu/x", { userMessage: "Mi a jótállás?" });
    assert.equal(result.reason, "EXCEPTION_WITHOUT_STORED_SOURCE");
  });

  it("the word lists read what they say, and not a near word", () => {
    for (const message of ["kuldj linket", "mi az url-je", "van forrasod", "melyik weboldal", "a honlapjuk", "hol olvashatok errol"])
      assert.ok(LINK_REQUEST.test(message), message);
    for (const message of ["kitoltottem az urlapot", "forrasztas kell", "mit etessek"])
      assert.ok(!LINK_REQUEST.test(message), message);
    for (const message of ["garancia", "jotallas", "szavatossag", "jogi kerdes", "torveny", "hatosag", "engedely", "cites", "biztonsagi adatlap", "veszelyes", "mergezo"])
      assert.ok(AUTHORITY_TOPIC.test(message), message);
    for (const message of ["mit etessek", "joghurt", "mennyi a kh"]) assert.ok(!AUTHORITY_TOPIC.test(message), message);
  });

  it("the hosts are unique and at most ten; the own-product path is counted (plan 5.4)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://h${i}.com/x https://h${i}.com/y`).join(" ");
    assert.equal(guard(many).hosts.length, 10);
    const own = guard("https://acropora.hu/termek/x https://shop.acropora.hu/spd/y https://acropora.hu/blog/z");
    assert.deepEqual([own.ownLinks, own.ownProductPathLinks], [3, 2]);
  });
});

describe("matrix 5.2 row 22: the pre-filter's local answers hold no address and no service", () => {
  it("none of the three local texts is read as an address or names a service", () => {
    for (const text of [PREFILTER_BLOCK_ANSWER, PREFILTER_ASK_ANSWER, PREFILTER_FIRM_BLOCK_ANSWER]) {
      assert.deepEqual(findLinks(text), [], text);
      assert.doesNotMatch(text, /google|bing|facebook|youtube|wiki|idokep|koponyeg|met\.hu|kereso|weboldal|honlap/i);
    }
  });
});

describe("the chat route: the link gate behind AI_LINK_RULE", () => {
  const API_TOKEN = "link-guard-teszt-kulcs";
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
    delete process.env[LINK_RULE_ENV];
    delete process.env[PREFILTER_ENV];
  });

  const run = async (modelText: string, message = "Hol vehetek sót?") => {
    const saved: string[] = [];
    const instructions: string[] = [];
    let modelCalls = 0;
    const store = {
      createConversation: async () => "6f1d0a2c-1b7e-4a3f-9c2d-8b5e4f7a1c30",
      conversationBelongsToClient: async () => true,
      saveMessage: async (input: { role: string; content: string }) => {
        if (input.role === "assistant") saved.push(input.content);
        return "b2c4d6e8-0a1b-4c3d-8e5f-9a7b6c5d4e3f";
      },
      setMessageOutcome: async () => {},
      getConversationMessages: async () => [{ role: "user", content: message }]
    } as unknown as ConversationStore;
    const openai = {
      responses: {
        create: async (request: { instructions: string }) => {
          modelCalls++;
          instructions.push(request.instructions);
          return { output_text: modelText };
        }
      }
    } as unknown as NonNullable<AppDependencies["openai"]>;
    const app = buildApp({ conversations: store, openai });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat",
        headers: { authorization: `Bearer ${API_TOKEN}` },
        payload: { message }
      });
      return {
        body: response.json() as { answer: string; model: string; linkGuard: Record<string, unknown> | null },
        saved,
        instructions,
        modelCalls
      };
    } finally {
      await app.close();
    }
  };
  const external = "A legjobb ár itt: https://www.reefsupplies.ca/salt?q=a+vevo+szavai";

  it("row 20: `off` (the default) runs nothing: the answer as it was, no gate data", async () => {
    const { body, saved } = await run(external);
    assert.deepEqual([body.answer, body.linkGuard, saved], [external, null, [external]]);
  });

  it("`log` leaves the answer and reports the reason and the host, never the URL", async () => {
    process.env[LINK_RULE_ENV] = "log";
    const { body, saved } = await run(external);
    assert.deepEqual([body.answer, saved], [external, [external]]);
    assert.deepEqual(body.linkGuard, {
      mode: "log",
      reason: "EXTERNAL_LINK",
      hosts: ["www.reefsupplies.ca"],
      ownLinks: 0,
      ownProductPathLinks: 0
    });
    assert.doesNotMatch(JSON.stringify(body.linkGuard), /salt|vevo/);
  });

  it("`enforce` replaces the whole answer with the fixed sentence, and that is what is stored", async () => {
    process.env[LINK_RULE_ENV] = "enforce";
    const { body, saved } = await run(external);
    assert.deepEqual([body.answer, saved], [LINK_GUARD_FALLBACK, [LINK_GUARD_FALLBACK]]);
    assert.equal(body.linkGuard?.reason, "EXTERNAL_LINK");
  });

  it("`enforce` leaves an answer with only our own link", async () => {
    process.env[LINK_RULE_ENV] = "enforce";
    const own = "Nálunk: https://shop.acropora.hu/termek/so";
    const { body } = await run(own);
    assert.equal(body.answer, own);
    assert.deepEqual([body.linkGuard?.reason, body.linkGuard?.ownLinks, body.linkGuard?.ownProductPathLinks], [null, 1, 1]);
  });

  it("row 21: the instruction (R1) is absent under `off` and present under `log` and `enforce`", async () => {
    assert.ok(!(await run("Szia.")).instructions[0]!.includes(LINK_RULE_INSTRUCTIONS));
    for (const mode of ["log", "enforce"]) {
      process.env[LINK_RULE_ENV] = mode;
      assert.ok((await run("Szia.")).instructions[0]!.includes(LINK_RULE_INSTRUCTIONS), mode);
    }
    const resolution = { ok: true, mode: "anonymous" } as unknown as Parameters<typeof chatInstructions>[0];
    assert.equal(chatInstructions(resolution, "X"), chatInstructions(resolution, "X", { linkRule: "off" }));
  });

  it("row 23: the weather question gets a local answer, no model call, no address", async () => {
    process.env[PREFILTER_ENV] = "true";
    process.env[LINK_RULE_ENV] = "enforce";
    const { body, modelCalls } = await run("https://idokep.hu", "Milyen idő lesz holnap?");
    assert.equal(modelCalls, 0);
    assert.equal(body.model, PREFILTER_MODEL_LABEL);
    assert.equal(body.linkGuard, null);
    assert.deepEqual(findLinks(body.answer), []);
  });
});
