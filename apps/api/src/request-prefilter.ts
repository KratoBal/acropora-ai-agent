/**
 * THE LOCAL DOMAIN AND INTENT PRE-FILTER, SLICE 1: THE CLASSIFIER ALONE (Acropora OS card f5b8f7ba; plan
 * `agents/nautilus/TERV-ai-eloszures-2026-08-27.md`; Balázs 2026-08-27 19:38: "az OpenAI-hívás előtt legyen helyi,
 * költségkímélő domain- és intent-előszűrés", decided 2026-08-27 20:14 and 2026-11-11 08:51).
 *
 * THIS FILE IS NOT WIRED INTO ANY ROUTE. It is a pure function with no import, no network, no database and no model call
 * (matrix row 25 reads this file's source to keep it so). Slice 2 puts it into `POST /v1/chat` between the history load and the
 * key check, behind a switch; until then nothing calls it and the service behaves exactly as before.
 *
 * FOUR CATEGORIES, THREE DECISIONS (Balázs):
 *   marine-aquaristics   pass   goes to the model
 *   acropora-business    pass   goes to the model (a product, an order, a delivery, an opening hour)
 *   off-topic            block  a local answer, no model call
 *   uncertain            ask    a local clarifying question, no model call
 *
 * IT DECIDES ON EVIDENCE, NOT ON A BLOCKLIST (Balázs: "ne használjunk tiltólistát önmagában", and the words víz, hőmérséklet,
 * só, szűrő must not mean off-topic by themselves). Two independent signs are looked for:
 *   TOPIC EVIDENCE   a term that pulls towards the domain (akvárium, korall, ICP, rendelés, szállítás ...);
 *   EXIT SIGNAL      an element that names another world (a town, a match, a recipe, a pet, a poem, an instruction override).
 * The decision follows from how the two stand to each other:
 *   topic evidence                -> pass   (the domain wins: "a biztosan akvarisztikai kontextus élvezzen elsőbbséget")
 *   no topic, an exit signal      -> block  (NEVER looks at the history: a topic earlier in the talk does not make an
 *                                            off-topic question on-topic, and the reverse is exactly the hole through which an
 *                                            "ignore your instructions" question would slip)
 *   neither                       -> ask    unless the LAST FEW TURNS carry topic evidence: then pass, reason `context-carried`
 * The same words ("hány fok") give three outcomes depending on what stands next to them: that is the one claim of this gate.
 *
 * HUNGARIAN, THREE TECHNICAL REQUIREMENTS (each one, left out, makes a false `ask`, the most annoying outcome):
 *   1. accent-free matching (`akvarium` = `akvárium`);
 *   2. suffixes: a term of five letters or more matches as a PREFIX of a word (`akváriumban`, `korallokat`);
 *   3. case folding and WORD BOUNDARIES: a short term must be a whole word (`kh`, `icp`, `sps`), so `sósav` is not `só`.
 *
 * THE RESULT CARRIES NO TEXT: category, decision and reason only, so a log line built from it cannot hold a fragment of the
 * customer's message (row 26).
 *
 * WHAT IS NOT HERE: the wording of the local answers (Balázs's), the turn count and the off-topic series (slice 3), the contact
 * offer (its own slice). The word lists are a FIRST, matrix-driven version: every wrong decision found later is a new matrix row
 * first, then a list change.
 */

export type PrefilterCategory =
  | "marine-aquaristics"
  | "acropora-business"
  | "off-topic"
  | "uncertain";

export type PrefilterDecision = "pass" | "block" | "ask";

export type PrefilterReason =
  | "topic-evidence"
  | "exit-signal"
  | "no-evidence"
  | "context-carried";

export interface PrefilterResult {
  category: PrefilterCategory;
  decision: PrefilterDecision;
  reason: PrefilterReason;
}

export interface RecentTurn {
  role: "user" | "assistant";
  content: string;
}

