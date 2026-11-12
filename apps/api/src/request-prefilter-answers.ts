import type { PrefilterDecision } from "./request-prefilter.js";
import {
  OFFTOPIC_SERIES_FIRM_AT,
  PREFILTER_FIRM_BLOCK_ANSWER
} from "./request-prefilter-turns.js";

/**
 * THE LOCAL ANSWERS OF THE PRE-FILTER AND ITS SWITCH, IN ONE PLACE (Acropora OS card f5b8f7ba, slice 2).
 *
 * THE TEXTS BELOW ARE A PROPOSAL, NOT BALÁZS'S TEXT: the wording of the `block` and `ask` answers is his (the plan's open list),
 * and acrobot carries the proposal to him in one line. THE CODE DOES NOT WAIT FOR IT: both texts are constants of this file and
 * nothing else in the service holds them, so the approved wording replaces them here and nowhere else (and a later change to read
 * them from the OS Settings, which Balázs asked for the contact recipient, keeps this module as the one place that decides).
 *
 * WHAT A LOCAL ANSWER MUST NEVER DO (matrix row 17, Balázs 2026-08-27 20:14), each asserted by the spec on both texts:
 *  - state a value (a temperature, a number): the gate does not know the weather and does not look it up;
 *  - suggest that anything was looked up;
 *  - NAME AN EXTERNAL SERVICE, EVEN AS A TYPE ("ebben nem tudunk segíteni, és ne nevezzünk meg semmilyen külső szolgáltatást,
 *    még típusként sem"): no weather service, no search engine, no website.
 *
 * Hungarian only, like the word lists of `request-prefilter.ts`: a message in another language with none of its terms asks in
 * Hungarian. The service is behind the OS test chat today; a language-aware gate is its own slice.
 */

/** Said to a question that is clearly about another world (`block`). Plural: Balázs's own wording is "nem tudunk segíteni". */
export const PREFILTER_BLOCK_ANSWER =
  "Ebben sajnos nem tudunk segíteni: a tengeri akvarisztikával és az Acropora kínálatával, rendeléseivel kapcsolatos kérdésekre válaszolunk. " +
  "Írd meg nyugodtan, ha az akváriumodról, a korallokról vagy a rendelésedről van kérdésed.";

/** Said when the message does not say what it is about (`ask`): ONE clarifying question, the same for every unclear message. */
export const PREFILTER_ASK_ANSWER =
  "Nem teljesen világos, mire gondolsz. A tengeri akvarisztikával vagy az Acropora kínálatával, rendelésével kapcsolatos kérdésre szeretnél választ? " +
  "Írd le kérlek egy kicsit részletesebben, miről van szó.";

/** The model label saved with a local answer: no model ran, and a judging surface must be able to tell. */
export const PREFILTER_MODEL_LABEL = "local-prefilter";

/**
 * `offTopicSeries` is how many off-topic questions in a row end with this one (slice 3); from `firmAt` on the firmer text is used.
 * `firmAt` is the OS setting (`offtopic-threshold.ts`), Balázs's 5 when it cannot be read.
 */
export function localAnswerFor(
  decision: Exclude<PrefilterDecision, "pass">,
  offTopicSeries = 1,
  firmAt = OFFTOPIC_SERIES_FIRM_AT
): string {
  if (decision === "ask") return PREFILTER_ASK_ANSWER;
  return offTopicSeries >= firmAt
    ? PREFILTER_FIRM_BLOCK_ANSWER
    : PREFILTER_BLOCK_ANSWER;
}

/** The switch: exactly `true` turns the pre-filter on. OFF by default (the first state of every gate of this service). Read per call. */
export const PREFILTER_ENV = "AI_CHAT_PREFILTER";

export const prefilterEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[PREFILTER_ENV] === "true";

/**
 * THE COLLEAGUE OFFER HAS ITS OWN SWITCH, OFF BY DEFAULT (acrobot 2026-11-11 10:38, on barracuda's review of #71): a customer who
 * answers the offer with "Igen, kérem" gets a model answer, and the model does not know how a colleague is reached, so it could
 * invent an address or a promise. The offer is made again only with the contact request (slices 4c and 4d). It needs BOTH switches:
 * the pre-filter on AND this one exactly `true`. Read per call.
 */
export const COLLEAGUE_OFFER_ENV = "AI_CHAT_COLLEAGUE_OFFER";

export const colleagueOfferEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  prefilterEnabled(env) && env[COLLEAGUE_OFFER_ENV] === "true";
