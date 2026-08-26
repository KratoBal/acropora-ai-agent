import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIConnectionTimeoutError, APIError } from "openai";

import {
  aiProviderFailure,
  aiProviderLimits,
  createAiClient,
  isTimeoutFailure,
  OPENAI_MAX_RETRIES_ENV,
  OPENAI_TIMEOUT_MS_ENV
} from "./ai-provider.js";

describe("aiProviderLimits", () => {
  it("has a default that stays under the measured outer ceiling", () => {
    // The hop in front cuts at 30 000 ms. If this default ever creeps past it,
    // the timeout that fires stops being ours and the caller goes back to
    // receiving an unexplained 500.
    const limits = aiProviderLimits({});

    assert.equal(limits.timeoutMs, 25_000);
    assert.ok(limits.timeoutMs < 30_000);
  });

  it("does not retry by default", () => {
    // A retry multiplies the wall clock invisibly, and the hop in front knows
    // nothing about our retries.
    assert.equal(aiProviderLimits({}).maxRetries, 0);
  });

  it("takes both values from the environment", () => {
    const limits = aiProviderLimits({
      [OPENAI_TIMEOUT_MS_ENV]: "12000",
      [OPENAI_MAX_RETRIES_ENV]: "2"
    });

    assert.deepEqual(limits, { timeoutMs: 12_000, maxRetries: 2 });
  });

  it("falls back to the default rather than crashing on a bad value", () => {
    // A typo in an environment variable must not take the service down at
    // boot. The safe outcome is the documented default.
    for (const raw of ["", "   ", "abc", "-1", "1.5", "9999999", "NaN"]) {
      assert.equal(
        aiProviderLimits({ [OPENAI_TIMEOUT_MS_ENV]: raw }).timeoutMs,
        25_000,
        `"${raw}" should fall back`
      );
    }

    for (const raw of ["-1", "99", "two"]) {
      assert.equal(
        aiProviderLimits({ [OPENAI_MAX_RETRIES_ENV]: raw }).maxRetries,
        0,
        `"${raw}" should fall back`
      );
    }
  });

  it("accepts zero retries written out explicitly", () => {
    // "0" is falsy as a string check and easy to lose in a truthiness test.
    assert.equal(
      aiProviderLimits({ [OPENAI_MAX_RETRIES_ENV]: "0" }).maxRetries,
      0
    );
  });
});

describe("createAiClient", () => {
  it("hands both limits to the real client, not to a stand-in", () => {
    /**
     * The assertion reads the client back rather than the arguments.
     *
     * A test that built its own client would measure itself: it would stay
     * green while the real construction quietly went back to the SDK defaults
     * of ten minutes and two retries, which is the regression this whole
     * change exists to prevent.
     */
    const client = createAiClient(
      { timeoutMs: 12_345, maxRetries: 1 },
      { OPENAI_API_KEY: "test-key" }
    );

    assert.equal(client.timeout, 12_345);
    assert.equal(client.maxRetries, 1);
  });

  it("does not let the SDK defaults back in", () => {
    const client = createAiClient(aiProviderLimits({}), {
      OPENAI_API_KEY: "test-key"
    });

    assert.equal(client.timeout, 25_000);
    assert.notEqual(client.timeout, 600_000);
    assert.equal(client.maxRetries, 0);
    assert.notEqual(client.maxRetries, 2);
  });
});

describe("isTimeoutFailure", () => {
  it("recognises the SDK's own timeout", () => {
    assert.equal(isTimeoutFailure(new APIConnectionTimeoutError({})), true);
  });

  it("recognises an aborted signal reported through the cause", () => {
    const error = Object.assign(new Error("fetch failed"), {
      cause: { name: "TimeoutError" }
    });

    assert.equal(isTimeoutFailure(error), true);
  });

  it("recognises a transport layer that only says it in the message", () => {
    assert.equal(isTimeoutFailure(new Error("socket timed out")), true);
  });

  it("does not call every failure a timeout", () => {
    // The distinction is the point of the whole change: a provider error and a
    // timeout need different answers, and mislabelling either one puts the
    // caller back in front of a failure that explains nothing.
    for (const error of [
      new APIError(500, undefined, "Internal server error", undefined),
      new Error("Connection reset by peer"),
      { message: "rate limit reached" },
      undefined,
      "something"
    ]) {
      assert.equal(
        isTimeoutFailure(error),
        false,
        `${JSON.stringify(String(error))} is not a timeout`
      );
    }
  });
});

describe("aiProviderFailure", () => {
  it("answers a timeout with 504, its own code, and how long we waited", () => {
    const failure = aiProviderFailure(new APIConnectionTimeoutError({}), 25_004);

    assert.deepEqual(failure, {
      status: 504,
      body: { error: "ai_provider_timeout", waitedMs: 25_004 }
    });
  });

  it("answers any other failure with 502, and still says how long we waited", () => {
    const failure = aiProviderFailure(new Error("boom"), 412);

    assert.deepEqual(failure, {
      status: 502,
      body: { error: "ai_provider_error", waitedMs: 412 }
    });
  });

  it("keeps the two apart by status as well as by code", () => {
    const timedOut = aiProviderFailure(new Error("request timed out"), 1);
    const other = aiProviderFailure(new Error("nope"), 1);

    assert.notEqual(timedOut.status, other.status);
    assert.notEqual(timedOut.body.error, other.body.error);
  });

  it("carries nothing from the provider's error into the answer", () => {
    // The upstream message can quote our key back at us. The caller gets a
    // code and a duration; the log gets a redacted summary.
    const error = Object.assign(new Error("bad key sk-live-secret-value"), {
      status: 401,
      request: { headers: { authorization: "Bearer sk-live-secret-value" } }
    });

    const serialised = JSON.stringify(aiProviderFailure(error, 30));

    assert.equal(serialised.includes("sk-live"), false);
    assert.deepEqual(Object.keys(aiProviderFailure(error, 30).body).sort(), [
      "error",
      "waitedMs"
    ]);
  });
});
