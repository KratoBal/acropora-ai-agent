/**
 * THE QUESTION-SET RUNNER'S OWN CLIENT KEY (t-20261116-kerdeskeszlet-or).
 *
 * Its conversations stay apart from every OS user's (the OS sends `os-user:<id>`), and it is the ONE caller the dose
 * guard names its triggering sentence to (`doseGuardSentence` on /v1/chat). The sentence is the refused, possibly
 * unsafe dose text, and the test AI also answers the live OS (acrobot 53803), so a service-wide switch would have
 * reached customers' answers; a request-level gate on this key does not. Any Bearer-token holder can send the key,
 * which is the OS and the fleet; the OS never sends it.
 */
export const QUESTION_SET_CLIENT_KEY = "question-set-run";

/**
 * AND THE INSTANCE HAS TO ALLOW IT (barracuda, #103 v2): the sentence leaves only when the request's key is exactly
 * `QUESTION_SET_CLIENT_KEY` AND this switch is exactly "true" on the instance. On the test AI that adds nothing to the key
 * (the OS sends `os-user:<id>`, built by the OS server from the session user, so an OS request never gets the field even
 * with the switch on); on every other instance (a later separate production AI, a developer machine) it stays closed by
 * default, and does not hang on a key name. Read per call; /health says whether it is on.
 */
export const DOSE_GUARD_DEBUG_ENV = "AI_DOSE_GUARD_DEBUG";

export const doseGuardDebugOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[DOSE_GUARD_DEBUG_ENV] === "true";

export const namesDoseSentenceTo = (clientKey: string | null, env: NodeJS.ProcessEnv = process.env): boolean =>
  clientKey === QUESTION_SET_CLIENT_KEY && doseGuardDebugOn(env);
