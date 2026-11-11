import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAT_SETTINGS_PATH,
  CHAT_SETTINGS_TOKEN_ENV,
  chatSettingsConfig,
  fetchChatSettings,
  parseChatSettingsView
} from "./chat-settings.js";
import { SECRET_ENVIRONMENT_KEYS } from "./redact.js";

const good = { offerEnabled: false, contactRequestEnabled: false, messageRetentionDays: 180 };
const config = { baseUrl: "http://os.invalid", token: "settings-token-secret" };

const respond = (status: number, body: unknown) =>
  (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

describe("the OS chat settings client", () => {
  it("is configured only with BOTH the OS address and its own token", () => {
    assert.equal(chatSettingsConfig({}), null);
    assert.equal(chatSettingsConfig({ ACROPORA_OS_BASE_URL: "http://os" }), null);
    assert.equal(chatSettingsConfig({ [CHAT_SETTINGS_TOKEN_ENV]: "t" }), null);
    assert.equal(chatSettingsConfig({ ACROPORA_OS_BASE_URL: "http://os", [CHAT_SETTINGS_TOKEN_ENV]: "   " }), null);
    assert.deepEqual(chatSettingsConfig({ ACROPORA_OS_BASE_URL: "http://os///", [CHAT_SETTINGS_TOKEN_ENV]: " t " }), {
      baseUrl: "http://os",
      token: "t"
    });
  });

  it("the other two OS tokens do NOT configure it (a token that reads products reads no settings)", () => {
    assert.equal(
      chatSettingsConfig({
        ACROPORA_OS_BASE_URL: "http://os",
        ACROPORA_OS_PRODUCT_SEARCH_TOKEN: "a",
        ACROPORA_OS_AI_SERVICE_TOKEN: "b"
      }),
      null
    );
  });

  it("its token is a secret the log redaction knows", () => {
    assert.ok((SECRET_ENVIRONMENT_KEYS as readonly string[]).includes(CHAT_SETTINGS_TOKEN_ENV));
  });

  it("a body is trusted only when it is exactly the three settings: two booleans and whole days 7..365", () => {
    assert.deepEqual(parseChatSettingsView(good), good);
    assert.deepEqual(parseChatSettingsView({ ...good, messageRetentionDays: 7 })?.messageRetentionDays, 7);
    assert.deepEqual(parseChatSettingsView({ ...good, messageRetentionDays: 365 })?.messageRetentionDays, 365);
    for (const bad of [
      null,
      undefined,
      "x",
      [],
      {},
      { ...good, messageRetentionDays: 6 },
      { ...good, messageRetentionDays: 366 },
      { ...good, messageRetentionDays: 30.5 },
      { ...good, messageRetentionDays: "30" },
      { ...good, messageRetentionDays: null },
      { ...good, offerEnabled: "false" },
      { ...good, contactRequestEnabled: 0 },
      { offerEnabled: true, contactRequestEnabled: true }
    ])
      assert.equal(parseChatSettingsView(bad), null, JSON.stringify(bad));
  });

  it("an extra field of the OS is not carried into the view", () => {
    const view = parseChatSettingsView({ ...good, contactRecipientEmail: "x@y.hu" });
    assert.deepEqual(Object.keys(view ?? {}).sort(), ["contactRequestEnabled", "messageRetentionDays", "offerEnabled"]);
  });

  it("asks the OS's service route with its own bearer token", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const spy: typeof fetch = async (url, init) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify(good), { status: 200 });
    };
    const outcome = await fetchChatSettings({ config, fetchImpl: spy });
    assert.deepEqual(outcome, { ok: true, view: good });
    assert.equal(seen!.url, `http://os.invalid${CHAT_SETTINGS_PATH}`);
    assert.equal(seen!.headers.authorization, "Bearer settings-token-secret");
  });

  it("a failure is REPORTED with a code, never thrown and never turned into a default", async () => {
    assert.deepEqual(await fetchChatSettings({ config, fetchImpl: respond(401, "") }), {
      ok: false,
      error: "chat_settings_unauthorized",
      detail: "os status 401"
    });
    assert.equal((await fetchChatSettings({ config, fetchImpl: respond(403, "") })).ok, false);
    assert.deepEqual(await fetchChatSettings({ config, fetchImpl: respond(500, "") }), {
      ok: false,
      error: "chat_settings_unavailable",
      detail: "os status 500"
    });
    assert.deepEqual(await fetchChatSettings({ config, fetchImpl: respond(200, "not json") }), {
      ok: false,
      error: "chat_settings_bad_response",
      detail: "body is not the three settings"
    });
    assert.equal((await fetchChatSettings({ config, fetchImpl: respond(200, { ...good, messageRetentionDays: 999 }) })).ok, false);
  });

  it("a transport error or a timeout names only the kind, and the token never appears in the outcome", async () => {
    const boom: typeof fetch = async () => {
      throw Object.assign(new Error(`connect failed for Bearer ${config.token}`), { name: "TypeError" });
    };
    const slow: typeof fetch = async () => {
      throw Object.assign(new Error("slow"), { name: "TimeoutError" });
    };
    const transport = await fetchChatSettings({ config, fetchImpl: boom });
    const timeout = await fetchChatSettings({ config, fetchImpl: slow });
    assert.deepEqual(transport, { ok: false, error: "chat_settings_unavailable", detail: "transport" });
    assert.deepEqual(timeout, { ok: false, error: "chat_settings_unavailable", detail: "timeout" });
    assert.equal(JSON.stringify([transport, timeout]).includes(config.token), false);
  });
});
