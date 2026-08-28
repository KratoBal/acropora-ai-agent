import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RATING_AXES } from "./evaluations.js";
import {
  PROBES,
  QUESTION_SET,
  QUESTION_SET_VERSION
} from "./question-set.js";

/**
 * What this file guards is not the WORDING of the questions - that is a
 * judgement call, and it belongs to whoever curates the set. It guards the
 * property that makes two runs comparable at all.
 *
 * THE ONE THAT MATTERS: every probe must appear in BOTH polarities. A set that
 * only asks questions where the rule should fire cannot tell a model that
 * follows the rule from one that applies it everywhere - and that failure has
 * already happened once here (six stage answers out of six opened with a stock
 * disclaimer on questions that never mentioned stock). A guard that only
 * counted questions would have called that set complete.
 */
describe("the pinned question set", () => {
  it("gives every probe both polarities", () => {
    for (const probe of PROBES) {
      const asked = QUESTION_SET.filter((entry) => entry.probe === probe);
      const applies = asked.filter((e) => e.polarity === "must-apply");
      const doesNot = asked.filter((e) => e.polarity === "must-not-apply");

      assert.ok(
        applies.length > 0,
        `${probe}: nincs olyan kérdés, ahol a szabálynak MŰKÖDNIE kell`
      );
      assert.ok(
        doesNot.length > 0,
        `${probe}: nincs olyan kérdés, ahol a szabálynak NEM SZABAD működnie. ` +
          `Enélkül a túlalkalmazás észrevétlen marad.`
      );
    }
  });

  it("keeps every id unique, because a run refers to the id and not the text", () => {
    const ids = QUESTION_SET.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("states a criterion for every question", () => {
    for (const entry of QUESTION_SET) {
      assert.ok(
        entry.criterion.trim().length >= 40,
        `${entry.id}: a mérce túl rövid ahhoz, hogy két olvasó ugyanarra jusson`
      );
      assert.ok(
        entry.question.trim().length > 0,
        `${entry.id}: üres kérdés`
      );
    }
  });

  /**
   * The set names the axis a failure would show up on, and it has to be one of
   * the axes the rating surface already has. A third name here would be a
   * second taxonomy, drifting silently from the first.
   */
  it("uses the rating axes that already exist", () => {
    for (const entry of QUESTION_SET) {
      assert.ok(
        (RATING_AXES as readonly string[]).includes(entry.axis),
        `${entry.id}: ismeretlen tengely (${entry.axis})`
      );
    }
  });

  it("carries a version, so a result can say what it was measured against", () => {
    assert.match(QUESTION_SET_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
