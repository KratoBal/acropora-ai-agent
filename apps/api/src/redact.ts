/**
 * Keeping secrets out of the log, on the one path that could still carry them.
 *
 * Every other log line in this API was measured and is clean: Fastify's
 * default request logger records the method, url, host and remote address and
 * never the headers or the body, and the customer-context failures carry a
 * deliberately narrow diagnostic. The exception was the OpenAI failure branch,
 * which handed the whole error object to the logger.
 *
 * That branch was never proven to leak - it could not be triggered from here -
 * and it is narrowed anyway, because "we could not make it leak" is a weaker
 * statement than "it cannot".
 */

/**
 * The environment variables whose values must never appear in a log line.
 *
 * Read by name at call time rather than captured at import time, so that a
 * test can supply its own environment and so that a value rotated at runtime
 * is still redacted.
 */
export const SECRET_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "API_ACCESS_TOKEN",
  "ACROPORA_OS_AI_SERVICE_TOKEN"
] as const;

/**
 * Provider key shapes that can appear in an upstream error message.
 *
 * This is the case the exact-value pass cannot catch: OpenAI answers a bad key
 * with a message that quotes the key back, partially masked
 * ("Incorrect API key provided: sk-abc***xyz"). A partially masked key is not
 * equal to the configured value, so only a shape match removes it - and a
 * masked key still tells an attacker the prefix and the suffix.
 */
const KEY_SHAPES = [/\bsk-[A-Za-z0-9_*-]{4,}/g, /\bBearer\s+\S+/gi];

const REDACTED = "[redacted]";

/**
 * Removes known secrets from a piece of text.
 *
 * Two passes, and both are needed. The first replaces the exact configured
 * values, which is precise and catches a secret quoted back verbatim. The
 * second replaces anything shaped like a provider key, which catches the
 * masked forms the first pass cannot see.
 *
 * Very short values are skipped: a one or two character secret would turn the
 * whole message into redaction markers, and a value that short is not a secret
 * that this pass can meaningfully protect.
 */
export function redactSecrets(
  text: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  let result = text;

  for (const key of SECRET_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (!value || value.length < 8) continue;

    result = result.split(value).join(REDACTED);
  }

  for (const shape of KEY_SHAPES) {
    result = result.replace(shape, REDACTED);
  }

  return result;
}

export interface SafeErrorSummary {
  message: string;
  status?: number;
  code?: string;
  type?: string;
}

/**
 * What an upstream failure is allowed to put in the log.
 *
 * Four fields, chosen rather than inherited: the status, the provider's own
 * error code and type when it has them, and a redacted message. The error
 * object itself never reaches the logger, because its shape is the provider's
 * to change - a future SDK version could attach the outgoing request, and the
 * outgoing request carries the key.
 */
export function safeErrorSummary(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env
): SafeErrorSummary {
  const candidate = (
    typeof error === "object" && error !== null ? error : {}
  ) as Record<string, unknown>;

  const rawMessage =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof error === "string"
        ? error
        : "unknown error";

  const summary: SafeErrorSummary = {
    message: redactSecrets(rawMessage, environment)
  };

  if (typeof candidate.status === "number") summary.status = candidate.status;
  if (typeof candidate.code === "string")
    summary.code = redactSecrets(candidate.code, environment);
  if (typeof candidate.type === "string")
    summary.type = redactSecrets(candidate.type, environment);

  return summary;
}
