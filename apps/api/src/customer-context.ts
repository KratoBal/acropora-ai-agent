/**
 * The customer's context, read from the Acropora OS.
 *
 * The OS endpoint is `GET /integrations/ai/user-context` (acropora-os PR #141).
 * It answers with the customer's identity and nothing else: no name, e-mail,
 * phone or address, because its query never loads them. Whatever this module
 * forwards to the model is therefore already limited at the source.
 *
 * Everything the chat handler needs lives here rather than in `server.ts`, and
 * that is deliberate. The status mapping, the body sent back to the caller and
 * the block handed to the model are the parts worth asserting, and a function
 * can be called by a test while a request handler cannot.
 */

/** The 200 answer, exactly as the OS defines it. */
export interface AcroporaCustomerContext {
  subjectType: "customer";
  customerId: string;
  customerNumber: string;
  /** Always an empty object today. Never null, never absent. */
  entitlements: Record<string, never>;
  /**
   * Why `entitlements` is empty, in a form that can be branched on. Today the
   * OS only ever sends `not-modelled`, but the value is kept open here: this
   * side must not break when the OS starts sending `resolved`.
   */
  entitlementsStatus: string;
  entitlementsNote: string;
}

/**
 * The error codes this API answers with. The first three are Balazs's
 * mapping; `customer_id_required` is ours, for a request that cannot be sent
 * to the OS in the first place.
 */
export type CustomerContextErrorCode =
  | "customer_id_required"
  | "customer_context_auth_error"
  | "customer_not_found"
  | "customer_context_unavailable";

export interface CustomerContextFailure {
  ok: false;
  /** The HTTP status THIS API answers with, not the one the OS gave. */
  status: number;
  error: CustomerContextErrorCode;
  /**
   * A short diagnostic for the log, never for the caller. It carries the OS
   * status or the failure kind and nothing else - no token, no header, no OS
   * message, because an upstream message can quote back what we sent it.
   */
  detail: string;
}

export interface CustomerContextSuccess {
  ok: true;
  context: AcroporaCustomerContext;
}

export type CustomerContextResult =
  | CustomerContextSuccess
  | CustomerContextFailure;

export interface AcroporaOsConfig {
  baseUrl: string;
  token: string;
}

export interface ResolveCustomerContextOptions {
  environment?: NodeJS.ProcessEnv;
  /**
   * The HTTP call itself. Tests pass their own, and they pass it to THIS
   * function, so what runs under test is the same path the server takes.
   */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const CUSTOMER_CONTEXT_PATH = "/integrations/ai/user-context";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Returns the configuration, or `null` when either half is missing.
 *
 * Both halves are required together: a base url without a token would produce
 * a call that the OS answers with 401, and a token without a base url has
 * nowhere to go. `null` here means "we cannot ask", which is answered as
 * unavailable rather than as a successful chat without context.
 */
export function acroporaOsConfig(
  environment: NodeJS.ProcessEnv = process.env
): AcroporaOsConfig | null {
  const baseUrl = environment.ACROPORA_OS_BASE_URL?.trim();
  const token = environment.ACROPORA_OS_AI_SERVICE_TOKEN?.trim();

  if (!baseUrl || !token) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token
  };
}

/**
 * True when the value has the shape the OS promises.
 *
 * A 200 that does not carry an identity is not a customer context, and
 * forwarding it would put an `undefined` in front of the model and in the
 * answer. It is treated as an unavailable upstream, not as a success.
 */
function isCustomerContext(value: unknown): value is AcroporaCustomerContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate.subjectType === "customer" &&
    typeof candidate.customerId === "string" &&
    candidate.customerId.length > 0 &&
    typeof candidate.customerNumber === "string" &&
    typeof candidate.entitlements === "object" &&
    candidate.entitlements !== null
  );
}

/**
 * Reads one customer's context from the OS, and maps every outcome to a
 * decision this API can act on.
 *
 * The order matters. The identifier is validated here, before anything is
 * sent: an empty one would reach the OS as a missing header and come back as
 * a 400 that says nothing to our caller, after a pointless round trip. The
 * configuration is checked next, so an unconfigured deployment never sends the
 * service token anywhere.
 */
