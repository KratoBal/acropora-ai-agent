import OpenAI, { APIConnectionTimeoutError } from "openai";

/**
 * How long this API is willing to wait for the model, and what it says when it
 * stops waiting.
 *
 * The reason this file exists is a measurement rather than a preference. The
 * request path is six hops deep - browser, Next.js rewrite proxy, Acropora OS
 * API, Caddy, this service, OpenAI - and the tolerances were in the wrong
 * order: this service waited without any limit, the OpenAI client defaulted to
 * ten minutes with two retries, while the Next.js proxy in front gives up
 * after thirty seconds. The chain was being cut in the middle, so a caller saw
 * a failure while the work was still running, and the answer arrived into a
 * connection nobody was reading any more.
 *
 * The shape that fixes it is not a bigger number, it is an order: **the inner
 * limit must be shorter than the outer one**, so that whoever gives up first
 * is the one that can explain why.
 */

export const OPENAI_TIMEOUT_MS_ENV = "ACROPORA_AI_OPENAI_TIMEOUT_MS";
export const OPENAI_MAX_RETRIES_ENV = "ACROPORA_AI_OPENAI_MAX_RETRIES";
export const CONNECTION_TIMEOUT_MS_ENV = "ACROPORA_AI_CONNECTION_TIMEOUT_MS";

/**
 * Forty seconds: the first rung of the agreed ladder, and the only one that
 * fails with a name.
 *
 * The earlier value was twenty-five, chosen to stay under the thirty second
 * ceiling the Next.js rewrite proxy inherited. That ceiling has been raised to
 * fifty deliberately, and the ladder now reads outwards: this call gives up at
 * forty, the socket net below sits at forty-five, and the proxy at fifty.
 *
 * Twenty-five turned out to be tight against real questions, not theoretical
 * ones: of eleven product questions measured on stage, one timed out at 25 s
 * and another answered at 24.9 s. Two of eleven were at the ceiling.
 *
 * It stays configurable, because every number above it is configurable too and
 * they have to move together. A limit that cannot be changed without a deploy
 * goes stale the first time the chain is retuned.
 */
const DEFAULT_TIMEOUT_MS = 40_000;

/**
 * No retries, and this is the part worth reading.
 *
 * The SDK default is two, which sounds harmless and is not: a retry multiplies
 * the wall clock invisibly. Three attempts at twenty-five seconds is over a
 * minute, and the hop in front - which knows nothing about our retries - would
 * cut long before the last attempt finished. A person waiting for a chat
 * answer is better served by a clear failure than by a silent third attempt
 * they will never see.
 */
const DEFAULT_MAX_RETRIES = 0;

/**
 * Forty-five seconds, and this one is a net rather than a step.
 *
 * Fastify has two settings whose names invite the wrong choice.
 * `requestTimeout` bounds READING the request, so it does nothing about a slow
 * answer. `connectionTimeout` does bound a slow handler - measured: with 2 000
 * ms set and a handler sleeping 5 000 ms, the connection closed at 2.004 s.
 *
 * But it closes the connection, it does not answer. The caller gets no HTTP
 * status at all, which is the shape of failure this service spent a day
 * removing. So it must never be the limit that fires in normal operation: the
 * model call above gives up five seconds earlier, with a code and a duration.
 *
 * What this catches is the case nothing else does - a handler stuck somewhere
 * other than the model call, the database being the obvious candidate, where
 * there is no timeout at all today.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 45_000;

export interface AiProviderLimits {
  timeoutMs: number;
  maxRetries: number;
  connectionTimeoutMs: number;
}

function boundedNumber(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const value = Number(raw?.trim());

  if (!raw?.trim() || !Number.isFinite(value)) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    return fallback;

  return value;
}

/**
 * Reads both limits, and falls back rather than throwing.
 *
 * A malformed value must not take the service down at boot: the safe outcome
 * is the documented default, not a crash on a typo in an environment variable.
 */
export function aiProviderLimits(
  environment: NodeJS.ProcessEnv = process.env
): AiProviderLimits {
  return {
    timeoutMs: boundedNumber(
      environment[OPENAI_TIMEOUT_MS_ENV],
      DEFAULT_TIMEOUT_MS,
      1_000,
      600_000
    ),
    maxRetries: boundedNumber(
      environment[OPENAI_MAX_RETRIES_ENV],
      DEFAULT_MAX_RETRIES,
      0,
      5
    ),
    connectionTimeoutMs: boundedNumber(
      environment[CONNECTION_TIMEOUT_MS_ENV],
      DEFAULT_CONNECTION_TIMEOUT_MS,
      1_000,
      600_000
    )
  };
}

/**
 * Was this failure the clock running out, or something else?
 *
 * Three ways of asking, because one is not enough. The SDK's own timeout class
 * is the direct answer; an `AbortSignal.timeout` surfaces as a `TimeoutError`
 * cause; and a transport layer can report the same thing in the message alone.
 * A timeout misread as a generic provider error would put the caller back
 * where this change started: a failure that does not say what happened.
 */
export function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true;

  const candidate = error as { message?: unknown; cause?: { name?: unknown } };

  if (candidate?.cause?.name === "TimeoutError") return true;

  return (
    typeof candidate?.message === "string" &&
    /timed out|timeout/i.test(candidate.message)
  );
}

/**
 * Builds the OpenAI client with both limits attached.
 *
 * An exported function rather than an inline `new OpenAI(...)` in the route
 * builder, and the reason is measurable: a test can call THIS and read back
 * what the client actually carries. A test that built its own client instead
 * would stay green while the real construction quietly inherited the SDK
 * defaults again - which is the exact regression this file exists to prevent.
 */
export function createAiClient(
  limits: AiProviderLimits,
  environment: NodeJS.ProcessEnv = process.env
): OpenAI {
  return new OpenAI({
    apiKey: environment.OPENAI_API_KEY,
    timeout: limits.timeoutMs,
    maxRetries: limits.maxRetries
  });
}

export interface AiProviderFailure {
  status: number;
  body: {
    error: "ai_provider_timeout" | "ai_provider_error";
    waitedMs: number;
  };
}

/**
 * What the caller is told when the model call fails.
 *
 * A timeout is answered with 504 and its own code, because the surface in
 * front has to be able to say "it timed out after N seconds" rather than
 * "something went wrong". `waitedMs` is part of the answer for the same
 * reason: the number is what makes a slow chain visible to whoever is looking
 * at the screen, instead of only to whoever is reading the log.
 *
 * Nothing from the provider's error travels out. The upstream message may
 * quote our key back at us; the log gets a redacted summary, the caller gets
 * a code and a duration.
 */
export function aiProviderFailure(
  error: unknown,
  waitedMs: number
): AiProviderFailure {
  if (isTimeoutFailure(error)) {
    return {
      status: 504,
      body: { error: "ai_provider_timeout", waitedMs }
    };
  }

  return {
    status: 502,
    body: { error: "ai_provider_error", waitedMs }
  };
}
