import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANSWER_ORDER_INSTRUCTIONS } from "./answer-order.js";
import { chatInstructions } from "./app.js";
import { GLOSSARY_INSTRUCTIONS } from "./glossary.js";
import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

/**
 * THE ANSWER ORDER IN EVERY BRANCH (t-20261116-ai-utasitas-hangolas). What turns this red: the order rule missing from
 * one product-context branch or customer mode (the empty-result and hit branches never had it), or the rule losing
 * its point (world first, the limit as one clause, never the opening line).
 */
describe("the answer order in the prompt", () => {
  it("is there in every product-context branch and in both customer modes", () => {
    const states = [
      NO_PRODUCT_CONTEXT_INSTRUCTIONS,
      EMPTY_RESULT_INSTRUCTIONS,
      SEARCH_UNAVAILABLE_INSTRUCTIONS,
      "<<<TERMEKADAT>>>\n[]\n<<<TERMEKADAT VEGE>>>"
    ];
    const resolutions: Parameters<typeof chatInstructions>[0][] = [
      { ok: true, mode: "anonymous" },
      {
        ok: true,
        mode: "customer",
        context: {
          subjectType: "customer",
          customerId: "cus_1",
          customerNumber: "V-00123",
          entitlements: {},
          entitlementsStatus: "not-modelled",
          entitlementsNote: "..."
        }
      }
    ];
    for (const productContext of states)
      for (const resolution of resolutions)
        assert.ok(chatInstructions(resolution, productContext).includes(ANSWER_ORDER_INSTRUCTIONS), resolution.mode);
  });

  it("says the world comes first and the limit is one clause, never the opening", () => {
    assert.match(ANSWER_ORDER_INSTRUCTIONS, /az első\s+mondat a kérdés tárgyáról szól/);
    assert.match(ANSWER_ORDER_INSTRUCTIONS, /EGY tagmondatban/);
    assert.match(ANSWER_ORDER_INSTRUCTIONS, /Soha ne ezzel nyiss/);
  });
});

describe("the glossary's two new rules (third stage run)", () => {
  it("a heading is an occurrence, and the aquarium type is not decoration", () => {
    assert.match(GLOSSARY_INSTRUCTIONS, /A CÍMSOR IS ELŐFORDULÁS/);
    assert.match(GLOSSARY_INSTRUCTIONS, /díszítésként, megszólításként/);
  });
});
