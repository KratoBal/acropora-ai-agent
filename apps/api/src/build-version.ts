/**
 * The commit this build was made from.
 *
 * Read from the environment at call time rather than captured at import time,
 * so a test can supply its own and so the value cannot go stale in a
 * long-lived process.
 *
 * The variable is set by the deploy workflow from the sha it is deploying.
 * Anything that starts the container another way leaves it empty, and the
 * honest answer there is `unknown`.
 */
export const BUILD_VERSION_ENV = "ACROPORA_AI_COMMIT";

export const UNKNOWN_VERSION = "unknown";

export function buildVersion(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const raw = environment[BUILD_VERSION_ENV]?.trim();

  if (!raw) return UNKNOWN_VERSION;

  /**
   * Bounded, and only the characters a git sha can contain.
   *
   * The value travels from a deploy variable into an unauthenticated
   * response, which is the one place in this service where an environment
   * value is echoed to anyone who asks. It is not a secret, but "not a
   * secret" is not a reason to hand back whatever happens to be in there.
   */
  if (!/^[0-9a-f]{7,40}$/i.test(raw)) return UNKNOWN_VERSION;

  return raw.toLowerCase();
}

/**
 * When the image this process runs from was assembled.
 *
 * A sha alone cannot answer "is this the same image", and today it had to.
 * The same commit built twice produced two different images: one build pulled
 * a patched `libssl3`, the other hit a cached layer and kept the old one.
 * Both would report the same version here, and the difference between them
 * was the whole question.
 *
 * So this is the IMAGE's timestamp, not the deploy's. It arrives as a build
 * argument and is baked into the image, which is why it can say something the
 * commit cannot: two images from one commit carry two different values.
 *
 * A deploy-time variable would have been easier and would have been wrong in
 * exactly the case worth measuring - when `docker compose up --build` finds
 * nothing to rebuild, the container is recreated while the image is not.
 */
export const BUILD_TIME_ENV = "ACROPORA_AI_BUILT_AT";

export function buildTime(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const raw = environment[BUILD_TIME_ENV]?.trim();

  if (!raw) return UNKNOWN_VERSION;

  /**
   * One accepted spelling, and the answer is always the canonical one.
   *
   * `new Date()` is generous - it takes "December 2026" and shapes that vary
   * by runtime - and this value is echoed to anyone who calls the health
   * endpoint. The pattern below admits exactly UTC ISO 8601, with or without
   * milliseconds, because `date -u +%Y-%m-%dT%H:%M:%SZ` writes the shorter
   * one and a stricter rule would have quietly answered `unknown` for every
   * real deploy.
   */
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw)) {
    return UNKNOWN_VERSION;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) return UNKNOWN_VERSION;

  return parsed.toISOString();
}
