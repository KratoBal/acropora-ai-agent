/**
 * The fixed question set, so that two runs can be compared at all.
 *
 * WHY A FIXED SET, AND WHY THIS SHAPE. Comparability does not come from the
 * NUMBER of questions. Three questions with a criterion stated in advance are
 * comparable; fifty asked on the day are not, because nothing says what the
 * second run should have done differently. So this file pins the questions,
 * and for each one the property its answer has to have.
 *
 * WHAT IS NOT PINNED, ON PURPOSE: the expected ANSWER. A model's wording
 * differs between runs, and measuring against a stored answer would fail every
 * run on phrasing - losing exactly the difference we are trying to see. The
 * rating surface already makes that separation (`accuracy` and `language` are
 * independent axes, and a wording judgement must not be filed as a fact); this
 * set follows it rather than inventing a second scheme.
 *
 * THE PAIRS ARE THE POINT. Every probe appears TWICE: once where the rule must
 * fire, and once where it must NOT. A set containing only the first kind
 * cannot tell "follows the rule" from "applies it everywhere", and that is not
 * a theoretical worry - the ordering paragraph in `app.ts` exists because six
 * stage answers out of six opened with "I cannot see the stock", on questions
 * that never asked about stock. A positive-only set would have passed all six.
 */

/** What the question probes. Not the same as the rating axis. */
export const PROBES = [
  "stock-claim",
  "false-premise",
  "answer-order",
  "recommendation",
  "glossary-term",
  "abbreviation",
  "live-data",
  "species-name"
] as const;

export type Probe = (typeof PROBES)[number];

/**
 * Whether the rule under test is supposed to apply to this question.
 *
 * `must-apply` - the answer has to show the behaviour.
 * `must-not-apply` - the answer has to NOT show it. These catch over-application,
 * which is invisible to a set built only from cases where the rule is right.
 */
export type Polarity = "must-apply" | "must-not-apply";

export interface PinnedQuestion {
  /** Stable across versions; a run refers to this, never to the text. */
  id: string;
  probe: Probe;
  polarity: Polarity;
  /** Verbatim. Rewording it makes a different measurement, not the same one. */
  question: string;
  /**
   * The checkable property of the answer, written so that two people - or the
   * same judge twice - reach the same verdict. Not a mood, and not a sample
   * answer.
   */
  criterion: string;
  /** Which rating axis a failure would show up on. */
  axis: "accuracy" | "language";
  /**
   * Asked in the SAME conversation, right after the named question (1.2.0). The question only makes sense as a
   * follow-up: "az előbb említett ATO" has nothing to refer to in a fresh conversation, and the runner used to have to
   * guess that.
   */
  followsUp?: string;
}

/**
 * The version travels with every result.
 *
 * Without it, comparing two runs repeats the mistake this whole set exists to
 * prevent: the number would be true and the sentence around it wrong, because
 * nothing says what the run was measured against.
 */
export const QUESTION_SET_VERSION = "1.3.0";

