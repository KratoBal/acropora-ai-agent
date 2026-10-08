/**
 * The water-measurement product recommendation (Acropora OS card 2b3983e1,
 * step 2 of `exchange/vizmeres-ajanlas/terv-2026-10-08.md`).
 *
 * The Acropora OS sends the measurement's out-of-range values, a list of
 * candidate products and up to three approved example pairs; this service
 * returns a Hungarian draft that refers to products ONLY as
 * `{{termek:<productId>}}`. A colleague edits and approves the draft in the
 * OS before any customer sees it.
 *
 * The request shape is the OS's `MeasurementRecommendationAiRequest`
 * (acropora-os `apps/api/src/aquariums/recommendation/
 * measurement-recommendation.contract.ts`), and the answer is its
 * `MeasurementRecommendationAiResponse`: `{ text, model }`.
 *
 * TWO RULES ARE HELD HERE IN CODE, NOT ONLY IN THE PROMPT:
 * - a product id outside the candidate list never leaves this service: the
 *   answer is filtered, whatever the model wrote;
 * - with no candidates, the answer says there is no product to recommend.
 */

/** The OS's product token: a cuid-like id of letters, digits, `_` and `-`. */
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Any token-shaped text, valid or not, so a malformed one is removed too. */
const ANY_PRODUCT_TOKEN = /\{\{termek:([^}]*)\}\}/g;

export const MAX_DEVIATIONS = 40;
export const MAX_CANDIDATES = 300;
export const MAX_EXAMPLES = 3;

/** Said when there is nothing on the list to recommend. */
export const NO_PRODUCT_SENTENCE =
  "Ehhez a méréshez nincs ajánlható termék a listán.";

export interface RecommendationDeviation {
  parameterCode: string;
  measured: number;
  unit: string;
  min?: number;
  max?: number;
  status: "WARN" | "ALERT";
  direction: "LOW" | "HIGH";
  trend: string | null;
}

export interface RecommendationCandidate {
  productId: string;
  name: string;
  category: string;
  effects: { parameterCode: string; direction: "EMEL" | "CSOKKENT" }[];
  basis: "CATEGORY" | "JEV";
  evidenceRef?: string;
}

export interface RecommendationExample {
  deviations: RecommendationDeviation[];
  aiDraft: string;
  approvedText: string;
}

export interface MeasurementRecommendationRequest {
  waterType: string | null;
  volumeLiters: number | null;
  deviations: RecommendationDeviation[];
  candidates: RecommendationCandidate[];
  examples: RecommendationExample[];
}

export type ParsedRequest =
  | { ok: true; request: MeasurementRecommendationRequest }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

function deviationOf(value: unknown): RecommendationDeviation | null {
  if (!isRecord(value)) return null;
  const { parameterCode, measured, unit, min, max, status, direction, trend } =
    value;
  if (
    !text(parameterCode, 40) ||
    !parameterCode ||
    !finite(measured) ||
    !text(unit, 20) ||
    (min !== undefined && !finite(min)) ||
    (max !== undefined && !finite(max)) ||
    (status !== "WARN" && status !== "ALERT") ||
    (direction !== "LOW" && direction !== "HIGH") ||
    (trend !== null && !text(trend, 20))
  )
    return null;
  return {
    parameterCode,
    measured,
    unit,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    status,
    direction,
    trend: trend ?? null
  };
}

function candidateOf(value: unknown): RecommendationCandidate | null {
  if (!isRecord(value)) return null;
  const { productId, name, category, effects, basis, evidenceRef } = value;
  if (
    !text(productId, 64) ||
    !PRODUCT_ID.test(productId) ||
    !text(name, 300) ||
    !text(category, 300) ||
    !Array.isArray(effects) ||
    (basis !== "CATEGORY" && basis !== "JEV") ||
    (evidenceRef !== undefined && !text(evidenceRef, 1000))
  )
    return null;
  const parsedEffects = effects.map((effect) =>
    isRecord(effect) &&
    text(effect.parameterCode, 40) &&
    (effect.direction === "EMEL" || effect.direction === "CSOKKENT")
      ? {
          parameterCode: effect.parameterCode,
          direction: effect.direction as "EMEL" | "CSOKKENT"
        }
      : null
  );
  if (parsedEffects.some((effect) => effect === null)) return null;
  return {
    productId,
    name,
    category,
    effects: parsedEffects as RecommendationCandidate["effects"],
    basis,
    ...(evidenceRef !== undefined ? { evidenceRef } : {})
  };
}

/**
 * The request, read field by field. Anything outside the agreed shape is a
 * 400 with the field named, so a drift between the OS and this service shows
 * as a clear refusal rather than a vague answer.
 */
