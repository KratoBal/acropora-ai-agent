import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
