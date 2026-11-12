import { chatSettingsConfig, fetchChatSettings } from "./chat-settings.js";
import { colleagueOfferEnabled } from "./request-prefilter-answers.js";

/**
 * THE COLLEAGUE OFFER'S OS SETTING (card f5b8f7ba; acrobot 2026-11-12 49021): the Settings page's "Kollégai felajánlás" box is
 * read here, on the same reader and with the same cache as the contact request's switch (`contact-request-flow.ts`).
 *
 * THE ENVIRONMENT SWITCHES STAY THE GATE (the pre-filter AND `AI_CHAT_COLLEAGUE_OFFER`, `colleagueOfferEnabled`): with them off
 * there is no offer, whatever the OS says. With them on, the OS box decides; and WHEN THE OS CANNOT BE READ THE ENVIRONMENT DECIDES,
 * as it did before the box was read (acrobot 49021). That is the other direction from the contact request, which fails closed: the
 * offer is one sentence that asks for nothing, so an outage must not change what the chat says, while a contact request takes
 * personal data and must not be taken without a hand-over.
 */

interface Cached {
  value: boolean | null;
  until: number;
}
let cache: Cached | null = null;
const CACHE_MS = 60_000;
/** A failed read is remembered for a short while only, so a down OS is not asked on every message. */
const FAILURE_CACHE_MS = 10_000;

/** For the specs. */
export function resetColleagueOfferSettingCache(): void {
  cache = null;
}

/** The OS box: `true` or `false` as saved, `null` when it cannot be read (no configuration, a refusal, an outage, a bad body). */
export async function offerEnabledInOs(
  now: number = Date.now(),
  fetchImpl?: typeof fetch,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean | null> {
  if (cache && cache.until > now) return cache.value;
  const config = chatSettingsConfig(environment);
  if (!config) return null;
  const outcome = await fetchChatSettings({ config, fetchImpl });
  const value = outcome.ok ? outcome.view.offerEnabled : null;
  cache = { value, until: now + (outcome.ok ? CACHE_MS : FAILURE_CACHE_MS) };
  return value;
}

/** THE OFFER IS ON for this request: the environment's gate, then the OS box (the environment alone when the box cannot be read). */
export async function colleagueOfferActive(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  now: number = Date.now()
): Promise<boolean> {
  if (!colleagueOfferEnabled(environment)) return false;
  return (await offerEnabledInOs(now, fetchImpl, environment)) ?? true;
}
