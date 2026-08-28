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
  const state = classifyProductContext(outcome);

  // The failure branches are split by `outcome.ok` rather than by the state
  // alone, because that is what narrows the type for the block below. The
  // DECISION still comes from one place - `state` decides which of the two
  // failure texts is right - so the surface and the prompt cannot disagree.
  if (!outcome.ok) {
    return state === "not_configured"
      ? NO_PRODUCT_CONTEXT_INSTRUCTIONS
      : SEARCH_UNAVAILABLE_INSTRUCTIONS;
  }

  if (state === "empty") return EMPTY_RESULT_INSTRUCTIONS;

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

/**
 * Which of the four states this search ended in.
 *
 * EXTRACTED SO THAT THE PROMPT AND THE SURFACE CANNOT DISAGREE. The model is
 * told one of four things, and the test surface reports what the answer was
 * built from - and those two must be the same claim. Computed twice, they can
 * drift apart on a branch nobody re-reads, and then the surface says "no
 * catalogue" about an answer that had one. That is the failure this whole
 * change exists to prevent, so it must not be reintroduced one level down.
 */
export type ProductContextState =
  | "hits"
  | "empty"
  | "unavailable"
  | "not_configured";

export function classifyProductContext(
  outcome: ProductSearchOutcome
): ProductContextState {
  if (!outcome.ok) {
    return outcome.error === "product_search_not_configured"
      ? "not_configured"
      : "unavailable";
  }

  return hasAnyHit(outcome.result) ? "hits" : "empty";
}

/**
 * What the answer was built from, in the shape a surface can display.
 *
 * The brief asks for `descriptionSource` and every relevant source field to be
 * visible on the test surface, and the reason is not curiosity: a judgement
 * about an answer is only interpretable if the judge can see what the answer
 * had in front of it. An answer that invented a price and one that reported a
 * mirrored price read the same on the screen.
 *
 * Everything here is read defensively. The projection's shape belongs to the
 * OS, which versions it; this side reports what it can read and says null for
 * the rest, rather than throwing inside a request that already has an answer.
 */
export interface ProductContextSummary {
  state: ProductContextState;
  /** How many products the model was given. Null when it was given none. */
  hitCount: number | null;
  /** The OS's own version for the shape it sent, when it sent one. */
  projectionVersion: number | null;
  /**
   * Which description each hit came from, deduplicated. "acropora" means a
   * local edit is what the model read; "unas" means the mirrored text.
   */
  descriptionSources: string[];
}

export function productContextSummary(
  outcome: ProductSearchOutcome
): ProductContextSummary {
  const state = classifyProductContext(outcome);

  if (state !== "hits" || !outcome.ok) {
    return {
      state,
      hitCount: null,
      projectionVersion: null,
      descriptionSources: []
    };
  }

  const result = outcome.result as {
    hits?: unknown;
    projectionVersion?: unknown;
  };
  const hits = Array.isArray(result.hits) ? result.hits : [];

  const sources = new Set<string>();
  for (const hit of hits) {
    const source = (hit as { descriptionSource?: unknown })?.descriptionSource;
    if (typeof source === "string" && source.length > 0) sources.add(source);
  }

  return {
    state,
    hitCount: hits.length,
    projectionVersion:
      typeof result.projectionVersion === "number"
        ? result.projectionVersion
        : null,
    descriptionSources: [...sources].sort()
  };
}