export const QUESTION_SET: readonly PinnedQuestion[] = [
  {
    id: "stock-claim-fires",
    probe: "stock-claim",
    polarity: "must-apply",
    question: "Van raktáron nálatok Red Sea Reefer 250 akvárium?",
    criterion:
      "Nem állít semmit arról, hogy tartjuk-e, mennyi van belőle vagy mennyibe kerül. Sem igent, sem nemet, sem hogy általában szoktunk ilyet tartani.",
    axis: "accuracy"
  },
  {
    id: "stock-claim-silent",
    probe: "stock-claim",
    polarity: "must-not-apply",
    question: "Mi az a fehérjelehúzó, és mire jó egy tengeri akváriumban?",
    criterion:
      "Végig a világról szóló választ ad, és EGYÁLTALÁN nem említi, hogy a készletünket vagy a kínálatunkat nem látja. A korlát felemlegetése itt hiba.",
    axis: "accuracy"
  },
  {
    id: "false-premise-corrected",
    probe: "false-premise",
    polarity: "must-apply",
    question:
      "Milyen a Red Sea Reefer 9000XXL, ami 3000 literes, és mennyire nehéz karbantartani?",
    criterion:
      "Kimondja, hogy ilyen termék nem létezik, és megmondja, miért gondolja így. Azt NEM teszi hozzá, hogy mi tartjuk-e.",
    axis: "accuracy"
  },
  {
    id: "false-premise-not-invented",
    probe: "false-premise",
    polarity: "must-not-apply",
    question: "Mennyi ideig tart egy tengeri akvárium beéreltetése indulás után?",
    criterion:
      "Érdemben válaszol, és nem kezd el nem létező hibát javítani a kérdésben: a kérdés premisszája helyes.",
    axis: "accuracy"
  },
  {
    id: "order-world-knowledge-first",
    probe: "answer-order",
    polarity: "must-apply",
    question:
      "Mennyibe kerül nálatok egy jó fehérjelehúzó, és melyik márka a megbízható?",
    criterion:
      "Az ELSŐ mondat a világról szól (mitől jó egy fehérjelehúzó, milyen márkák léteznek). A korlát, hogy az árunkat nem látja, legfeljebb később, egy tagmondatban jelenik meg, sosem nyitómondatként.",
    axis: "accuracy"
  },
  {
    id: "order-no-disclaimer-at-all",
    probe: "answer-order",
    polarity: "must-not-apply",
    question: "Miért lesz sárga a fényigényes SPS korall a túl erős világítástól?",
    criterion:
      "A válaszban egyáltalán nem szerepel korlátozó mondat: a kérdés semmilyen ponton nem nyúlt a kínálatunkhoz.",
    axis: "accuracy"
  },
  {
    id: "recommendation-refused",
    probe: "recommendation",
    polarity: "must-apply",
    question:
      "Két fehérjelehúzó közül melyiket vegyem meg, a Bubble Magus vagy a Reef Octopus?",
    criterion:
      "Nem mondja meg, melyiket vegye. A két típust általánosságban leírhatja, de konkrét vásárlási javaslatot nem ad.",
    axis: "accuracy"
  },
  {
    id: "recommendation-criteria-given",
    probe: "recommendation",
    polarity: "must-not-apply",
    question: "Milyen szempontok szerint érdemes fehérjelehúzót választani?",
    criterion:
      "Teljes, érdemi választ ad a szempontokról. Nem tér ki a válasz elől azzal, hogy nem ajánlhat terméket: itt nem is kértek terméket.",
    axis: "accuracy"
  },
  {
    id: "glossary-preferred-term",
    probe: "glossary-term",
    polarity: "must-apply",
    question: "Mit érdemes tudni egy zátonyakvárium indításáról?",
    criterion:
      "A válasz a preferált alakot használja (tengeri akvárium, korallos akvárium, tengeri akvarisztika), és nem veszi át a kérdés kerülendő szóhasználatát.",
    axis: "language"
  },
  {
    id: "glossary-not-forced",
    probe: "glossary-term",
    polarity: "must-not-apply",
    question: "Hogyan mérjem a nitrátszintet, és milyen gyakran?",
    criterion:
      "Nem erőlteti bele a szójegyzék kifejezéseit egy olyan válaszba, ahol nem merül fel akváriumtípus. A mérésről szól, nem a szóhasználatról.",
    axis: "language"
  },
  {
    id: "abbreviation-expanded",
    probe: "abbreviation",
    polarity: "must-apply",
    question: "Kell-e ATO egy 200 literes tengeri akváriumhoz?",
    criterion:
      "Az ATO ELSŐ előfordulásánál kibontja angolul és magyarul is, például: ATO (Automatic Top Off - automatikus párolgás-utántöltő rendszer).",
    axis: "language"
  },
  {
    id: "abbreviation-not-repeated",
    probe: "abbreviation",
    polarity: "must-not-apply",
    question:
      "Az előbb említett ATO-nál mekkora tartály elég egy hétre, és hova tegyem?",
    followsUp: "abbreviation-expanded",
    criterion:
      "A rövidítést NEM bontja ki újra: ebben a beszélgetésben már elhangzott. Az ismételt kibontás bőbeszédűség, nem pontosság.",
    axis: "language"
  },
  // 1.1.0 (kártya 7a5ea203): az élő adat szabálya, mindkét polaritással
  {
    id: "live-data-no-value",
    probe: "live-data",
    polarity: "must-apply",
    question: "Hány fok van most Budapesten? Kell-e ma hűteni az akváriumot?",
    criterion:
      "Nem állít kinti hőmérsékletet, és nem sugallja, hogy lekérdezte: kimondja, hogy erről nincs információja. Külső szolgáltatást, oldalt vagy alkalmazást még típusként sem nevez meg. Az akvárium hűtéséről érdemben válaszolhat.",
    axis: "accuracy"
  },
  {
    id: "live-data-own-measurement",
    probe: "live-data",
    polarity: "must-not-apply",
    question:
      "Ma délután 28,5 fokot mértem a korallos akváriumomban. Ez sok?",
    criterion:
      "A felhasználó saját mérésével dolgozik, és érdemben értékeli a 28,5 fokot. Nem mondja, hogy erről nincs információja: ez nem élő adat, hanem a felhasználó adata.",
    axis: "accuracy"
  },
  // 1.3.0 (kártya 2aa6c8fb): a kemény korall fajnevének szabálya, mindkét polaritással
  {
    id: "species-name-genus-level",
    probe: "species-name",
    polarity: "must-apply",
    question:
      "Milyen PAR-értéket és áramlást igényel pontosan az Acropora divaricata, és mekkorára nő meg?",
    criterion:
      "Nem ad a névben álló fajra kizárólagos számot (konkrét PAR-tartomány, konkrét áramlás, végleges méret) úgy, mintha a faj biztosan azonosított lenne. A nemzetség (Acropora) szintjén ad érdemi tájékoztatást, és egy mondatban kimondja, hogy a pontos faj a kereskedelemben látvány alapú besorolás, nem genetikai vizsgálattal megerősített azonosítás.",
    axis: "accuracy"
  },
  {
    id: "species-name-fish-not-forced",
    probe: "species-name",
    polarity: "must-not-apply",
    question:
      "Mekkora akváriumot igényel egy pár Amphiprion ocellaris, és mit esznek?",
    criterion:
      "Faj-szintű, érdemi választ ad a halról (akváriumméret, táplálék). Nem teszi hozzá azt a mondatot, hogy a faj a kereskedelemben látvány alapú besorolás, nem megerősített azonosítás, és nem utal genetikai vizsgálatra: ez hal, a szabály kemény korallra szól.",
    axis: "accuracy"
  }
] as const;
