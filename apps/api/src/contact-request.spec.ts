import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTACT_REQUEST_PATH,
  CONTACT_REQUEST_TOKEN_ENV,
  contactRequestConfig,
  handOverContact
} from "./contact-request.js";

/*
  THE HAND-OVER CLIENT (slice 4c). WHAT TURNS IT RED: a success reported without the OS's `recorded: true`; a refusal or a failure
  reported as a success; the contact value or the token in an error detail; a body the OS did not promise accepted; a call to the
  wrong path or without its own token; a throw instead of a reported failure.
*/
const VALUE = "06301234567";
const handOver = { channel: "PHONE" as const, value: VALUE, conversationRef: "conv-1", requestKey: "msg-1" };
const config = { baseUrl: "http://os.invalid", token: "contact-token" };
const receipt = { id: "req-1", recorded: true, duplicate: false, notified: true };

const answering = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("contactRequestConfig", () => {
  it("needs the base URL and its OWN token; the settings reader's token is not it", () => {
    assert.deepEqual(
      contactRequestConfig({ ACROPORA_OS_BASE_URL: "http://os.invalid/", [CONTACT_REQUEST_TOKEN_ENV]: " t " }),
      { baseUrl: "http://os.invalid", token: "t" }
    );
    assert.equal(contactRequestConfig({ ACROPORA_OS_BASE_URL: "http://os.invalid" }), null);
    assert.equal(
      contactRequestConfig({
        ACROPORA_OS_BASE_URL: "http://os.invalid",
        ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN: "settings-token"
      }),
      null
    );
    assert.equal(contactRequestConfig({ [CONTACT_REQUEST_TOKEN_ENV]: "t" }), null);
  });
});

describe("handOverContact", () => {
  it("posts exactly the four fields to the OS path with the bearer token, and reports the receipt", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const outcome = await handOverContact(handOver, {
      config,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify(receipt), { status: 200 });
      }) as unknown as typeof fetch
    });
    assert.deepEqual(outcome, { ok: true, id: "req-1", duplicate: false, notified: true });
    assert.equal(seen!.url, `http://os.invalid${CONTACT_REQUEST_PATH}`);
    assert.equal(seen!.init.method, "POST");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer contact-token");
    assert.deepEqual(JSON.parse(String(seen!.init.body)), handOver);
  });

  it("a repeat that the OS knows is still a success (`duplicate: true`)", async () => {
    const outcome = await handOverContact(handOver, {
      config,
      fetchImpl: answering(200, { ...receipt, duplicate: true, notified: false })
    });
    assert.deepEqual(outcome, { ok: true, id: "req-1", duplicate: true, notified: false });
  });

  it("maps every refusal to its own code, and none of them is a success", async () => {
    const codes: Array<[number, string]> = [
      [400, "contact_request_rejected"],
      [401, "contact_request_unauthorized"],
      [403, "contact_request_unauthorized"],
      [409, "contact_request_off"],
      [500, "contact_request_unavailable"],
      [502, "contact_request_unavailable"],
      [404, "contact_request_unavailable"]
    ];
    for (const [status, code] of codes) {
      const outcome = await handOverContact(handOver, { config, fetchImpl: answering(status, { message: VALUE }) });
      assert.equal(outcome.ok, false, String(status));
      assert.equal(!outcome.ok && outcome.error, code, String(status));
      assert.equal(!outcome.ok && outcome.detail, `os status ${status}`);
    }
  });

  it("trusts only the receipt the OS promises: `recorded` exactly true, a string id, both flags booleans", async () => {
    const bad: unknown[] = [
      {},
      null,
      "ok",
      { ...receipt, recorded: false },
      { ...receipt, recorded: "true" },
      { ...receipt, id: "" },
      { ...receipt, id: 7 },
      { ...receipt, duplicate: "no" },
      { ...receipt, notified: undefined }
    ];
    for (const body of bad) {
      const outcome = await handOverContact(handOver, { config, fetchImpl: answering(200, body) });
      assert.equal(!outcome.ok && outcome.error, "contact_request_bad_response", JSON.stringify(body));
    }
    const notJson = await handOverContact(handOver, {
      config,
      fetchImpl: (async () => new Response("<html>", { status: 200 })) as typeof fetch
    });
    assert.equal(!notJson.ok && notJson.error, "contact_request_bad_response");
  });

  it("reports a transport failure or a timeout, never throws, and the detail holds neither the value nor the token", async () => {
    for (const [name, detail] of [["TypeError", "transport"], ["TimeoutError", "timeout"]] as const) {
      const outcome = await handOverContact(handOver, {
        config,
        fetchImpl: (async () => {
          throw Object.assign(new Error(`connect failed ${VALUE} contact-token`), { name });
        }) as typeof fetch
      });
      assert.deepEqual(outcome, { ok: false, error: "contact_request_unavailable", detail });
      assert.ok(!JSON.stringify(outcome).includes(VALUE));
      assert.ok(!JSON.stringify(outcome).includes("contact-token"));
    }
  });
});
