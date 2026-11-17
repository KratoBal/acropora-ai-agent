import type { ProductSearchOutcome } from "./product-search.js";

/**
 * NO DOSE LEAVES THAT THE MANUFACTURER DID NOT GIVE (Acropora OS card 85c38ab1;
 * barracuda on #42: the prompt is not a protection). The answer the customer
 * gets is read here, and every dose statement in it - an amount (ml or drops),
 * a water volume and a period, in one sentence - must be a FIXED dose of a hit:
 * the same amount, unit, volume and period, as the OS sent it in `knowledge`.
 * A recalculated, rounded or invented dose fails, and so does a dose when the
 * catalogue gave none. The answer is then replaced by a sentence that sends the
 * customer to the label or a colleague; the reason is logged, not shown.
 *
 * WIDE, because it is an outgoing guard (barracuda, #43): every sentence with an
 * amount is a dose statement, and it passes only with its amount, unit, volume
 * AND period all in it, matching. A sentence about the pack ("az 500 ml-es
 * flakon 10 000 literhez elegendő", with no period) is not a dose; an
 * interpretable unit (capful, spoon, gram, "adag") or a number with no unit,
 * next to a volume or a period, never leaves. Every exception is a way out, so
 * each is one a dose sentence cannot meet.
 */

export const DOSE_GUARD_FALLBACK =
  "Erre a termékre a pontos adagolást most nem tudom biztonsággal megadni. Kérjük, nézze meg a termék címkéjét, vagy kérdezze kollégánkat, szívesen segít.";

interface Dose {
  amount: string;
  unit: "ml" | "drop";
  volume: string;
  period: "day" | "week";
}

const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const num = (value: string) => String(Number(value.replace(",", ".")));

/** The OS's dose form: `1 drop/100 L/day`, `2 ml/100 L, 2-3/week`. */
const FACT_DOSE =
  /^(\d+(?:\.\d+)?) (ml|drop)\/(\d+(?:\.\d+)?) L(?:\/(day|week)|, \d+(?:-\d+)?\/(day|week))$/;

/** The FIXED doses the hits carry. */
export function fixedDosesOf(outcome: ProductSearchOutcome): Dose[] {
  if (!outcome.ok) return [];
  const hits = (outcome.result as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];
  const doses: Dose[] = [];
  for (const hit of hits) {
    const knowledge = (hit as { knowledge?: unknown })?.knowledge;
    if (!Array.isArray(knowledge)) continue;
    for (const fact of knowledge as { field?: unknown; value?: unknown }[]) {
      if (fact?.field !== "dosing" || typeof fact.value !== "string") continue;
      const m = FACT_DOSE.exec(fact.value);
      if (!m) continue;
      doses.push({
        amount: num(m[1]!),
        unit: m[2] as Dose["unit"],
        volume: num(m[3]!),
        period: (m[4] ?? m[5]) as Dose["period"]
      });
    }
  }
  return doses;
}

const NUM = "(?<![\\d.,])(\\d+(?:[.,]\\d+)?)";
// only the adjective suffix is no amount ("500 ml-es flakon"): a case ending
// ("5 ml-t", "2 ml-rel") is the most common Hungarian dose (barracuda, #43)
const AMOUNT = new RegExp(
  `${NUM}\\s*(ml|milliliter\\w*|millilitre\\w*|drops?|csepp\\w*|tropfen)(?![a-z])(?!-(?:e|o|a)s\\b)`,
  "g"
);
// a gallon counts as a volume, and never matches a fact: the OS doses are in litres
const VOLUME = new RegExp(`${NUM}\\s*(l|ltr|liter\\w*|litre\\w*|gallon\\w*|gal)(?![a-z])`, "g");
const PERIOD: Record<Dose["period"], RegExp> = {
  day: /\b(?:daily|a day|per day|every day|taglich|pro tag|naponta|naponkent|napi|minden nap)\b|\/\s*(?:day|nap|tag)\b/,
  week: /\b(?:weekly|a week|per week|every week|wochentlich|pro woche|hetente|hetenkent|heti|minden heten)\b|\/\s*(?:week|het|woche)\b/
};

/** A unit a person has to interpret, next to a number: never a dose that may leave. */
const OTHER_UNIT =
  /\d\s*(?:capful|caps?\b|scoops?|spoons?|teaspoons?|tablespoons?|tsp\b|g\b|gramm?\w*|grams?\b|kupak\w*|merokanal\w*|kanal\w*|messloffel|loffel|adag\w*|doses?\b|portions?\b|pumps?\b|pumpa\w*|tablet\w*|kapszul\w*)/;

