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
 * A DIGIT THAT STANDS AFTER A LETTER IS PART OF A NAME, NOT A COUNT: "NO3-PO4", "CO2", "PO4" (the lookbehind `(?<![a-z])`, after `fold`). The 21:15 UTC run
 * lost an answer to "NO3-PO4" next to "heti" and "szénforrás-adagolás": the formula's "3" was a bare count and "adagolás" a dosing verb (card 89a6ba86).
 */
const BARE_COUNT = new RegExp(`(?<![a-z])${NUM}(?!\\d|[.,]\\d)(?:-(?:a|e|o)?t\\b|(?!\\s*[a-z%\u00b0\u00d7]|-sz[eo]r(?![eo]s)))`);

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
/**
 * A DOSE IN LITRES (acrobot 58977): "Napi 2 liter kalkwasser-oldatot adagolj" carries no ml or drop and no bare count, and main let it through. A litre
 * amount is never a catalogue dose (the OS doses are ml or drops per litres), so a water volume with a period and a STRONG dosing verb (adagol-,
 * csepegtet-, cseppent-, dose, dosier-) is a dose that does not match. The weak verbs stay out: "pótol" is how the evaporated water is replaced
 * ("ha napi 3 litert pótolsz"), and "add"/"tegyél" name the top-off and the water change. THE WATER ITSELF IS NO DOSE: a volume whose noun, right
 * after it (or after one or two words: "2 liters of RO water"), is water or evaporation ("napi 2 liter vizet adagol az ATO", "2 liter RO-vizet", "párolgást") stays out. "water" and "wasser" only as a
 * whole word: "Kalkwasser" or "Seewasser-Konzentrat" is the dose, not the water. THE SIZE OF A TANK IS NO AMOUNT: the adjective "3000 literes rendszer" is not read as a litre
 * amount here, and "adagoló" (the device, "automata adagolók") is no verb; the first version stopped one stored answer on exactly these two. NOR IS
 * THE VOLUME A DOSE IS FOR: "100 literre", "100 literhez", "100 literenként" is a rate's water volume, read by `PER_VOLUME`, not a litre amount. Measured before the change on
 * the 254 stored question-set answers (12 274 sentences): one sentence met volume, period and a strong verb, and its volume was water.
 * THE WATER IS ONLY PLAIN WATER, AND A NAMED ADDITIVE OPENS THE RULE (barracuda on #134): the first water noun was "[a-z-]*viz", so "mészvizet" (the
 * Hungarian name of Kalkwasser) passed as water, and the two-word window read a target as the volume's noun ("2 liter kalkwassert a vízbe adagolj").
 * The water noun is now "víz" at the word's start or after a plain-water prefix (RO, ozmózis, desztillált, csap, édes, tiszta, feltöltő), and NOT a
 * target ("vízbe", "vízhez", "vízben", "vízre"). And a sentence that names an ADDITIVE (kalk-, but not "kalkul-"; mészvíz; -oldat-; adalék) is a dose with
 * a weak verb too ("Adj naponta 2 liter kalkwassert", "Pótolj naponta 2 liter mészvizet"), and no water noun takes it out ("2 liter kalkwasseres vizet").
 */
const STRONG_DOSING_VERB = /\b(?:adagol(?!o)\w*|csepegtet\w*|cseppents?\w*|dose[sd]?|dosing|dosier\w*)\b/;
/**
 * ONLY THE NOMINATIVE OR THE ACCUSATIVE IS AN AMOUNT GIVEN ("2 liter", "2 litert", "2 liters", "2 l"): every other case names the volume something
 * happens IN or ON, the system's size ("3000 literen a kézi napi adagolás gyorsan vállalhatatlan", the cron guard's run of 2026-11-20 22:15 UTC on
 * e91336c5, acrobot 59045), and so do the adjective ("3000 literes") and the rate ("100 literre", "literhez", "literenként"). A list of the forms that
 * ARE an amount, not of the ones that are not: a case ending nobody listed stays out instead of becoming a dose. THE "-NYI" FORM IS AN AMOUNT TOO
 * ("2 liternyi mészvizet", barracuda on #135), and so is the instrumental of a difference ("adagolj 2 literrel több kalkwassert"); the water
 * exception still takes a water noun after it out ("töltsd fel 2 literrel vizet").
 */
