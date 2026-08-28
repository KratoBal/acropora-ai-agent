/**
 * Turning one catalogue search into the block the model reads.
 *
 * WHY THIS IS A SEPARATE MODULE. The instruction text was assembled inline in
 * the chat route until now, and the one rule this change must not break is
 * that the model is never told two contradictory things at once. Keeping the
 * decision here - which of the two blocks goes in - means it can be asserted
 * in a test instead of being read off a route handler.
 *
 * THE THREE OUTCOMES ARE NOT TWO. `searchProducts` already distinguishes "the
 * catalogue answered with nothing" from "the search could not run", and its
 * own comment says why: the first is an answer about the catalogue, the second
 * is an outage, and a model that cannot tell them apart will confidently say
 * we carry nothing. This module carries that distinction through to the
 * prompt rather than flattening it at the last step.
 */

import { NO_PRODUCT_CONTEXT_INSTRUCTIONS } from "./no-product-context.js";
import type { ProductSearchOutcome } from "./product-search.js";

/** Opens and closes the data block. The model is told these are boundaries. */
export const PRODUCT_CONTEXT_OPEN = "<<<TERMEKADAT>>>";
export const PRODUCT_CONTEXT_CLOSE = "<<<TERMEKADAT VEGE>>>";

/**
 * What the model is told when the search ran and the catalogue had nothing.
 *
 * Deliberately NOT the same text as the outage case. "We looked and there is
 * nothing" is a fact about our range; "we could not look" is a fact about our
 * systems, and only the first one may be said out loud as an answer.
 */
export const EMPTY_RESULT_INSTRUCTIONS = [
  "A katalógusban rákerestünk arra, amit a vásárló kérdezett, és NEM TALÁLTUNK",
  "rá terméket. Ez a keresés eredménye, nem üzemzavar.",
  "",
  "Ettől még nem állíthatod, hogy nem tartunk ilyet: a keresés a kérdés",
  "szavaira épül, és egy termék más néven is szerepelhet. Amit mondhatsz: erre",
  "a keresésre nem jött találat, és hogy pontosabb megnevezéssel érdemes újra",
  "próbálni. A világról szóló tudásodat ettől függetlenül add meg."
].join("\n");

/**
 * What the model is told when the search itself failed.
 *
 * This is the case that must never look like an empty catalogue. The wording
 * says outage, and it points at the same limit as the no-context block: about
 * our range, our prices and our stock, say nothing at all.
 */
export const SEARCH_UNAVAILABLE_INSTRUCTIONS = [
  "A termékkeresés MOST NEM ÉRHETŐ EL, tehát ebben a beszélgetésben nem látod",
  "a katalógust. Ez üzemzavar, és NEM azt jelenti, hogy nem tartunk ilyet.",
  "",
  "Ezért a kínálatunkról, az árainkról és a készletünkről ne állíts semmit:",
  "sem igent, sem nemet. A világról szóló tudásodat add meg teljesen, és ha a",
  "kérdés a készletünkre irányult, mondd meg egy tagmondatban, hogy ezt most",
  "nem látod - de ne ezzel kezdd a választ."
].join("\n");

/**
 * The block itself: the projection, verbatim, between two markers.
 *
 * The projection travels as JSON and is NOT rewritten here. The OS versions
 * its own shape and sends a `projectionVersion` with every answer; restating
 * those fields in prose over here would be a second copy that drifts, and the
 * price and the stock would be exactly the values that drift first. The rule
 * the OS holds - price and stock are structured, never folded into text -
 * only survives if this side passes them through untouched.
 */
export function productContextInstructions(
  outcome: ProductSearchOutcome
): string {
  if (!outcome.ok) {
    return outcome.error === "product_search_not_configured"
      ? NO_PRODUCT_CONTEXT_INSTRUCTIONS
      : SEARCH_UNAVAILABLE_INSTRUCTIONS;
  }

  if (!hasAnyHit(outcome.result)) {
    return EMPTY_RESULT_INSTRUCTIONS;
  }

  return [
    "Az alábbi adatblokk a saját katalógusunkból való, erre a kérdésre keresve.",
    "Amit itt látsz, arról beszélhetsz: ez a mi termékadatunk.",
    "",
    "HÁROM SZABÁLY AZ ADATBLOKKRA:",
    "1. Az árat és a készletet ÚGY add vissza, ahogy itt áll. Ne kerekítsd, ne",
    "   számold át, és ne fogalmazd újra: a mezők azért strukturáltak, hogy ne",
    "   szöveggé váljanak.",
    "2. Ami NINCS a blokkban, arról továbbra sem tudsz semmit. Egy termék hiánya",
    "   itt nem bizonyítja, hogy nem tartjuk.",
    "3. Konkrét terméket továbbra sem ajánlasz megvételre, akkor sem, ha itt",
    "   szerepel. Leírni, összehasonlítani, magyarázni szabad.",
    "",
    PRODUCT_CONTEXT_OPEN,
    JSON.stringify(outcome.result, null, 2),
    PRODUCT_CONTEXT_CLOSE
  ].join("\n");
}

/**
 * Whether the projection carried anything at all.
 *
 * Written defensively because the shape is the OS's to change: this side only
 * asks whether a `hits` array exists and has entries, and treats anything it
 * cannot read as "no hits" rather than throwing inside a request.
 */
function hasAnyHit(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const hits = (result as { hits?: unknown }).hits;
  return Array.isArray(hits) && hits.length > 0;
}