/**
 * A number with no unit: bare, or with an accusative ending ("adjon 3-at
 * naponta"). Next to a period word it is a dose the guard cannot check, but
 * only as a THING GIVEN: with a dosing verb, or in the accusative (see
 * `isGivenCount`).
 *
 * THE FREQUENCY SUFFIX IS NO BARE COUNT ("naponta 2-3-szor pótolja", "5-ször", "2-szori"): it says how many TIMES,
 * not how much is given. The MULTIPLIER adjective ("2-szeres", "1,5-szoros adag") multiplies an amount and stays a count
 * (barracuda, #101 v2). The third question-set run lost the ATO answer to exactly this: "-szor" passed as a
 * bare count, and "pótolja" (the evaporated water) as a dosing verb. ONLY this suffix: "-ra/-re" (a target, "napi
 * 3-ra") and "-val/-vel/-mal/-mel" (a difference, "2-vel többet") carry an amount and stay counts (barracuda, #101).
 * After `fold` the suffix reads "-szor" or "-szer". THE TIMES SIGN "×" ("naponta 1-2× pótolsz") is the same frequency written as a symbol: "2x"
 * and "2-szor" were never a bare count, "2×" was, and the question-set run of 2026-11-17 18:00 UTC lost an answer to it (card 15e38019).
 */
const BARE_COUNT = new RegExp(`${NUM}(?!\\d|[.,]\\d)(?:-(?:a|e|o)?t\\b|(?!\\s*[a-z%\u00b0\u00d7]|-sz[eo]r(?![eo]s)))`);

/**
 * THE KIND OF THE SENTENCE, NOT THE PRODUCT IN IT (t-20261116-adagolasi-or-szukites; barracuda 53718, acrobot 53719).
 * The first question-set run on the test AI lost six of fourteen general answers to this branch (ATO, nitrate testing,
 * lighting, a skimmer's sizing: "napi 8-10 órás megvilágítás", "hetente 1-2 alkalommal mérd"). A dose without a product
 * name is still a dose, so the guard is NOT narrowed to a product context; a bare number next to a period is a dose only
 * when something is GIVEN: a dosing verb in the sentence, or the number in the accusative ("adjon 3-at"), OR a water
 * volume in the same sentence ("Az adag 100 literenként napi 2.", "Hetente 1 jut 100 literre": an amount per volume is
 * one of the strongest dose marks, with or without a verb; barracuda, #99). A bare volume, a measured value and how
 * often to measure are not.
 */
const DOSING_VERB =
  /\b(?:adagol\w*|adj(?:on|al|alok|atok|anak|a)?|add|tegy\w*|tegyen|csepegtes\w*|cseppents\w*|onts\w*|ontsd|potol\w*|potold|dose|dosing|give|gib|geben|dosier\w*)\b/;
const ACCUSATIVE_COUNT = new RegExp(`${NUM}-(?:a|e|o)?t\\b`);
const isGivenCount = (s: string) => DOSING_VERB.test(s) || ACCUSATIVE_COUNT.test(s);

/**
 * AN AMOUNT PER VOLUME ("100 literenként", "100 literre", "100 literhez"): with a period in the sentence, ANY other number
 * is a dose, even one followed by a word ("Hetente 1 jut 100 literre": the bare-count pattern sees no bare number
 * there, and main let it through before this change too; barracuda, #99). The adjective ("200 literes akvárium") is no
 * rate and stays out.
 */
const PER_VOLUME = new RegExp(`${NUM}\\s*(?:l|ltr|liter|litre)-?(?:enkent|re|ra|hez)\\b`);

/**
 * A NUMBER RANGE IS ONE NUMBER: "8-10 órás", "1-2 alkalommal", "5–10 ppm". Read as it stands, the range's first number
 * has no unit after it and looks like a bare count; the range carries its unit on its upper bound, which is what is
 * kept. A hyphen before a letter ("3-at") is no range and stays.
 */
const RANGE = /(?<![\d.,])\d+(?:[.,]\d+)?\s*[-\u2013\u2014]\s*(?=\d)/g;

/**
 * THE MARK OF A DOSE SENTENCE IS THE UNIT'S WORD, NOT THE NUMBER (barracuda,
 * #43 v3): "egy csepp", "három cseppet", "pár ml-t" carry no digit. A unit
 * word next to a volume or a period makes the sentence a dose statement, and
 * one without a digit amount can never match. "adag" only as a count
 * ("adagot"), not "adagolás"; "dose" is a verb too, so it needs a number.
 * THE PLURAL NOMINATIVE "pumpák" IS THE EQUIPMENT NOUN ("hordók, pumpák, keverőtartály"), not a dose: nothing is dosed in the plural nominative, and
 * the question-set run of 2026-11-17 17:45 UTC lost an answer to it (card 15e38019). "pumpa", "pumpát", "pumpával" and the plural
 * accusative stay unit words; with a digit the unit is `OTHER_UNIT`'s and is not touched.
 */
const UNIT_WORD =
  /\b(?:ml|milliliter\w*|millilitre\w*|drops?|csepp\w*|tropfen|capful\w*|caps?|scoops?|spoons?|teaspoons?|tablespoons?|tsp|g|gramm?\w*|grams?|kupak\w*|merokanal\w*|kanal\w*|messloffel|loffel|adag(?:ot|ok|okat|ban|nyi)?|portions?|pumps?|pumpa(?!k\b)\w*|tablet\w*|kapszul\w*)\b/;