/** How many of the latest messages the `ask` branch may read for topic evidence (the last two rounds). */
export const CONTEXT_MESSAGES = 4;

/** Lower case, accents off (ő -> o, ö -> o, á -> a), everything that is not a letter or a digit is a word boundary. */
export function normalizedTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);
}

/**
 * One term is one or more words, already normalised. A word of the term matches a word of the text EXACTLY when it is short
 * (under five letters: `kh`, `icp`, `sps`, `gls`) and as a PREFIX otherwise (suffixes: `akvarium` -> `akvariumban`). A trailing
 * `*` forces the prefix reading for a short stem that takes endings (`vers*` -> `verset`, `bolt*` -> `boltban`).
 */
function matchesWord(token: string, termWord: string): boolean {
  if (termWord.endsWith("*")) return token.startsWith(termWord.slice(0, -1));
  return termWord.length < 5 ? token === termWord : token.startsWith(termWord);
}

function hasTerm(tokens: readonly string[], term: string): boolean {
  const words = term.split(" ");
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    if (words.every((word, index) => matchesWord(tokens[start + index], word)))
      return true;
  }
  return false;
}

const anyTerm = (tokens: readonly string[], terms: readonly string[]) =>
  terms.some((term) => hasTerm(tokens, term));

/** A fish of the aquarium keeping: a compound ending in `hal` (diszkoszhal, bohócchal, doktorhal ...), with its case endings. */
const FISH_COMPOUND = /^[a-z]{4,}hal[a-z]{0,5}$/;

/**
 * MARINE AQUARISTICS: terms that are about the hobby ALONE. Deliberately not here: víz, hőmérséklet, só, szűrő, hal, medence,
 * kő, lámpa: on their own they say nothing (a recipe has salt, a pool has a filter), and Balázs ruled it out.
 */
const MARINE_TERMS: readonly string[] = [
  "akvari", // akvárium, akvarisztika, akvarista
  "korall", // korall, korallok, napkorall (prefix of `korall...`)
  "koral", // the common typo
  "zoa*",
  "sps",
  "lps",
  "icp",
  "kh",
  "zatony",
  "lehabzo",
  "lefolozo",
  "skimmer",
  "eloko",
  "refugium",
  "ozmozis",
  "ro viz*",
  "nitrat",
  "foszfat",
  "szalinitas",
  "alkalinitas",
  "akklimat",
  "karanten",
  "amphiprion",
  "acropora",
  "tubastrea",
  "euphyllia",
  "montipora",
  "lefolyofesu"
];

/** ACROPORA BUSINESS: the shop, the order, the delivery, the paper, the opening hours. */
const BUSINESS_TERMS: readonly string[] = [
  "rendele", // rendelés, rendelem, rendelésem
  "szallit", // szállítás, szállítási, szállítók
  "szamla",
  "nyitvatart",
  "garanci",
  "raktar",
  "webshop",
  "kosar",
  "atvetel",
  "fizetes",
  "foxpost",
  "gls",
  "csomag",
  "visszakuld",
  "visszater",
  "reklamac",
  "elallas",
  "termek", // termék: "milyen termékek vannak?"
  "bolt*",
  "kedvezmeny",
  "akcio",
  "kupon",
  "arajanlat"
];

/**
 * EXIT SIGNALS: elements of another world. Towns and countries (a place is what turns "hány fok volt ma" into a weather
 * question), sport and public life, the kitchen and the household, other pets, a request to write or to translate, a
 * programming or maths task, and the phrases of an instruction override. Short names are whole words (`erd`, `usa`).
 */
