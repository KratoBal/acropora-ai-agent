import type { ContactChannel } from "./contact-mask.js";

/**
 * THE HAND-OVER OF A CONTACT TO THE OS (Acropora OS card f5b8f7ba, slice 4c; the OS route is `POST integrations/ai-chat/contact-requests`,
 * OS PR "contact request record, hand-over endpoint and notification"). The OS is the ONE place the contact lives; this service
 * passes it on and, only after the OS says `recorded: true`, masks its own copy and tells the customer it was forwarded.
 *
 * THE ENVELOPE IS THE CONTRACT, in the shape of `chat-settings.ts`: a call that fails is REPORTED, never thrown and never turned into
 * a success, because "the OS recorded it" and "the OS did not answer" must not look alike to the code that decides what the customer
 * is told. A body is trusted only when it is exactly what the OS promises (`recorded` exactly `true`, a string id); anything else is
 * a bad response. THE VALUE IS NEVER LOGGED and never part of an error detail: only a status number or the failure's name travels.
 *
 * Its own service token (`ACROPORA_OS_AI_CONTACT_TOKEN`): the settings reader's token opens no door here and this one opens no other
 * (plan 3/b).
 */
export const CONTACT_REQUEST_TOKEN_ENV = "ACROPORA_OS_AI_CONTACT_TOKEN";
export const CONTACT_REQUEST_PATH = "/integrations/ai-chat/contact-requests";
export const CONTACT_REQUEST_TIMEOUT_MS = 8_000;

export interface ContactRequestConfig {
  baseUrl: string;
  token: string;
}

/** `null` when either value is missing: then no hand-over is possible and the contact flow stays off. */
export function contactRequestConfig(
  environment: NodeJS.ProcessEnv = process.env
): ContactRequestConfig | null {
  const baseUrl = environment.ACROPORA_OS_BASE_URL?.trim();
  const token = environment[CONTACT_REQUEST_TOKEN_ENV]?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export interface ContactHandOver {
  channel: ContactChannel;
  value: string;
  /** This service's conversation id. */
  conversationRef: string;
  /** The id of the customer's message: one message is one request, however often the hand-over is retried. */
  requestKey: string;
}

export type ContactRequestErrorCode =
  | "contact_request_unauthorized"
  | "contact_request_rejected"
  | "contact_request_off"
  | "contact_request_unavailable"
  | "contact_request_bad_response";

export type ContactRequestOutcome =
  | { ok: true; id: string; duplicate: boolean; notified: boolean }
  | { ok: false; error: ContactRequestErrorCode; detail: string };

export async function handOverContact(
  handOver: ContactHandOver,
  options: { config: ContactRequestConfig; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<ContactRequestOutcome> {
  const call = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.config.baseUrl}${CONTACT_REQUEST_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.config.token}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(handOver),
      signal: AbortSignal.timeout(options.timeoutMs ?? CONTACT_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    // Only the NAME of the failure travels: a transport error can carry the request, and the request holds the token and the value.
    const name = (error as Error)?.name ?? "unknown";
    return {
      ok: false,
      error: "contact_request_unavailable",
      detail: name === "TimeoutError" ? "timeout" : "transport"
    };
  }

  const detail = `os status ${response.status}`;
  if (response.status === 401 || response.status === 403)
    return { ok: false, error: "contact_request_unauthorized", detail };
  if (response.status === 400)
    return { ok: false, error: "contact_request_rejected", detail };
  if (response.status === 409)
    return { ok: false, error: "contact_request_off", detail };
  if (!response.ok)
    return { ok: false, error: "contact_request_unavailable", detail };

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    typeof body !== "object" ||
    body === null ||
    body.recorded !== true ||
    typeof body.id !== "string" ||
    body.id === "" ||
    typeof body.duplicate !== "boolean" ||
    typeof body.notified !== "boolean"
  )
    return {
      ok: false,
      error: "contact_request_bad_response",
      detail: "body is not the receipt"
    };
  return { ok: true, id: body.id, duplicate: body.duplicate, notified: body.notified };
}
