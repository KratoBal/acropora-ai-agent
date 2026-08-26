import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "./db.js";
import { isRatingValue, RATING_VALUES } from "./evaluations.js";

/**
 * The rating vocabulary exists twice and has to stay one thing.
 *
 * Once as a CHECK constraint the database enforces, once as a TypeScript
 * union the route validates against. Neither can be dropped: without the
 * constraint a bug writes nonsense that later gets counted, without the union
 * a bad request reaches the database and comes back as a violation instead of
 * a 400.
 *
 * What can be dropped is the agreement between them, and that failure is the
 * quiet kind - it surfaces in production the first time somebody presses the
 * button that was added on only one side.
 */
describe("the rating vocabulary", () => {
  const checkConstraint = SCHEMA_SQL.match(
    /rating IN \(([^)]*)\)/
  )?.[1];

  it("is written into the schema", () => {
    assert.ok(
      checkConstraint,
      "the answer_ratings table has no CHECK on rating"
    );
  });

  it("holds exactly the values the code accepts, in both directions", () => {
    const inSchema = [...(checkConstraint ?? "").matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .sort();

    assert.deepEqual(inSchema, [...RATING_VALUES].sort());
  });

  it("is the four judgements the surface offers", () => {
    // Balazs's wording, and the keys the web surface already uses.
    assert.deepEqual(
      [...RATING_VALUES],
      ["correct", "inaccurate", "dangerous", "no-data"]
    );
  });
});

describe("isRatingValue", () => {
  it("accepts what the surface sends", () => {
    for (const value of RATING_VALUES) {
      assert.equal(isRatingValue(value), true, `rejected ${value}`);
    }
  });

  it("refuses anything else, including the shapes a caller sends by accident", () => {
    for (const value of [
      "excellent",
      "",
      " correct",
      "CORRECT",
      null,
      undefined,
      1,
      ["correct"],
      { rating: "correct" }
    ]) {
      assert.equal(
        isRatingValue(value),
        false,
        `accepted ${JSON.stringify(value)}`
      );
    }
  });
});
