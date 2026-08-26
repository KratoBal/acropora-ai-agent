import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactSecrets, safeErrorSummary } from "./redact.js";

const environment: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: "sk-live-openai-key-value-0123456789",
  API_ACCESS_TOKEN: "api-access-token-value-0123456789",
  ACROPORA_OS_AI_SERVICE_TOKEN: "os-service-token-value-0123456789"
};

const secrets = Object.values(environment) as string[];

const containsAnySecret = (text: string) =>
  secrets.some((secret) => text.includes(secret));

describe("redactSecrets", () => {
  it("removes every configured secret, wherever it sits in the text", () => {
    for (const secret of secrets) {
      const text = `upstream said: ${secret} was rejected`;

      const redacted = redactSecrets(text, environment);

      assert.equal(redacted.includes(secret), false);
      assert.match(redacted, /\[redacted\]/);
      // The surrounding text survives, or the line stops being diagnostic.
      assert.match(redacted, /upstream said/);
      assert.match(redacted, /was rejected/);
    }
  });

  it("removes a key that is quoted back in a masked form", () => {
    // The exact-value pass cannot catch this: a masked key is not equal to the
    // configured value. It still reveals the prefix and the suffix.
    const text =
      "Incorrect API key provided: sk-live***6789. You can find your API key at ...";

    const redacted = redactSecrets(text, environment);

    assert.equal(redacted.includes("sk-live***6789"), false);
    assert.match(redacted, /Incorrect API key provided: \[redacted\]/);
  });

  it("removes a bearer credential quoted back in a message", () => {
    const redacted = redactSecrets(
      "request failed with Authorization: Bearer some-other-token",
      environment
    );

    assert.equal(redacted.includes("some-other-token"), false);
  });

  it("leaves a message with no secret in it untouched", () => {
    const text = "Connection reset by peer after 30000 ms";

    assert.equal(redactSecrets(text, environment), text);
  });

  it("ignores an unset or very short value rather than redacting everything", () => {
    // A one character "secret" would turn every line into markers, and it is
    // not a secret this pass can protect anyway.
    const text = "a normal sentence with the letter a in it";

    assert.equal(
      redactSecrets(text, { API_ACCESS_TOKEN: "a", OPENAI_API_KEY: "" }),
      text
    );
  });
});

describe("safeErrorSummary", () => {
  it("keeps the four diagnostic fields and drops everything else", () => {
    const error = Object.assign(new Error("rate limit reached"), {
      status: 429,
      code: "rate_limit_exceeded",
      type: "requests",
      // The field this whole change exists for: an SDK may attach the request
      // it failed on, and that request carries the key.
      request: { headers: { authorization: `Bearer ${environment.OPENAI_API_KEY}` } }
    });

    const summary = safeErrorSummary(error, environment);

    assert.deepEqual(summary, {
      message: "rate limit reached",
      status: 429,
      code: "rate_limit_exceeded",
      type: "requests"
    });
    assert.deepEqual(Object.keys(summary).sort(), [
      "code",
      "message",
      "status",
      "type"
    ]);
  });

  it("never carries a secret out, whatever the provider attached", () => {
    const attachments: unknown[] = [
      Object.assign(new Error(`bad key ${environment.OPENAI_API_KEY}`), {
        status: 401
      }),
      { message: `Bearer ${environment.API_ACCESS_TOKEN} rejected` },
      { message: "ok", code: environment.ACROPORA_OS_AI_SERVICE_TOKEN },
      `plain string with ${environment.OPENAI_API_KEY} inside`,
      new Error("Incorrect API key provided: sk-live***6789"),
      // The nested case, and the reason the summary is built field by field
      // rather than by spreading: a secret does not have to be in the message
      // to travel with the error.
      Object.assign(new Error("request failed"), {
        status: 401,
        request: {
          headers: { authorization: `Bearer ${environment.OPENAI_API_KEY}` }
        }
      })
    ];

    for (const error of attachments) {
      const serialised = JSON.stringify(safeErrorSummary(error, environment));

      assert.equal(
        containsAnySecret(serialised),
        false,
        `a secret survived: ${serialised}`
      );
      assert.equal(serialised.includes("sk-live"), false);
    }
  });

  it("still says something useful when the error is not an object", () => {
    assert.deepEqual(safeErrorSummary(undefined, environment), {
      message: "unknown error"
    });
    assert.deepEqual(safeErrorSummary("timed out", environment), {
      message: "timed out"
    });
  });

  it("omits the optional fields rather than sending empty ones", () => {
    const summary = safeErrorSummary(new Error("boom"), environment);

    assert.deepEqual(summary, { message: "boom" });
    assert.equal("status" in summary, false);
    assert.equal("code" in summary, false);
  });
});
