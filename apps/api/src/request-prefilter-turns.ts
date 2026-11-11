import { classifyRequest, type RecentTurn } from "./request-prefilter.js";

/**
 * THE TURN COUNT, THE OFF-TOPIC SERIES AND THE COLLEAGUE OFFER (Acropora OS card f5b8f7ba, slice 3; plan
 * `agents/nautilus/TERV-ai-eloszures-2026-08-27.md`, rows 18-24 and 31, fourth round: the offer's final shape, Balázs 2026-08-27
 * 20:31; the series threshold, Balázs 2026-11-11 08:51).
 *
 * BOTH NUMBERS COME FROM THE HISTORY THE ROUTE ALREADY LOADED, NOT FROM A STORED FIELD (row 31): there is no counter anywhere, so
 * there is nothing that can drift from the conversation. The history is the LAST TWENTY messages in time order (a sliding window:
 * `ORDER BY created_at DESC LIMIT 20`, reversed), and that is a property of both numbers, stated in the PR (row 24).
 *
 * THE OFFER IS ONE SENTENCE, ONCE, WITHOUT A QUESTION: after the fourth customer turn the model's answer gets "Ha szeretnéd, egy
 * kollégánk is segíthet a kérdésben." appended by local logic, with no model call of its own. It asks for nothing, so it stores and
 * forwards nothing and promises nothing (rows 19e, 20-20d of the plan are the later contact slice, not this one). `ONCE` rests on
 * ARITHMETIC, NOT ON A SEARCH FOR THE SENTENCE: it appears when the number of customer messages in the window is EXACTLY four.
 * With one assistant message per customer message the window holds ten or eleven customer messages from the tenth turn on, and the
 * count can never come back to four. THE DEPENDENCY, NAMED: one assistant message per customer message (row 19f, a route spec).
 *
 * THE OFF-TOPIC SERIES is replayed with the same classifier the gate used live: the customer's earlier messages, oldest first,
 * each judged with the conversation before it. A `block` extends the series, an `ask` is neutral (an unclear message is no
 * proof of anything), a `pass` ends it (row 22: one aquarium question resets it). At FIVE in a row the friendly template gives way
 * to a firmer one; still local, still no model call (row 21).
 */

/** The customer turn after which the offer is made: exactly this count, never "this or more" (the first four turns would behave
 * the same, only the fifth would show the difference). */
export const COLLEAGUE_OFFER_AT_TURN = 4;

/** The off-topic question in a row from which the firmer template is used. Balázs 2026-11-11 08:51. */
export const OFFTOPIC_SERIES_FIRM_AT = 5;

/** Balázs's default text (plan, fourth round). A sentence the customer may ignore: no question, no promise, no contact data. */
export const COLLEAGUE_OFFER =
  "Ha szeretnéd, egy kollégánk is segíthet a kérdésben.";

/**
 * WHAT THE MODEL IS TOLD ABOUT THE OFFER (barracuda's review of #71): a customer who answers the offer with "Igen, kérem" gets a
 * model answer (the topic is in the history), and the model sees its own previous answer with the offer sentence but knows nothing
 * about how a colleague is reached. Left alone it can invent an e-mail address, a telephone number or a promise. Until the contact
 * request exists (slice 4c, 4d) the honest answer is that this chat cannot arrange it, so the instruction says that and forbids the
 * invention. Added to the model's instructions ONLY while the offer is made (the same switch). Whether the model keeps to it is not
 * measured here: it needs a live call.
 */
export const COLLEAGUE_OFFER_FOLLOWUP_INSTRUCTIONS =
  "If the customer answers the offer of a colleague's help (for example 'yes, please'), say honestly that this chat cannot put " +
  "them in touch with a colleague or arrange a callback. Do not write any telephone number, e-mail address, opening hours, time " +
  "or name for reaching a colleague, and do not promise a callback or a reply. Offer to keep answering their question here.";

/**
 * Said to the fifth off-topic question in a row and the ones after it. A PROPOSAL, like the two of the answers module: Balázs's
 * wording replaces it here. Same constraints as the others: no value, no lookup, no external service named, not even as a type.
 */
export const PREFILTER_FIRM_BLOCK_ANSWER =
  "Ebben továbbra sem tudunk segíteni, és a következő, nem akvarisztikai kérdésben sem fogunk. " +
  "Ha a tengeri akvarisztikával vagy az Acropora kínálatával, rendeléseivel kapcsolatban van kérdésed, szívesen válaszolunk.";

type Turn = RecentTurn | { role: string; content: string };

const isCustomer = (turn: Turn): boolean => turn.role === "user";

/** The customer's turns in the history (the one being answered included): assistant rows are not turns (row 23). */
export function customerTurnCount(history: readonly Turn[]): number {
  return history.filter(isCustomer).length;
}

export const shouldOfferColleague = (turnCount: number): boolean =>
  turnCount === COLLEAGUE_OFFER_AT_TURN;

export const withColleagueOffer = (answer: string): string =>
  `${answer}\n\n${COLLEAGUE_OFFER}`;

/**
 * How many off-topic questions in a row end with THIS one, which the gate has just judged `block`. `earlier` is the history
 * without the message being answered. Returns at least 1.
 */
export function offTopicSeries(earlier: readonly RecentTurn[]): number {
  let series = 1;
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const turn = earlier[index];
    if (!isCustomer(turn)) continue;
    const { decision } = classifyRequest(turn.content, earlier.slice(0, index));
    if (decision === "pass") break;
    if (decision === "block") series += 1;
  }
  return series;
}