export function parseRecommendationRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };
  const { waterType, volumeLiters, deviations, candidates, examples } = body;
  if (waterType !== null && !text(waterType, 40))
    return { ok: false, error: "waterType must be a string or null" };
  if (volumeLiters !== null && !finite(volumeLiters))
    return { ok: false, error: "volumeLiters must be a number or null" };
  if (
    !Array.isArray(deviations) ||
    deviations.length === 0 ||
    deviations.length > MAX_DEVIATIONS
  )
    return {
      ok: false,
      error: `deviations must hold 1 to ${MAX_DEVIATIONS} items`
    };
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES)
    return {
      ok: false,
      error: `candidates must hold at most ${MAX_CANDIDATES} items`
    };
  if (!Array.isArray(examples) || examples.length > MAX_EXAMPLES)
    return {
      ok: false,
      error: `examples must hold at most ${MAX_EXAMPLES} items`
    };
  const parsedDeviations = deviations.map(deviationOf);
  if (parsedDeviations.some((d) => d === null))
    return { ok: false, error: "a deviation is malformed" };
  const parsedCandidates = candidates.map(candidateOf);
  if (parsedCandidates.some((c) => c === null))
    return { ok: false, error: "a candidate is malformed" };
  const parsedExamples: RecommendationExample[] = [];
  for (const example of examples) {
    if (
      !isRecord(example) ||
      !Array.isArray(example.deviations) ||
      !text(example.aiDraft, 10_000) ||
      !text(example.approvedText, 10_000)
    )
      return { ok: false, error: "an example is malformed" };
    const exampleDeviations = example.deviations.map(deviationOf);
    if (exampleDeviations.some((d) => d === null))
      return { ok: false, error: "an example deviation is malformed" };
    parsedExamples.push({
      deviations: exampleDeviations as RecommendationDeviation[],
      aiDraft: example.aiDraft,
      approvedText: example.approvedText
    });
  }
  return {
    ok: true,
    request: {
      waterType: waterType ?? null,
      volumeLiters: volumeLiters ?? null,
      deviations: parsedDeviations as RecommendationDeviation[],
      candidates: parsedCandidates as RecommendationCandidate[],
      examples: parsedExamples
    }
  };
}

/** What the model is told. Answer in Hungarian, formally, to the customer. */
export const MEASUREMENT_RECOMMENDATION_INSTRUCTIONS = [
  "You are the Acropora marine aquarium specialist. From one water measurement's out-of-range values you write a short recommendation in Hungarian, addressing the customer formally (magázva). A colleague reviews and approves it before the customer sees it.",
  "Rules:",
  "- Write only about the deviations given. Do not invent measurements, causes you cannot support, or diagnoses.",
  "- Recommend products ONLY from the candidate list, and refer to a product ONLY as {{termek:<productId>}} with its exact productId. Never write a product's name, a brand or a link yourself: the system puts them in.",
  `- If the candidate list is empty, or no candidate fits a deviation, write exactly: "${NO_PRODUCT_SENTENCE}" and give general steps without products.`,
  "- Never calculate or invent a dose. If dosing matters, say to follow the product's own dosing instructions.",
  "- A candidate with an empty effects list has no manufacturer claim behind it: do not state that it moves the parameter for sure.",
  "- At most 8 sentences. No greeting and no signature.",
  "- If example pairs are given: each shows a draft (aiDraft) and what a colleague approved (approvedText). Follow the approved versions' content decisions and style; the difference shows what the colleagues corrected."
].join("\n");

/** The model's input: the request as data, without anything about a person. */
export function measurementRecommendationInput(
  request: MeasurementRecommendationRequest
): string {
  return JSON.stringify({
    waterType: request.waterType,
    volumeLiters: request.volumeLiters,
    deviations: request.deviations,
    candidates: request.candidates.map((c) => ({
      productId: c.productId,
      name: c.name,
      category: c.category,
      effects: c.effects,
      basis: c.basis
    })),
    examples: request.examples
  });
}

/**
 * THE SERVER-SIDE GUARD. Every product token whose id is not on the candidate
 * list is removed, malformed ones too, whatever the model wrote; and with no
 * candidates at all, the answer states that there is nothing to recommend.
 * The removed ids are reported so a drift is visible, not silent.
 */
export function guardRecommendationText(
  text: string,
  candidateIds: ReadonlySet<string>
): { text: string; removedProductIds: string[] } {
  const removed: string[] = [];
  const kept = text.replace(ANY_PRODUCT_TOKEN, (token, id: string) => {
    if (PRODUCT_ID.test(id) && candidateIds.has(id)) return token;
    removed.push(id);
    return "";
  });
  let cleaned = kept
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
  if (
    candidateIds.size === 0 &&
    !cleaned.toLowerCase().includes(NO_PRODUCT_SENTENCE.toLowerCase())
  )
    cleaned = `${NO_PRODUCT_SENTENCE}${cleaned ? ` ${cleaned}` : ""}`;
  return { text: cleaned, removedProductIds: removed };
}