/**
 * The pack's reach or content, not a dose: a PACK NOUN only. "elég", "enough",
 * "reicht" are measure words a dose sentence uses too ("3 csepp elég";
 * barracuda, #43 v4), so they let nothing through.
 */
const REACH =
  /\b(?:bottles?|flasche|flakon\w*|uveg\w*|kiszereles\w*|tartalom|inhalt|contents?)\b/;

/**
 * A LIST NUMBER AT A LINE'S START IS NO AMOUNT ("1. Egy hétig kézzel pótold ...", "2) Hetente ..."): a number of one or two digits, a point or
 * a bracket, a space and then a LETTER (or the bold mark), after the bullet if there is one. A decimal point has no space after it ("1.5 ml"),
 * and a number followed by another digit or a unit is no marker, so an amount or a given count stays what it was. Measured on the main: the
 * marker counted as the bare count of the sentence and, next to "naponta" and "pótol-", made a given-count (card 15e38019).
 */
const LIST_MARKER = /^\s*(?:[-*\u2022]\s*)*\d{1,2}[.)]\s+(?=[a-z*_])/;

/** The answer's sentences; a decimal point is no end. */
function sentences(text: string): string[] {
  return text.split(/(?<!\d)[.!?;](?!\d)|\n/).filter((s) => s.trim() !== "");
}

/**
 * THE SIZE OF AN ANSWER, TWO NUMBERS AND NO TEXT (task t-20261117-csere-elotti-meret; acrobot 55186): how long it was and how many sentences it had,
 * counted the way the guard counts them. For the question-set report only, to measure how much a replacement throws away.
 */
export function answerSize(answer: string): { chars: number; sentences: number } {
  return { chars: answer.length, sentences: sentences(answer).length };
}

/** Which rule refused the answer: the reason says what is wrong, the rule says which reading found it. */
export type DoseGuardRule =
  | "other-unit"
  | "given-count"
  | "per-volume-count"
  | "no-fixed-dose"
  | "not-in-catalogue";

export type DoseGuardResult =
  | { ok: true; doseStatements: number }
  | {
      ok: false;
      reason: "NO_FIXED_DOSE" | "DOSE_NOT_IN_CATALOGUE";
      rule: DoseGuardRule;
      sentence: string;
    };

export function guardAnswerDoses(
  answer: string,
  outcome: ProductSearchOutcome
): DoseGuardResult {
  const facts = fixedDosesOf(outcome);
  let statements = 0;
  for (const raw of sentences(answer)) {
    const s = fold(raw).replace(LIST_MARKER, "").replace(RANGE, "");
    const amounts = [...s.matchAll(AMOUNT)];
    const volumes = [...s.matchAll(VOLUME)];
    const periods = (Object.keys(PERIOD) as Dose["period"][]).filter((p) => PERIOD[p].test(s));
    // AN OUTGOING GUARD READS WIDE (barracuda, #43): what it does not recognise
    // leaves. Any amount, and any unit word next to a volume or a period, is a
    // dose statement (a pack's reach without a period aside), and it passes
    // only as a FULL, digit match below.
    if (OTHER_UNIT.test(s) && (volumes.length > 0 || periods.length > 0))
      return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", rule: "other-unit", sentence: raw.trim() };
    const rest = s.replace(VOLUME, " ");
    if (periods.length > 0 && amounts.length === 0) {
      if (BARE_COUNT.test(rest) && isGivenCount(s))
        return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", rule: "given-count", sentence: raw.trim() };
      if ((BARE_COUNT.test(rest) && volumes.length > 0) || (PER_VOLUME.test(s) && /\d/.test(rest)))
        return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", rule: "per-volume-count", sentence: raw.trim() };
    }
    // a pack's reach stands without a period; with one ("elég naponta 3 csepp")
    // the sentence is a dose and needs the full match (barracuda, #43)
    const dose =
      amounts.length > 0 ||
      (UNIT_WORD.test(s) && (volumes.length > 0 || periods.length > 0));
    if (!dose || (REACH.test(s) && periods.length === 0)) continue;
    statements++;
    if (facts.length === 0)
      return { ok: false, reason: "NO_FIXED_DOSE", rule: "no-fixed-dose", sentence: raw.trim() };
    const matches =
      amounts.length === 1 &&
      volumes.length === 1 &&
      periods.length === 1 &&
      facts.some(
        (f) =>
          f.amount === num(amounts[0]![1]!) &&
          f.unit === (/^(?:ml|milli)/.test(amounts[0]![2]!) ? "ml" : "drop") &&
          /^(?:l|ltr|liter|litre)/.test(volumes[0]![2]!) &&
          f.volume === num(volumes[0]![1]!) &&
          f.period === periods[0]
      );
    if (!matches)
      return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", rule: "not-in-catalogue", sentence: raw.trim() };
  }
  return { ok: true, doseStatements: statements };
}
