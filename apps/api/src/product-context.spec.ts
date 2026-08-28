import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  PRODUCT_CONTEXT_CLOSE,
  PRODUCT_CONTEXT_OPEN,
  productContextInstructions,
  SEARCH_UNAVAILABLE_INSTRUCTIONS
} from "./product-context.js";

const withHits = {
  ok: true as const,
  result: {
    projectionVersion: 1,
    hits: [
      {
        name: "Fauna Marin Balling Light",
        price: {
          net: 10000,
          gross: 12700,
          currency: "HUF",
          source: "unas",
          at: "2026-08-27T06:00:00.000Z"
        },
        stock: {
          quantity: 4,
          source: "unas",
          at: "2026-08-20T09:00:00.000Z"
        },
        descriptionSource: "acropora"
      }
    ]
  }
};

describe("what the model is told about the catalogue", () => {
  /**
   * THE REQUIREMENT OF THIS CHANGE, and the only test here that would catch a
   * half-done wiring. The two texts live in the same `join`, so shipping the
   * search without replacing the clause would put both in front of the model:
   * a catalogue it can read, and a sentence saying it has none.
   */
  it("drops the no-catalogue clause once there is a catalogue", () => {
    const instructions = productContextInstructions(withHits);

    assert.equal(
      instructions.includes(NO_PRODUCT_CONTEXT_INSTRUCTIONS),
      false,
      "a modell nem kaphat termékadatot ÉS azt az utasítást is, hogy nincs neki"
    );
    assert.ok(instructions.includes(PRODUCT_CONTEXT_OPEN));
    assert.ok(instructions.includes(PRODUCT_CONTEXT_CLOSE));
  });

  /**
   * "We looked and found nothing" and "we could not look" are different
   * claims: the first is about our range, the second about our systems. The
   * search module keeps them apart; flattening them here would undo that at
   * the last step, and the model would confidently say we carry nothing.
   */
  it("says something different for an empty result than for an outage", () => {
    const empty = productContextInstructions({
      ok: true,
      result: { hits: [] }
    });
    const outage = productContextInstructions({
      ok: false,
      error: "product_search_unavailable",
      detail: "timeout"
    });

    assert.equal(empty, EMPTY_RESULT_INSTRUCTIONS);
    assert.equal(outage, SEARCH_UNAVAILABLE_INSTRUCTIONS);
    assert.notEqual(empty, outage);

    assert.match(empty, /nem találtunk/i);
    assert.match(outage, /üzemzavar/i);
    assert.equal(
      outage.includes("NEM TALÁLTUNK"),
      false,
      "egy kimaradás nem mondhatja azt, hogy nincs ilyen termékünk"
    );
  });

  /** Not configured is not an outage: nothing is broken, nothing was set up. */
  it("falls back to the original clause when no search is configured", () => {
    const instructions = productContextInstructions({
      ok: false,
      error: "product_search_not_configured",
      detail: "ACROPORA_OS_BASE_URL is not set"
    });

    assert.equal(instructions, NO_PRODUCT_CONTEXT_INSTRUCTIONS);
  });

  /**
   * The projection travels through unchanged. Restating the price in prose
   * here would be the second copy that drifts - and the price and the stock
   * are exactly the two values that drift first.
   */
  it("passes the projection through verbatim, price and stock included", () => {
    const instructions = productContextInstructions(withHits);
    const block = instructions.slice(
      instructions.indexOf(PRODUCT_CONTEXT_OPEN) + PRODUCT_CONTEXT_OPEN.length,
      instructions.indexOf(PRODUCT_CONTEXT_CLOSE)
    );

    assert.deepEqual(JSON.parse(block), withHits.result);
  });

  it("treats a projection it cannot read as no hits, rather than throwing", () => {
    assert.equal(
      productContextInstructions({ ok: true, result: null }),
      EMPTY_RESULT_INSTRUCTIONS
    );
    assert.equal(
      productContextInstructions({ ok: true, result: { hits: "no" } }),
      EMPTY_RESULT_INSTRUCTIONS
    );
  });

  /**
   * The offer limits survive the wiring. Having the catalogue changes what the
   * model can SEE, not what it may recommend.
   */
  it("keeps the no-recommendation rule even with a catalogue in hand", () => {
    const instructions = productContextInstructions(withHits);

    assert.match(instructions, /ajánlasz megvételre/i);
    assert.match(instructions, /Ami NINCS a blokkban/);
  });
});