export async function resolveCustomerContext(
  rawCustomerId: unknown,
  options: ResolveCustomerContextOptions = {}
): Promise<CustomerContextResult> {
  const customerId =
    typeof rawCustomerId === "string" ? rawCustomerId.trim() : "";

  if (!customerId) {
    return {
      ok: false,
      status: 400,
      error: "customer_id_required",
      detail: "missing or empty X-Acropora-User-Id"
    };
  }

  const config = acroporaOsConfig(options.environment ?? process.env);

  if (!config) {
    return {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: "ACROPORA_OS_BASE_URL or ACROPORA_OS_AI_SERVICE_TOKEN is not set"
    };
  }

  const call = options.fetchImpl ?? fetch;
  let response: Response;

  try {
    response = await call(`${config.baseUrl}${CUSTOMER_CONTEXT_PATH}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-acropora-user-id": customerId,
        accept: "application/json"
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });
  } catch (error) {
    // The error object is not logged: a transport error can carry the request
    // it failed on, and that request has the token in its headers.
    return {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: `transport failure: ${(error as Error)?.name ?? "unknown"}`
    };
  }

  // 403 is mapped because Balazs asked for it, but the OS guard raises 401 on
  // every branch it has - see the PR description. It is unreachable today.
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      status: 502,
      error: "customer_context_auth_error",
      detail: `Acropora OS answered ${response.status}`
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      error: "customer_not_found",
      detail: "Acropora OS answered 404"
    };
  }

  /**
   * Everything else is unavailable, including the OS's own 400.
   *
   * A status nobody planned for must not fall through quietly and must not
   * look like a successful answer. That is the whole reason this branch is
   * last and catches the remainder rather than listing what it knows.
   */
  if (response.status !== 200) {
    return {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: `Acropora OS answered ${response.status}`
    };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: "Acropora OS answered 200 with a body that is not JSON"
    };
  }

  if (!isCustomerContext(payload)) {
    return {
      ok: false,
      status: 502,
      error: "customer_context_unavailable",
      detail: "Acropora OS answered 200 without a customer identity"
    };
  }

  return {
    ok: true,
    context: payload
  };
}

/**
 * The body sent to the caller on failure.
 *
 * `detail` is deliberately dropped. It is written for the operator reading the
 * log, and it names the upstream status; the caller of this API gets the code
 * and nothing more.
 */
export function customerContextErrorBody(failure: CustomerContextFailure): {
  error: CustomerContextErrorCode;
} {
  return {
    error: failure.error
  };
}

/**
 * The temporary customer fields on the chat answer.
 *
 * Balazs asked for these four by name, and marked them temporary: they exist
 * so that a person can see the binding works end to end. Removing them later
 * means deleting this function and its call site, nothing else.
 */
export function customerContextResponseFields(
  context: AcroporaCustomerContext
): {
  subjectType: string;
  customerId: string;
  customerNumber: string;
  entitlements: Record<string, never>;
} {
  return {
    subjectType: context.subjectType,
    customerId: context.customerId,
    customerNumber: context.customerNumber,
    entitlements: context.entitlements
  };
}

/**
 * What the model is told about the person it is talking to.
 *
 * `entitlementsStatus` is included on purpose. Without it an empty
 * entitlement set reads as "this customer is entitled to nothing", and the
 * model would start refusing things on a fact that was never measured.
 */
export function customerContextInstructions(
  context: AcroporaCustomerContext
): string {
  return [
    "Customer context from the Acropora OS:",
    `- customer id: ${context.customerId}`,
    `- customer number: ${context.customerNumber}`,
    `- subject type: ${context.subjectType}`,
    `- entitlements: ${JSON.stringify(context.entitlements)} (status: ${context.entitlementsStatus})`,
    "The entitlement set is empty because no entitlement model exists yet, not",
    "because this customer was denied anything. Do not refuse a request on the",
    "basis of entitlements, and do not read these identifiers back to the user",
    "unless they ask for them."
  ].join("\n");
}