const LITRE_AMOUNT = new RegExp(`${NUM}\\s*(?:l(?:-?t|-nyi)?|ltr|liter(?:[ts]|e?nyi|rel)?|litres?)(?![a-z])`);
const WATER_VOLUME = new RegExp(
  `${NUM}\\s*(?:l|ltr|liter\\w*|litre\\w*)\\s+(?:[a-z-]+\\s+){0,2}` +
    `(?:(?:ro-?|ozmozis-?|desztillalt-?|csap|edes|tiszta|feltolto-?)?viz(?!(?:be|hez|ben|re|ra)\\b)[a-z]*|parolg\\w*|evapora\\w*|(?:ro-?)?(?:water|wasser)\\b)`
);
const ADDITIVE = /\b(?:kalk(?!ul)\w*|\w*meszviz\w*|\w*oldat\w*|adalek\w*)/;
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
 * THE OPERANDS OF A SUM OF PURE NUMBERS ARE ARITHMETIC, NOT A DOSE ("2,5 × 7 = 17,5 liter", "2,5 x 7 = 17,5"): two numbers and a multiplication sign that
 * an equals sign and a number follow. ONLY THE LEFT SIDE IS TAKEN OUT, the result stays (barracuda on #122): "2 × 5 = 10-et" is still a dose, its "10-et" is a
 * counted thing given, and a first version that took the result too let it through. A result with a unit ("= 10 csepp") keeps its unit word and amount;
 * a result followed by a volume ("= 17,5 liter") is a volume and no count. A number with a UNIT on the left has no equals sign after it and is untouched
 * ("3 × 2 ml", "2 × 5 ml") (card 89a6ba86). THE APPROXIMATE SIGN "≈" IS AN EQUALS SIGN TOO ("3 × 7 ≈ 21 liter körüli tartállyal", acrobot 59095): the result
 * is still kept, so "2 × 5 ≈ 10-et" stays a counted thing given.
 */
const EQUATION = /(?<![\d.,])\d+(?:[.,]\d+)?\s*[\u00d7x*]\s*\d+(?:[.,]\d+)?(?=\s*[=\u2248]\s*\d)/g;

/**
 * A NUMBER MULTIPLYING A WORD IS AN OPERAND, NOT A COUNT ("Napi párolgás × 7 = a minimális heti tartálytérfogat, és ehhez adj még +20–30% tartalékot",
 * the run of 2026-11-20 22:19 UTC, acrobot 59046: the "7" read as a bare count next to "napi", "heti" and "adj"). A number right after or right before
 * a times sign ("×" or "*", not the letter x) with an equals sign following is taken out; what comes after the "=" stays, so "kupak × 2 = 6-ot" is
 * still a counted thing given.
 */
const WORD_PRODUCT =
  /[\u00d7*]\s*\d+(?:[.,]\d+)?(?=\s*=)|(?<![\d.,])\d+(?:[.,]\d+)?\s*[\u00d7*](?=\s*[a-z][^=]*=)/g;

/**
 * THE OPERANDS OF A SUM THAT COMES OUT IN LITRES ARE WATER VOLUMES, NOT A COUNT ("kb. 14 + tartalék = 18–20 liter lenne a kényelmes heti méret"): the cron
 * guard's run of 2026-11-20 21:45 UTC lost an answer on the size of a top-off reservoir to it, the "14" read as a bare count next to "napi 2 liter" and "heti"
 * (acrobot 58977). A number followed by one or more "+ <number or word>" or "× <number>" terms and then "= <number or range> liter" is taken out; the
 * RESULT stays, and it is a volume. A sum that comes out in anything else ("2 + 1 = 3 csepp", "= 10-et") is untouched, and so is a counted thing given
 * elsewhere in the sentence ("adj 3-at").
 */
const VOLUME_SUM =
  /(?<![\d.,])\d+(?:[.,]\d+)?(?:\s*(?:\+\s*(?:\d+(?:[.,]\d+)?|[a-z]+)|[\u00d7x*]\s*\d+(?:[.,]\d+)?))+(?=\s*=\s*\d+(?:[.,]\d+)?(?:\s*[-\u2013\u2014]\s*\d+(?:[.,]\d+)?)?\s*(?:l|ltr|liter\w*|litre\w*)(?![a-z]))/g;

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
 * THE PUMP AS EQUIPMENT IS NO UNIT WORD (card 89a6ba86; acrobot 58779, the question-set run of 2026-11-20 20:15 UTC). "Ha automatizálsz (ATO, adagoló pumpa,
 * vezérlő, ...), a napi manuális munka nem feltétlen sok" lost a 5467-character answer: "pumpa" (the singular NOMINATIVE, the device) stood next to "napi" and was
 * read as a dosing-pump unit. The singular nominative is the unit of a dose only after a QUANTITY: "egy pumpa", "két kis pumpa" ("Egy pumpa naponta elég 100
 * literre"). With none of the quantity words (egy, két, három ... fél, pár, több, néhány) ANYWHERE EARLIER IN THE SENTENCE it is the device, and a sentence that
 * names a device next to a period ("az ATO pumpa naponta kétszer indul") is no dose. THE BOUNDARY IS THE START OF THE SENTENCE, NOT A WINDOW (barracuda, #125): a window of
 * a few words let "Naponta egy jó nagy kézi pumpa 100 literre" through, three adjectives between the quantity and the pump, and a tolerance on the pass side opens to a leaking dose.
 * The price is on the stop side: a sentence with a quantity word before a device-pump ("Több eszköz van, az ATO pumpa naponta kétszer indul") still stops. ONLY the bare nominative `pumpa`: "pumpát", "pumpával", "pumpákat" and the
 * plural accusative stay unit words (something given), and a number with "pumpa" is `OTHER_UNIT`'s and is not touched. A dose sentence cannot meet this exception:
 * it needs a quantity before the pump, and then the exception does not apply.
 */
const QUANTITY_WORD = "(?:egy|ket|ketto|harom|negy|ot|hat|het|nyolc|kilenc|tiz|fel|par|tobb|nehany)";
const EQUIPMENT_PUMP = new RegExp(`(?<!\\b${QUANTITY_WORD}\\b.*)\\bpumpa\\b`, "g");

/**
 * A CAPITAL "G-" WITH A WORD AFTER IT IS A NAME, NOT A GRAM ("Reefer XXL / Peninsula / G-széria", acrobot 59095): two of the seven false replacements on the
 * 327 stored answers read the series name as the gram unit next to a litre volume or "napi". The mark of the name is the LETTER ITSELF: the gram is
 * always a small "g", so this is read on the raw sentence, before `fold` lowercases it, and a small "g-" stays the unit whatever follows. Two versions
 * that read the context instead leaked (barracuda on #136): a closed list of case endings ("g-ig" missing) and then a quantity word before it
 * ("másfél", "húsz", "tizenöt" are no `QUANTITY_WORD`). With a quantity word earlier in the sentence the capital G is the unit too; that only
 * widens the stop side. A digit makes the gram `OTHER_UNIT`'s either way. The name's "G" becomes "§", which no pattern reads.
 */
const SERIES_G = /\bG-(?=\p{L})/gu;
const QUANTITY_BEFORE = new RegExp(`\\b${QUANTITY_WORD}\\b`);
const markSeriesNames = (raw: string) =>
  raw.replace(SERIES_G, (match, offset: number) =>
    QUANTITY_BEFORE.test(fold(raw.slice(0, offset))) ? match : "\u00a7-"
  );

/**
 * The pack's reach or content, not a dose: a PACK NOUN only. "elég", "enough",
 * "reicht" are measure words a dose sentence uses too ("3 csepp elég";
 * barracuda, #43 v4), so they let nothing through.
 */
const REACH =
  /\b(?:bottles?|flasche|flakon\w*|uveg\w*|kiszereles\w*|tartalom|inhalt|contents?)\b/;

/**
 * MARKDOWN EMPHASIS IS NO TEXT (ai-doseguard-negyedik-kor-20261123; acrobot 59095): "egy hétre: 2 × 7 = **14 liter**" kept its "2" as a bare count
 * next to "napi 2 liter", because the equation reads "= <digit>" and found "= **". Measured on the 327 stored question-set answers: the bold mark
 * stood between the equals sign and the result in two of the seven false replacements. The doubled marks ("**", "__") are taken out before any
 * reading; a single "*" stays, it is also a times sign.
 */
const EMPHASIS = /\*\*|__/g;

/**
 * A LIST NUMBER AT A LINE'S START IS NO AMOUNT ("1. Egy hétig kézzel pótold ...", "2) Hetente ..."): a number of one or two digits, a point or
 * a bracket, a space and then a LETTER (or the bold mark), after the bullet if there is one. A decimal point has no space after it ("1.5 ml"),
 * and a number followed by another digit or a unit is no marker, so an amount or a given count stays what it was. Measured on the main: the
 * marker counted as the bare count of the sentence and, next to "naponta" and "pótol-", made a given-count (card 15e38019).
 */
const LIST_MARKER = /^\s*(?:[-*\u2022]\s*)*\d{1,2}[.)]\s+(?=[a-z*_])/;

/**
 * The answer's sentences; a decimal point is no end, and neither is the point of a common abbreviation ("pl.", "kb.",
 * "stb.", "ill.", "vö.", "ún.", "max.", "min.", "e.g.", "approx."). The cron guard's run of 2026-11-20 21:30 UTC lost a 4065-character nitrate
 * answer to the split at "pl.": "Vegyél ki ... a teszt fiolájába (pl. 5 vagy 10 ml, amit a teszt ír)" reached the guard as "5 vagy 10 ml, amit a teszt
 * ír)", the vial it is measured into cut away (acrobot 58933). A longer sentence only gives the guard more to read: a period or a volume earlier in it
 * still counts.
 */
const ABBREVIATION_POINT = /(?<![\p{L}])(?:pl|kb|stb|ill|v\u00f6|\u00fan|max|min|approx|ca|e\.g|i\.e)\.(?=\s)/giu;
function sentences(text: string): string[] {
  return text
    .replace(ABBREVIATION_POINT, (m) => m.slice(0, -1) + "\u2024")
    .split(/(?<!\d)[.!?;](?!\d)|\n/)
    .map((s) => s.replace(/\u2024/g, "."))
    .filter((s) => s.trim() !== "");
}

/**
 * A TEST STEP'S AMOUNT IS NO DOSE (acrobot 58933): "Vegyél ki 5 vagy 10 ml akváriumvizet a teszt fiolájába", "Cseppents 5 cseppet a mintához", "Töltsd a
 * küvettát 10 ml-ig". THE SYRINGE IS NO TEST VESSEL: it is the usual tool to dose a supplement ("Mérj ki fecskendővel 10 ml-t, és csepegtesd az
 * áramlásba"; barracuda on #132), so it is not on the list. A sentence that names a TEST VESSEL or the SAMPLE (fiola, küvetta, kémcső, minta, mintavétel) and has NO period, NO water
 * volume and NO aquarium as the target (akváriumba, medencébe, rendszerbe, sumpba/szumpba, tartályba, vízbe, áramlásba, technikába; barracuda on #132 for
 * the last four) is the measurement, not something the aquarium gets. A dose
 * sentence cannot meet it: it says when (a period) or how much water (a volume) or where (the aquarium); "Tegyél 5 ml-t a mintavétel után az akváriumba"
 * names the aquarium and stays a dose. The words are read after `fold` (no accents).
 * THE VESSEL IS OFTEN THE SECOND HALF OF A COMPOUND: "Mérőfiolába pontosan kimérsz egy adott mennyiségű akváriumvizet (pl. 5 vagy 10 ml)" lost an answer in
 * the cron guard's run of 2026-11-20 21:45 UTC (acrobot 58977), the word boundary before "fiol" missing inside "merofiolaba". The vessel words (fiola, küvetta,
 * kémcső, and "tesztcső": "akváriumvizet a tesztcsőbe (pl. 5 vagy 10 ml)", acrobot 59095) match INSIDE a word too; the sample words stay whole words, and the syringe and the measuring cup stay off the list (they dose).
 */
const TEST_VESSEL =
  /\b(?:[a-z]*(?:fiol|kuvett|kemcso|tesztcso)\w*|mint(?:a|aba|ahoz|abol|at|aval|avetel\w*|aviz\w*)|vial\w*|cuvette\w*|test tube\w*|sample\w*|probe\w*)\b/;
const AQUARIUM_TARGET =
  /\b(?:akvarium(?:ba|ban|hoz|ra)|medence(?:be|ben|hez|re)|rendszer(?:be|ben|hez)|s[uz]ump(?:ba|ban|hoz)|tartaly(?:ba|ban)|tank(?:ba|ban)|viz(?:be|hez)|aramlas\w*ba|technik\w*(?:ba|ban)|(?:into|to|in) (?:the |your )?(?:tank|aquarium|system|sump|water|flow))\b/;
/**
 * THE TEST NAMES THE SAMPLE WITHOUT A VESSEL WORD TOO (acrobot 59046, the run of 2026-11-20 22:19 UTC): "Felveszel pontosan annyi vizet, amennyit a
 * teszt előír (pl. 5 vagy 10 ml)". The water TAKEN ("vizet", "akváriumvizet") with the test as the one that says how much ("a teszt előír / ír /
 * kér") is the sample, but only with NO dosing verb and NO named additive in the sentence ("Ha a teszt alacsonyat ír, 200 ml mészvizet" is an elliptic
 * dose; barracuda on #135), and the water is plain or the aquarium's ("akváriumvizet"), never "mészvizet": "Adagolj 5 ml-t, ha a teszt kéri, és cserélj vizet" names a test and water
 * too, and its verb gives something.
 */
const TEST_SAYS = /\bteszt\w*\s+(?:[a-z]+\s+)?(?:eloir|ir|ker)\w*/;
// plain water or the aquarium's water only, as in WATER_VOLUME: "mészvizet" is Kalkwasser (barracuda on #135)
const WATER_TAKEN = /\b(?:ro-?|ozmozis-?|desztillalt-?|csap|edes|tiszta|feltolto-?|akvarium|tenger|minta)?vizet\b/;
const isTestStep = (s: string, volumes: number, periods: number) =>
  (TEST_VESSEL.test(s) ||
    (TEST_SAYS.test(s) && WATER_TAKEN.test(s) && !DOSING_VERB.test(s) && !ADDITIVE.test(s))) &&
  volumes === 0 &&
  periods === 0 &&
  !AQUARIUM_TARGET.test(s);

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
  | "litre-dose"
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
    const s = fold(markSeriesNames(raw)).replace(EMPHASIS, "").replace(LIST_MARKER, "").replace(VOLUME_SUM, " ").replace(EQUATION, " ").replace(WORD_PRODUCT, " ").replace(RANGE, "");
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
      const additive = ADDITIVE.test(s);
      if (
        LITRE_AMOUNT.test(s) &&
        (STRONG_DOSING_VERB.test(s) || (additive && DOSING_VERB.test(s))) &&
        (additive || !WATER_VOLUME.test(s))
      )
        return { ok: false, reason: "DOSE_NOT_IN_CATALOGUE", rule: "litre-dose", sentence: raw.trim() };
    }
    // a pack's reach stands without a period; with one ("elég naponta 3 csepp")
    // the sentence is a dose and needs the full match (barracuda, #43)
    const dose =
      amounts.length > 0 ||
      (UNIT_WORD.test(s.replace(EQUIPMENT_PUMP, " ")) && (volumes.length > 0 || periods.length > 0));
    if (
      !dose ||
      (REACH.test(s) && periods.length === 0) ||
      isTestStep(s, volumes.length, periods.length)
    )
      continue;
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
