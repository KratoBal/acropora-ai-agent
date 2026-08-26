import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEMA_SQL } from "./db.js";
import {
  ACCURACY_RATINGS,
  isRatingAxis,
  isRatingForAxis,
  LANGUAGE_RATINGS,
  RATING_AXES,
  RATINGS_BY_AXIS
} from "./evaluations.js";

/**
 * Each vocabulary exists twice and has to stay one thing.
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
describe("the rating vocabularies", () => {
  /**
   * The constraint names the axis next to its values, so the axis is read out
   * of the SQL rather than assumed. A test that only looked for the values
   * would pass even if both lists sat under the same axis.
   */
  const valuesInSchemaFor = (axis: string) => {
    const clause = SCHEMA_SQL.match(
      new RegExp(`axis = '${axis}'\\s*\\n?\\s*AND rating IN \\(([^)]*)\\)`)
    )?.[1];

    return [...(clause ?? "").matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
  };

  it("both axes are written into the schema", () => {
    assert.deepEqual(
      [...(SCHEMA_SQL.match(/axis IN \(([^)]*)\)/)?.[1] ?? "").matchAll(
        /'([^']+)'/g
      )]
        .map((match) => match[1])
        .sort(),
      [...RATING_AXES].sort()
    );
  });

  it("holds exactly the values the code accepts, per axis, in both directions", () => {
    for (const axis of RATING_AXES) {
      assert.deepEqual(
        valuesInSchemaFor(axis),
        [...RATINGS_BY_AXIS[axis]].sort(),
        `the ${axis} axis disagrees with the schema`
      );
    }
  });

  it("keeps the two vocabularies disjoint", () => {
    /**
     * If a value appeared on both axes, "which axis is this row about" would
     * stop being answerable from the value alone - and the split exists
     * precisely so that a wording judgement can never be counted as a fact.
     */
    const shared = ACCURACY_RATINGS.filter((value) =>
      (LANGUAGE_RATINGS as readonly string[]).includes(value)
    );

    assert.deepEqual(shared, []);
  });

  it("is the four judgements the surface offers on each axis", () => {
    assert.deepEqual(
      [...ACCURACY_RATINGS],
      ["correct", "inaccurate", "dangerous", "no-data"]
    );
    assert.deepEqual(
      [...LANGUAGE_RATINGS],
      ["natural", "wordy", "foreign", "confusing"]
    );
  });
});

describe("isRatingForAxis", () => {
  it("accepts what the surface sends on that axis", () => {
    for (const axis of RATING_AXES) {
      for (const value of RATINGS_BY_AXIS[axis]) {
        assert.equal(
          isRatingForAxis(axis, value),
          true,
          `rejected ${value} on ${axis}`
        );
      }
    }
  });

  it("refuses a value that belongs to the OTHER axis", () => {
    /**
     * The assertion the whole split rests on. `natural` is a real rating and
     * a valid one - just not about facts. A validator that pooled the eight
     * values would accept this, and the two lists would merge in the data
     * even though they never merged in the code.
     */
    assert.equal(isRatingForAxis("accuracy", "natural"), false);
    assert.equal(isRatingForAxis("accuracy", "confusing"), false);
    assert.equal(isRatingForAxis("language", "correct"), false);
    assert.equal(isRatingForAxis("language", "dangerous"), false);
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
        isRatingForAxis("accuracy", value),
        false,
        `accepted ${JSON.stringify(value)}`
      );
    }
  });
});

describe("isRatingAxis", () => {
  it("accepts the two axes and nothing else", () => {
    for (const axis of RATING_AXES) {
      assert.equal(isRatingAxis(axis), true);
    }

    for (const value of ["tone", "", "ACCURACY", null, undefined, 1, {}]) {
      assert.equal(
        isRatingAxis(value),
        false,
        `accepted ${JSON.stringify(value)}`
      );
    }
  });
});
