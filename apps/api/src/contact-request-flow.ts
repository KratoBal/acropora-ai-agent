import { fetchChatSettings, chatSettingsConfig } from "./chat-settings.js";
import { colleagueOfferEnabled } from "./request-prefilter-answers.js";
import { COLLEAGUE_OFFER } from "./request-prefilter-turns.js";
import { contactRequestConfig } from "./contact-request.js";

/**
 * THE CONTACT REQUEST IN THE CHAT (Acropora OS card f5b8f7ba, slices 4c and 4d; plan `exchange-out/ai-eloszures-4-szelet-terv-2026-11-11.md`
 * section 2 points 2 and 3, 2/b).
 *
 * THE SEQUENCE OF ONE REQUEST (plan 2 point 2, barracuda's 2nd and 3rd points): (1) the customer's message is the REPLY to the offer
 * (the previous assistant row carries `local_kind = 'contact_offer'`, a flag, not a search for the sentence) and holds a contact;
 * (2) the contact is handed to the OS; (3) ONLY after the OS says it recorded it, the stored message is masked; (4) ONLY then the
 * local answer says "forwarded". On any failure the local text claims no delivery and the raw value stays in the stored row (the
 * retention covers it), so a contact never disappears without a delivery. A contact typed WITHOUT the offer before it is no request
 * and the stored row is not touched (the model never sees it either way: slice 4c's input mask).
 *
 * THREE GATES, ALL MUST HOLD, each fails CLOSED: the pre-filter and the colleague offer switches (the offer is the only door to a
 * request), the contact switch `AI_CHAT_CONTACT_REQUEST` exactly `true` (OFF by default, like every gate of this service), the OS
 * setting `contactRequestEnabled` read from the OS (60 seconds cached; if the OS cannot be read the request is NOT offered, and a
 * reading that is not exactly `true` is no).
 *
 * THE CUSTOMER-FACING TEXTS BELOW ARE PROPOSALS (4d), awaiting Balázs, like the answers module's were: one place, replaced as they
 * stand. They are constraint-checked in the spec: no dash, no promise of a time or a person, nothing the delivery cannot do. The data
 * notice that belongs next to the offer is Balázs's and acrobot's text (the plan's 3. section), not mine.
 */
export const CONTACT_REQUEST_ENV = "AI_CHAT_CONTACT_REQUEST";

/** Exactly `true` turns it on. */
export const contactRequestSwitch = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[CONTACT_REQUEST_ENV] === "true";

/** The local answers are saved with this label: no model ran, and a judging surface must be able to tell it from the pre-filter's. */
export const CONTACT_REQUEST_MODEL_LABEL = "local-contact-request";

/** The value of `messages.local_kind` on the answer that carries the offer with the request for a contact. */
export const CONTACT_OFFER_KIND = "contact_offer";

/**
 * 4d, PROPOSAL: the offer becomes a request for a contact. It says what happens (the request is forwarded to a colleague, who may
 * use the contact), and nothing it cannot keep: no time, no person, no "immediately". Replaces the offer sentence only while the
 * contact request is on.
 */
export const CONTACT_OFFER =
  `${COLLEAGUE_OFFER} Ha szeretnéd, írd meg az e-mail-címedet vagy a telefonszámodat, és továbbítjuk a kérésedet egy kollégának, ` +
  "aki ezen az elérhetőségen jelentkezhet.";

/** 4d, PROPOSAL: said only after the OS recorded the request. States what was done, promises no time. */
export const CONTACT_FORWARDED_ANSWER =
  "Köszönjük, továbbítottuk a kérésedet a kollégáinknak.";

/** 4d, PROPOSAL: said when the hand-over failed. It claims nothing was delivered, and asks for nothing the customer cannot do. */
export const CONTACT_NOT_FORWARDED_ANSWER =
  "A kérésedet most nem sikerült továbbítanunk, ezért nem kaptuk meg az elérhetőségedet. Kérjük, próbáld meg később újra.";

/**
 * What the model is told while the contact request is on (replaces `COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS` then): the reply to the
 * offer that carries a contact is answered locally, so a reply that reaches the model carries none. It must ask for the contact
 * itself, in the customer's next message, and invent nothing about reaching a colleague.
 */
export const CONTACT_OFFER_FOLLOWUP_INSTRUCTIONS =
  "If the customer answers the offer of a colleague's help (for example 'yes, please') without giving an e-mail address or a " +
  "telephone number, ask them to write their e-mail address or telephone number in their next message, and say that the request is " +
  "then forwarded to a colleague. Do not write any telephone number, e-mail address, opening hours, time or name for reaching a " +
  "colleague, and do not promise a callback, a time or a reply. Offer to keep answering their question here.";

export const withContactOffer = (answer: string): string => `${answer}\n\n${CONTACT_OFFER}`;

interface Cached {
  value: boolean;
  until: number;
}
let cache: Cached | null = null;
const CACHE_MS = 60_000;
/** A failed read is remembered for a short while only, so a down OS is not asked on every message. */
const FAILURE_CACHE_MS = 10_000;

/** For the specs. */
export function resetContactRequestSettingsCache(): void {
  cache = null;
}

/**
 * The OS setting `contactRequestEnabled`, 60 seconds cached. FAILS CLOSED: unreadable, unauthorised, a bad body or no configuration is
 * `false`, never the last value (an old "on" must not keep a switched-off request alive, and the OS being down is no reason to take
 * a contact that cannot be handed over).
 */
export async function contactRequestEnabledInOs(
  now: number = Date.now(),
  fetchImpl?: typeof fetch,
  environment: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (cache && cache.until > now) return cache.value;
  const config = chatSettingsConfig(environment);
  if (!config) return false;
  const outcome = await fetchChatSettings({ config, fetchImpl });
  const value = outcome.ok && outcome.view.contactRequestEnabled === true;
  cache = { value, until: now + (outcome.ok ? CACHE_MS : FAILURE_CACHE_MS) };
  return value;
}

/**
 * THE CONTACT FLOW IS ON for this request: the offer switches, the contact switch, a configured hand-over (base URL and write token),
 * and the OS setting. Evaluated once per request and used for both halves (making the offer, and reading the reply), so the two never
 * disagree within a request.
 */
export async function contactFlowActive(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
  now: number = Date.now()
): Promise<boolean> {
  if (!colleagueOfferEnabled(environment)) return false;
  if (!contactRequestSwitch(environment)) return false;
  if (!contactRequestConfig(environment)) return false;
  return contactRequestEnabledInOs(now, fetchImpl, environment);
}
