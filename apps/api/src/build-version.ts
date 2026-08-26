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
