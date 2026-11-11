/**
 * THE CHAT SETTINGS THE OS HOLDS, READ BY THE AI SERVICE (Acropora OS card f5b8f7ba, slice 4a/4b; plan
 * `exchange-out/ai-eloszures-4-szelet-terv-2026-11-11.md`, section 2/1; the OS route is OS #2400, `GET
 * integrations/ai-chat-settings/service`).
 *
 * THE ENVELOPE IS THE CONTRACT, in the same shape as `product-search.ts`: a call that fails is REPORTED (never thrown, never turned
 * into a default), because "the OS said 365" and "the OS did not answer" must not look alike to a job that deletes data. A body is
 * trusted only when every field is exactly what the OS promises: two booleans and a whole number of days from 7 to 365. Anything
 * else is a bad response, not a value to repair.
 *
 * Its own service token (`ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN`): the product-search and customer-context tokens open no door here
 * and this one opens no other (plan 3/b).
 */
export const CHAT_SETTINGS_TOKEN_ENV = "ACROPORA_OS_AI_CHAT_SETTINGS_TOKEN";
export const CHAT_SETTINGS_PATH = "/integrations/ai-chat-settings/service";
export const CHAT_SETTINGS_TIMEOUT_MS = 5_000;

/** The same bounds the OS enforces (`AI_CHAT_SETTINGS_LIMITS`); a value outside them is not trusted. */
export const CHAT_SETTINGS_MIN_DAYS = 7;
export const CHAT_SETTINGS_MAX_DAYS = 365;

export interface ChatSettingsView {
  offerEnabled: boolean;
  contactRequestEnabled: boolean;
  messageRetentionDays: number;
}

export type ChatSettingsErrorCode =
  | "chat_settings_unauthorized"
  | "chat_settings_unavailable"
  | "chat_settings_bad_response";

export type ChatSettingsOutcome =
  | { ok: true; view: ChatSettingsView }
  | { ok: false; error: ChatSettingsErrorCode; detail: string };

export interface ChatSettingsConfig {
  baseUrl: string;
  token: string;
}

/** `null` when either value is missing: then the service does not read the OS at all (and the retention job keeps its environment value). */
export function chatSettingsConfig(
  environment: NodeJS.ProcessEnv = process.env
): ChatSettingsConfig | null {
  const baseUrl = environment.ACROPORA_OS_BASE_URL?.trim();
  const token = environment[CHAT_SETTINGS_TOKEN_ENV]?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** Strict: exactly the three fields, the right types, the days a whole number within the bounds. */
export function parseChatSettingsView(body: unknown): ChatSettingsView | null {
  if (typeof body !== "object" || body === null) return null;
  const source = body as Record<string, unknown>;
  const days = source.messageRetentionDays;
  if (
    typeof source.offerEnabled !== "boolean" ||
    typeof source.contactRequestEnabled !== "boolean" ||
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < CHAT_SETTINGS_MIN_DAYS ||
    days > CHAT_SETTINGS_MAX_DAYS
  )
    return null;
  return {
    offerEnabled: source.offerEnabled,
    contactRequestEnabled: source.contactRequestEnabled,
    messageRetentionDays: days
  };
}

export interface ChatSettingsOptions {
  config: ChatSettingsConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ChatSettingsBody =
  | { ok: true; body: unknown }
  | { ok: false; error: ChatSettingsErrorCode; detail: string };

/**
 * THE ONE CALL TO THE READER ENDPOINT, shared by the readers of its fields (the retention days here, the stored link sources
 * in `link-sources.ts`; barracuda on #77): one transport, one token, one set of failure codes. Each reader then checks ONLY the
 * fields it acts on, so a reader never depends on a field it does not use. A body that is not JSON comes back as `null`.
 */
export async function requestChatSettings(options: ChatSettingsOptions): Promise<ChatSettingsBody> {
  const call = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.config.baseUrl}${CHAT_SETTINGS_PATH}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.config.token}`,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? CHAT_SETTINGS_TIMEOUT_MS)
    });
  } catch (error) {
    // Only the NAME of the failure travels: a transport error can carry the request, and the request holds the token.
    const name = (error as Error)?.name ?? "unknown";
    return {
      ok: false,
      error: "chat_settings_unavailable",
      detail: name === "TimeoutError" ? "timeout" : "transport"
    };
  }

  if (response.status === 401 || response.status === 403)
    return {
      ok: false,
      error: "chat_settings_unauthorized",
      detail: `os status ${response.status}`
    };
  if (!response.ok)
    return {
      ok: false,
      error: "chat_settings_unavailable",
      detail: `os status ${response.status}`
    };

  return { ok: true, body: await response.json().catch(() => null) };
}

export async function fetchChatSettings(
  options: ChatSettingsOptions
): Promise<ChatSettingsOutcome> {
  const answer = await requestChatSettings(options);
  if (!answer.ok) return answer;
  const view = parseChatSettingsView(answer.body);
  if (!view)
    return {
      ok: false,
      error: "chat_settings_bad_response",
      detail: "body is not the three settings"
    };
  return { ok: true, view };
}
