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
 * A sentence without a period word (a pack's reach: "500 ml 10 000 literhez
 * elegendő") is not a dose statement, the same rule as the OS's own reader.
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
const AMOUNT = new RegExp(
  `${NUM}\\s*(ml|milliliter\\w*|millilitre\\w*|drops?|csepp\\w*|tropfen)(?![a-z])`,
  "g"
);
// a gallon counts as a volume, and never matches a fact: the OS doses are in litres
const VOLUME = new RegExp(`${NUM}\\s*(l|ltr|liter\\w*|litre\\w*|gallon\\w*|gal)(?![a-z])`, "g");
const PERIOD: Record<Dose["period"], RegExp> = {
  day: /\b(?:daily|a day|per day|every day|taglich|pro tag|naponta|naponkent|napi|minden nap)\b|\/\s*(?:day|nap|tag)\b/,
  week: /\b(?:weekly|a week|per week|every week|wochentlich|pro woche|hetente|hetenkent|heti|minden heten)\b|\/\s*(?:week|het|woche)\b/
};

/** The answer's sentences; a decimal point is no end. */
function sentences(text: string): string[] {
  return text.split(/(?<!\d)[.!?;](?!\d)|\n/).filter((s) => s.trim() !== "");
}

export type DoseGuardResult =
  | { ok: true; doseStatements: number }
  | { ok: false; reason: "NO_FIXED_DOSE" | "DOSE_NOT_IN_CATALOGUE"; sentence: string };

export function guardAnswerDoses(
  answer: string,
  outcome: ProductSearchOutcome
): DoseGuardResult {
  const facts = fixedDosesOf(outcome);
  let statements = 0;
  for (const raw of sentences(answer)) {
    const s = fold(raw);
    const amounts = [...s.matchAll(AMOUNT)];
    const volumes = [...s.matchAll(VOLUME)];
    const periods = (Object.keys(PERIOD) as Dose["period"][]).filter((p) => PERIOD[p].test(s));
    if (amounts.length === 0 || volumes.length === 0 || periods.length === 0) continue;
    statements++;
    if (facts.length === 0) return { ok: false, reason: "NO_FIXED_DOSE", sentence: raw.trim() };
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
    if (!matches) return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", sentence: raw.trim() };
  }
  return { ok: true, doseStatements: statements };
}
