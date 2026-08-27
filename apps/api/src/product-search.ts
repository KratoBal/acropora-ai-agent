/**
 * Asking the Acropora OS about products.
 *
 * Balazs decided on 2026-08-27 who searches: the OS does. It builds the
 * product context from the user's question, and this service receives it. If
 * the hits are not precise enough, this service may ask AGAIN - and that
 * second ask is what this module is.
 *
 * **The caller knows nothing about how the search works, and that is the
 * design rather than an omission.** Whether a full-text index, a trigram
 * match or a vector store answers on the other side, this module sends a
 * question and forwards what comes back. The moment it started sorting,
 * filtering or re-ranking the hits, "swappable search" would stop being true:
 * the engine would have a second half living over here, and changing it would
 * mean changing both.
 *
 * So: no re-ordering, no client-side filtering, no interpretation of
 * relevance. The projection travels through unchanged.
 */

/** The OS endpoint, as `acropora-os` defines it. */
export const PRODUCT_SEARCH_PATH = "/integrations/ai-product-search";

/**
 * How long to wait for a catalogue search.
 *
 * Far shorter than the model call, because it is a different kind of work: a
 * query against an index, not a generation. Inheriting the forty second model
 * budget would mean a person waiting most of a minute for a lookup that
 * either answers quickly or is broken.
 */
export const PRODUCT_SEARCH_TIMEOUT_MS = 8_000;

/**
 * The token for THIS door, and deliberately not the customer-context one.
 *
 * The OS guards the two endpoints with two separate mechanisms, each
 * accepting exactly one token record. Reusing `ACROPORA_OS_AI_SERVICE_TOKEN`
 * here would simply be refused - but the reason to keep them apart is not
 * that it would fail. It is that one leaked credential must not carry two
 * systems.
 */
export const PRODUCT_SEARCH_TOKEN_ENV = "ACROPORA_OS_PRODUCT_SEARCH_TOKEN";

export interface ProductSearchConfig {
  baseUrl: string;
  token: string;
}

/**
 * Both halves are required together. A base url without a token produces a
 * call the OS answers with 401; a token without a url has nowhere to go.
 * `null` means "we cannot ask", which the caller turns into a stated failure
 * rather than an empty result - the two are not the same, and a search that
 * silently returns nothing would look like a catalogue with nothing in it.
 */
export function productSearchConfig(
  environment: NodeJS.ProcessEnv = process.env
): ProductSearchConfig | null {
  const baseUrl = environment.ACROPORA_OS_BASE_URL?.trim();
  const token = environment[PRODUCT_SEARCH_TOKEN_ENV]?.trim();

  if (!baseUrl || !token) return null;

  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

export type ProductSearchErrorCode =
  | "product_search_not_configured"
  | "product_search_unauthorized"
  | "product_search_unavailable"
  | "product_search_bad_response";

export type ProductSearchOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: ProductSearchErrorCode; detail: string };

export interface ProductSearchOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Runs one catalogue search through the OS.
 *
 * The result is typed as `unknown` on purpose. The projection's shape is the
 * OS's to define and to version - it sends a `projectionVersion` with every
 * answer - and a mirrored interface over here would be a second copy that
 * drifts silently. What this module guarantees is the ENVELOPE: whether the
 * call succeeded, and if not, why.
 *
 * Failures are reported, never thrown, and never turned into an empty result.
 * "The search found nothing" and "the search could not run" must not look
 * alike: the first is an answer about the catalogue, the second is an outage,
 * and a model that cannot tell them apart will confidently say we carry
 * nothing.
 */
export async function searchProducts(
  input: { query: string; limit?: number },
  options: ProductSearchOptions = {}
): Promise<ProductSearchOutcome> {
  const config = productSearchConfig(options.environment ?? process.env);

  if (!config) {
    return {
      ok: false,
      error: "product_search_not_configured",
      detail: `ACROPORA_OS_BASE_URL or ${PRODUCT_SEARCH_TOKEN_ENV} is not set`
    };
  }

  const query = new URLSearchParams({ q: input.query });

  if (input.limit !== undefined) query.set("limit", String(input.limit));

  const call = options.fetchImpl ?? fetch;
  let response: Response;

  try {
    response = await call(
      `${config.baseUrl}${PRODUCT_SEARCH_PATH}?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: "application/json"
        },
        signal: AbortSignal.timeout(
          options.timeoutMs ?? PRODUCT_SEARCH_TIMEOUT_MS
        )
      }
    );
  } catch (error) {
    /**
     * Only the NAME of the failure travels. A transport error can carry the
     * request that failed, and that request holds the token.
     */
    const name = (error as Error)?.name ?? "unknown";

    return {
      ok: false,
      error: "product_search_unavailable",
      detail: name === "TimeoutError" ? "timeout" : "transport"
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: "product_search_unauthorized",
      detail: `os status ${response.status}`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: "product_search_unavailable",
      detail: `os status ${response.status}`
    };
  }

  const body = await response.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return {
      ok: false,
      error: "product_search_bad_response",
      detail: "body is not an object"
    };
  }

  return { ok: true, result: body };
}
