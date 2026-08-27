import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILD_TIME_ENV,
  buildTime,
  BUILD_VERSION_ENV,
  buildVersion,
  UNKNOWN_VERSION
} from "./build-version.js";

describe("buildVersion", () => {
  it("reports the sha the deploy set", () => {
    assert.equal(
      buildVersion({ [BUILD_VERSION_ENV]: "982a33ff51e438e4467a4a84ff51b265c915f292" }),
      "982a33ff51e438e4467a4a84ff51b265c915f292"
    );
    assert.equal(buildVersion({ [BUILD_VERSION_ENV]: "982a33f" }), "982a33f");
  });

  it("says unknown rather than guessing", () => {
    /**
     * A container started by hand has no sha, and the honest answer is that
     * we do not know which code is running. Anything else would make the
     * field worse than useless: it is here precisely to be trusted.
     */
    assert.equal(buildVersion({}), UNKNOWN_VERSION);
    assert.equal(buildVersion({ [BUILD_VERSION_ENV]: "   " }), UNKNOWN_VERSION);
  });

  it("refuses anything that is not a sha, because this value is echoed publicly", () => {
    /**
     * The health endpoint has no authentication, so whatever this variable
     * holds is readable by anyone who asks. Bounding it to sha characters
     * means a mistyped or repurposed deploy variable cannot turn into an
     * arbitrary string in a public response.
     */
    for (const bad of [
      "not-a-sha",
      "982a33ff; rm -rf /",
      "<script>alert(1)</script>",
      "982a33ff\nX-Injected: yes",
      "abc",
      "9".repeat(41)
    ]) {
      assert.equal(
        buildVersion({ [BUILD_VERSION_ENV]: bad }),
        UNKNOWN_VERSION,
        `accepted ${JSON.stringify(bad)}`
      );
    }
  });
});

describe("buildTime", () => {
  it("reports the moment the image was assembled", () => {
    // Both spellings, because `date -u +%Y-%m-%dT%H:%M:%SZ` writes the short
    // one and a rule that only took the long one would have answered
    // "unknown" for every real deploy.
    assert.equal(
      buildTime({ [BUILD_TIME_ENV]: "2026-08-27T08:41:03Z" }),
      "2026-08-27T08:41:03.000Z"
    );
    assert.equal(
      buildTime({ [BUILD_TIME_ENV]: "2026-08-27T08:41:03.000Z" }),
      "2026-08-27T08:41:03.000Z"
    );
  });

  it("says unknown rather than guessing", () => {
    /**
     * The case that made this field worth building. A value that is always
     * absent must still SAY it is absent: a field that is silently null is
     * indistinguishable from a field that was never added, and this morning
     * we spent a measurement on exactly that ambiguity on another service.
     */
    assert.equal(buildTime({}), UNKNOWN_VERSION);
    assert.equal(buildTime({ [BUILD_TIME_ENV]: "   " }), UNKNOWN_VERSION);
  });

  it("refuses anything that is not an ISO instant, because this is echoed publicly", () => {
    /**
     * `new Date()` accepts far more than ISO 8601, and whatever it accepts
     * would be handed back to any unauthenticated caller. The generous shapes
     * are the point of this test: each one parses, and none of them is a
     * timestamp a build produced.
     */
    for (const raw of [
      "December 2026",
      "2026-08-27",
      "2026-08-27T08:41:03+02:00",
      "now",
      "<script>alert(1)</script>",
      "2026-13-45T99:99:99Z"
    ]) {
      assert.equal(
        buildTime({ [BUILD_TIME_ENV]: raw }),
        UNKNOWN_VERSION,
        `must not report ${raw} as a build time`
      );
    }
  });
});