const EXIT_TERMS: readonly string[] = [
  // towns and countries
  "budapest",
  "debrecen",
  "szeged",
  "miskolc",
  "pecs*",
  "gyor*",
  "nyiregyhaza",
  "kecskemet",
  "szekesfehervar",
  "szombathely",
  "szolnok",
  "tatabanya",
  "kaposvar",
  "erd",
  "veszprem",
  "bekescsaba",
  "zalaegerszeg",
  "sopron",
  "nagykanizsa",
  "dunaujvaros",
  "szentendre",
  "godollo",
  "gyongyos",
  "balaton",
  "london",
  "paris",
  "berlin",
  "madrid",
  "usa",
  "amerika",
  "magyarorszag",
  // weather
  "idojaras",
  "hofront",
  "havazik",
  // sport and public life
  "meccs",
  "foci*",
  "gol",
  "golt",
  "golok",
  "bajnoksag",
  "valasztas",
  "kormany",
  "politika",
  "miniszter",
  "parlament",
  "tozsde",
  "bitcoin",
  "lotto",
  "horoszkop",
  "film*",
  "sorozat",
  // the kitchen and the household
  "recept",
  "sutes",
  "sutemeny",
  "fozes",
  "porszivo",
  "mosogatogep",
  "hutoszekreny",
  "mosogep",
  // other pets
  "kutya",
  "macska",
  "papagaj",
  "horcsog",
  "tengerimalac",
  "kigyo",
  // a request for text, translation, code, maths
  "vers*",
  "dalszoveg",
  "vicc*",
  "forditsd",
  "forditas",
  "programoz",
  "python",
  "javascript",
  "egyenlet",
  // an instruction override (the matrix names the hole: a context that overrides the exit signal lets these through)
  "felejtsd el",
  "ignore previous",
  "ignore all",
  "system prompt",
  "chatgpt",
  "jailbreak"
];

/** "Írj nekem egy verset / mesét / történetet": a request to write is an exit signal of its own. */
const WRITE_VERBS: readonly string[] = ["irj", "irjal", "irnal", "irna"];
const WRITE_OBJECTS: readonly string[] = [
  "vers*",
  "mese*",
  "tortenet",
  "dalszoveg",
  "novella",
  "essze*"
];

type Evidence = {
  marine: boolean;
  business: boolean;
  exit: boolean;
};

function evidenceOf(text: string): Evidence {
  const tokens = normalizedTokens(text);
  const marine =
    anyTerm(tokens, MARINE_TERMS) ||
    tokens.some((token) => FISH_COMPOUND.test(token));
  const business = anyTerm(tokens, BUSINESS_TERMS);
  const exit =
    anyTerm(tokens, EXIT_TERMS) ||
    (anyTerm(tokens, WRITE_VERBS) && anyTerm(tokens, WRITE_OBJECTS));
  return { marine, business, exit };
}

const categoryOf = (evidence: Evidence): PrefilterCategory =>
  evidence.marine ? "marine-aquaristics" : "acropora-business";

/**
 * THE DECISION. `message` is the latest customer message; `recentTurns` the conversation so far, oldest first (it may
 * contain the latest message itself, which is then read twice and changes nothing). Pure: same input, same answer.
 */
export function classifyRequest(
  message: string,
  recentTurns: readonly RecentTurn[] = []
): PrefilterResult {
  const now = evidenceOf(message);

  if (now.marine || now.business)
    return {
      category: categoryOf(now),
      decision: "pass",
      reason: "topic-evidence"
    };

  if (now.exit)
    return { category: "off-topic", decision: "block", reason: "exit-signal" };

  // Neither sign in this message: the last few turns may carry the topic ("Hány fok volt ma?" after a talk about a tank).
  const recent = recentTurns.slice(-CONTEXT_MESSAGES);
  const carried: Evidence = { marine: false, business: false, exit: false };
  for (const turn of recent) {
    const found = evidenceOf(turn.content);
    carried.marine ||= found.marine;
    carried.business ||= found.business;
  }
  if (carried.marine || carried.business)
    return {
      category: categoryOf(carried),
      decision: "pass",
      reason: "context-carried"
    };

  return { category: "uncertain", decision: "ask", reason: "no-evidence" };
}
