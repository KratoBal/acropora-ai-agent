import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  ABBREVIATIONS,
  GLOSSARY_AVOIDED,
  GLOSSARY_PREFERRED,
  type Abbreviation
} from "./glossary.js";
import {
  QUESTION_SET,
  QUESTION_SET_VERSION,
  type PinnedQuestion
} from "./question-set.js";
import { QUESTION_SET_CLIENT_KEY } from "./question-set-client.js";
import {
  applyJudgements,
  awaitingJudgement,
  effectiveVerdict,
  judgementSheet,
  type Judgement
} from "./question-set-judgement.js";
import { PREFILTER_MODEL_LABEL } from "./request-prefilter-answers.js";

/**
 * THE PINNED QUESTION SET, RUN AGAINST A LIVE SERVICE (Acropora OS card 7a5ea203, task t-20261116-ai-kerdeskeszlet-futtato).
 *
 * The set, the rating chain and the instruction version on each answer were all in place, and nothing ran them: the
 * effect of the live-data rule and the abbreviation list was a claim, not a measurement. This asks every question of
 * one service, writes the answers down with the set version and the server's instruction version, and scores what can
 * be scored mechanically.
 *
 * WHAT IS SCORED BY THE MACHINE, AND WHAT IS NOT. Only where the criterion is a count:
 *   glossary-preferred-term  no avoided form, and at least one preferred form
 *   glossary-not-forced      no glossary form at all (the question is about nitrate)
 *   abbreviation-expanded    the first ATO is followed by its expansion
 *   abbreviation-not-repeated the follow-up answer does not expand the ATO again
 * The two live-data questions get a machine `pass` where every part of the criterion can be read off the text, and
 * `human` otherwise, never a machine `fail`: a correct answer names the aquarium's own temperatures, so a regex that
 * failed on a number would mark it wrong (see `scoreLiveData`).
 *   stock-claim-silent       fail on a sentence that says it cannot see our stock or prices; pass with no limitation
 *                            phrase at all; human between
 *   order-world-knowledge-first  fail when the FIRST sentence is that limitation; pass when it carries no limitation
 *                            phrase; human between
 *   order-no-disclaimer-at-all   the same reading as stock-claim-silent: the question never touched our range, so a
 *                            limitation sentence anywhere is the fail (t-20261120 gepi meres, acrobot 58658)
 *   recommendation-criteria-given fail on a sentence that refuses to recommend; pass with no refusal and no limitation
 *                            phrase; human between (the criterion is "does not dodge the answer by saying it may not
 *                            recommend a product")
 * Until 2026-11-20 these two were `human` only because no rule named them: in the thirteen runs of 11-16 and 11-17 every
 * one of their 24 model answers went to a person who never came, while their criterion is a phrase that is either there
 * or not.
 * The other four stay `human`: a stock or price claim, a purchase recommendation, the reason a product does not exist
 * and an invented correction can each be worded in any way, so a machine pass would be a guess (acrobot 53747).
 *
 * AN ANSWER THE MODEL DID NOT WRITE IS NOT SCORED (the first stage run, 2026-11-16, acrobot 53706): five of fourteen
 * answers were the dose guard's fallback sentence, and two of them passed, because a sentence with no glossary form and
 * no ATO "passes" the two questions that ask for their absence. A replaced answer (`doseGuard`, or the link gate under
 * `enforce`) is `replaced`, a local one (the pre-filter, the contact flow) is `local`; neither is counted in the
 * glossary totals.
 *
 * The 2026-08-28 baseline (18 answers: preferred 11, avoided 26, wrong translation 0) is in glossary.ts; the summary
 * gives the same two counts, so the two can stand side by side.
 */

/**
 * `void`: the question could not measure the model. A FOLLOW-UP is asked in its parent's conversation, so the model is shown the parent's
 * answer; when that answer is not the model's (the dose guard swapped it, or it was local), the follow-up's rule ("do not expand again")
 * was tested against a history that never held the first expansion. Not a fail, not a pass, never compared (t-20261117-kerdeskeszlet-void).
 */
export type Verdict = "pass" | "fail" | "human" | "replaced" | "local" | "void";

/** Who wrote the answer: the model, the model but a guard swapped the text, or local logic with no model call. */
export type AnswerSource = "model" | "replaced" | "local";

export interface TermCounts {
  preferred: Record<string, number>;
  avoided: Record<string, number>;
}

const lower = (text: string) => text.toLocaleLowerCase("hu");

/**
 * Occurrences of each form, longest first and without overlap: "fehérjelehabzó" is one preferred form, not also a
 * "lehabzó". The match is a plain substring, anywhere in the text: a suffixed word ("zátonyakváriumot") counts as its
 * form, and so would a compound that happens to contain one (none on today's lists).
 */
export function countTerms(
  answer: string,
  preferred: readonly string[] = GLOSSARY_PREFERRED,
  avoided: readonly string[] = GLOSSARY_AVOIDED
): TermCounts {
  let text = lower(answer);
  const counts: TermCounts = { preferred: {}, avoided: {} };
  const all = [
    ...preferred.map((term) => ({ term, kind: "preferred" as const })),
    ...avoided.map((term) => ({ term, kind: "avoided" as const }))
  ].sort((a, b) => b.term.length - a.term.length);
  for (const { term, kind } of all) {
    const needle = lower(term);
    let found = 0;
    let at = text.indexOf(needle);
    while (at !== -1) {
      found += 1;
      text = text.slice(0, at) + " ".repeat(needle.length) + text.slice(at + needle.length);
      at = text.indexOf(needle, at + needle.length);
    }
    if (found > 0) counts[kind][term] = found;
  }
  return counts;
}

const total = (record: Record<string, number>) =>
  Object.values(record).reduce((sum, n) => sum + n, 0);

export interface AbbreviationCheck {
  occurrences: number;
  /** The first occurrence is followed by "(<original>" (case does not matter). */
  firstExpanded: boolean;
  /** How many times the original expression appears at all. */
  expansions: number;
}

/** A letter or digit next to it means it is part of another word ("ATOM" is not an ATO). */
export function checkAbbreviation(answer: string, entry: Abbreviation): AbbreviationCheck {
  const token = new RegExp(`(?<![\\p{L}\\p{N}])${entry.abbreviation}(?![\\p{L}\\p{N}])`, "gu");
  const matches = [...answer.matchAll(token)];
  const original = lower(entry.original);
  const first = matches[0];
  const after = first ? lower(answer.slice(first.index! + entry.abbreviation.length, first.index! + entry.abbreviation.length + entry.original.length + 6)) : "";
  return {
    occurrences: matches.length,
    firstExpanded: first !== undefined && /^\s*\(/.test(after) && after.includes(original),
    expansions: lower(answer).split(original).length - 1
  };
}

// "Nincs élő adatom", "nem tudom megmondani, hány fok" (the second stage run): the phrasing the model really used
const NO_INFORMATION =
  /nincs (?:élő |aktuális )?(?:információ|adat)|nem tudom(?: megmondani)?,? hány fok|nem látom,? hány fok/iu;

/**
 * A SENTENCE THAT SAYS THE ASSISTANT CANNOT SEE OUR STOCK OR PRICES: a limitation phrase AND a shop word in the same
 * sentence. Either alone is no such sentence ("az árak széles skálán mozognak" is about the world). Used by the two
 * stock and order questions; their verdicts are below.
 */
const LIMITATION = /nincs (?:élő |aktuális )?(?:információ|adat|rálátás)|nem lát(?:om|ok rá)|nem ismerem|nem tudom (?:megmondani|megnézni)|nem tudok (?:rálátni|információt)/iu;
// "ár" with a Unicode word boundary: \b is ASCII even under the u flag, so it found "ár" inside "határ", "kár", "sár"
// and missed "Az árat" (barracuda, #100)
const SHOP_WORD =
  /készlet|raktár|kínálat|(?<![\p{L}\p{N}])ár(?:a|ai|ak|at|ainkat|unk|akat|akról|airól|ainkra|aink)?(?![\p{L}\p{N}])|kapható|forgalmaz|nálunk|nálatok|webshop|üzlet/iu;
const isShopLimitation = (sentence: string) => LIMITATION.test(sentence) && SHOP_WORD.test(sentence);
/**
 * A SENTENCE THAT REFUSES TO RECOMMEND ("nem ajánlhatok konkrét terméket", "nem tudok márkát javasolni"): the dodge the
 * criteria question must not make. A refusal of a purchase is the right answer to `recommendation-refused`; here nobody
 * asked for a product, so the same sentence is the fail.
 */
// Four word orders, each one a red test (barracuda on #123: the pass stands on the pattern's ABSENCE, so a narrow pattern is
// a silent false pass): the verb after "nem" ("nem tudok ... ajánlani", "nem ajánlhatok"), the present tense ("nem ajánlok
// konkrét terméket"), the noun form after "nem adhatok", and the inverted order Hungarian uses as often ("Konkrét terméket
// ajánlani nem tudok", "Termékajánlást nem adhatok"). "nem tudom eléggé ajánlani" is praise, not a refusal: "tudom" is
// not in the list, and that sentence has its own pass test.
const RECOMMENDATION_REFUSAL = new RegExp(
  [
    "nem (?:ajánlhat|javasolhat)",
    "nem (?:tudok|fogok|szeretnék|akarok)(?: [\\p{L}]+){0,3} (?:ajánlani|javasolni)",
    "nem (?:ajánlok|javaslok|javasolok)(?![\\p{L}])",
    "nem adhatok (?:vásárlási|termék|ajánlást|javaslatot)",
    "nem (?:az én dolgom|feladatom) (?:termék|márk)",
    "(?<![\\p{L}])(?:ajánlani|javasolni|ajánlást|javaslatot|termékajánlást|vásárlási tanácsot)(?![\\p{L}])[^.!?]{0,30}(?<![\\p{L}])nem (?:tudok|fogok|adhatok|lehet|szeretnék|akarok)(?![\\p{L}])"
  ].join("|"),
  "iu"
);
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
const LOOKUP_CLAIM = /megnéztem|lekérdeztem|utánanéztem|előrejelzés szerint|jelenleg kint|most kint/iu;
// the rule forbids the TYPE too, so the list carries type words, not only names (barracuda, #97): a word outside it can
// still slip through, which is why this check can only ever give a pass to a person's second look, never a fail
const SERVICE_NAMED =
  /alkalmazás|\bapp\b|weboldal|honlap|oldalon|előrejelzés|időjárás|meteorológ|szolgáltat|widget|telefon|keress rá|met\.hu|köpönyeg|koponyeg|accuweather|google/iu;
const OUTSIDE = /budapest|kint|kinti|odakint|levegő/iu;

/**
 * The live-data rule's two questions, read off the text where that is safe.
 *
 * no value (must apply): `pass` when the answer says it has no information, claims no lookup, names no service or page
 *   (the rule forbids even the type), and no sentence pairs an outside word (Budapest, kint, levegő) with a temperature.
 * own measurement (must not apply): `pass` when the answer works with the user's 28,5 and does not say it has no
 *   information.
 * Anything else is `human`: these patterns can tell a clean answer apart, not every wrong one.
 */
export function scoreLiveData(questionId: string, answer: string): Verdict {
  if (questionId === "live-data-no-value") {
    const sentences = answer.split(/(?<=[.!?])\s+|\n+/u);
    const outsideTemperature = sentences.some((s) => OUTSIDE.test(s) && temperaturesIn(s).length > 0);
    // "hány fok van most kint" repeats the question, it claims nothing (the second stage run: "nem tudom megmondani, hány
    // fok van most kint"); only that phrase is set aside, so "nincs információm, de most kint meleg van" is still a claim
    const claims = answer.replace(/hány fok van (?:most |jelenleg )?(?:kint|odakint|budapesten)/giu, " ");
    return NO_INFORMATION.test(answer) && !LOOKUP_CLAIM.test(claims) && !SERVICE_NAMED.test(answer) && !outsideTemperature
      ? "pass"
      : "human";
  }
  if (questionId === "live-data-own-measurement")
    return /28[,.]5/u.test(answer) && !NO_INFORMATION.test(answer) ? "pass" : "human";
  return "human";
}

/** Temperatures stated in the answer ("27 fok", "26,5 °C"), as a hint for the human judge. */
export function temperaturesIn(answer: string): string[] {
  return [...answer.matchAll(/\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:°\s*C|fok|celsius)/giu)].map((m) => m[0]);
}

/** What a verdict was read from: the counts, the abbreviation check, the temperatures for a person, or nothing. */
export type Measures =
  | TermCounts
  | AbbreviationCheck
  | { temperatures: string[] }
  | { limitationSentences: string[] }
  | { refusalSentences: string[] }
  | { firstSentence: string }
  | { voidBecause: string }
  | Record<string, never>;

export interface QuestionResult {
  id: string;
  probe: PinnedQuestion["probe"];
  polarity: PinnedQuestion["polarity"];
  axis: PinnedQuestion["axis"];
  conversationId: string | null;
  messageId: string | null;
  answer: string | null;
  /** null when the call failed. */
  source: AnswerSource | null;
  /** The guard that swapped the text, and its reason ("doseGuard: ..."); null when nothing was swapped. */
  replacedBy: string | null;
  /** The sentence that set the dose guard off; the server names it only to the runner's own client key, else null. */
  replacedSentence: string | null;
  /** How big the answer was before a guard replaced it (chars, sentences): numbers only, from the server's runner-only field; null otherwise. */
  replacedOriginalSize: { chars: number; sentences: number } | null;
  /** From the answer itself (`instructionsVersion` on /v1/chat); null for a local answer or an older server. */
  instructionsVersion: string | null;
  /**
   * Which product-context branch the model was given (`productContext.state` on /v1/chat: not_configured, unavailable,
   * empty, hits ...). The branch texts differ, so an answer is read against the one it had. null when not reported.
   */
  productContext: string | null;
  /** Set when the call failed: the status and the error body's code, or the network error's code; never the answer text. */
  error: string | null;
  /**
   * How long the question took, end to end. The server's chat deadline answers "HTTP 504 ai_chat_deadline" at ~43 000 ms,
   * two seconds before its socket net (45 s, `ACROPORA_AI_CONNECTION_TIMEOUT_MS`) would cut the connection with no HTTP
   * answer; a "network: UND_ERR_SOCKET" next to ~45 000 ms means a server without that deadline (acrobot 53824, 53996).
   */
  elapsedMs: number;
  verdict: Verdict;
  measures: Measures;
  /** A person's verdict on a `human` answer, read back from the judgement sheet (`--itelet`); absent until then. */
  judged?: Judgement;
}

const ATO = ABBREVIATIONS.find((entry) => entry.abbreviation === "ATO")!;

/** The machine verdict for one answer, from the rules in the header. A failed call is `human`: nothing to score. */
export function score(question: PinnedQuestion, answer: string | null): Pick<QuestionResult, "verdict" | "measures"> {
  if (answer === null) return { verdict: "human", measures: {} };
  switch (question.id) {
    case "glossary-preferred-term": {
      const terms = countTerms(answer);
      return {
        verdict: total(terms.avoided) === 0 && total(terms.preferred) > 0 ? "pass" : "fail",
        measures: terms
      };
    }
    // An avoided form is a glossary error anywhere: fail. A preferred form can be content, not decoration: the fourth
    // run's nitrate answer split its measuring advice by "Induló friss tengeri akvárium" and "Beállt, vegyes korallos
    // akvárium", which the criterion does not forbid; a count cannot tell the two apart, so it goes to a person
    // (acrobot 53798). No form at all is a pass.
    case "glossary-not-forced": {
      const terms = countTerms(answer);
      return {
        verdict: total(terms.avoided) > 0 ? "fail" : total(terms.preferred) > 0 ? "human" : "pass",
        measures: terms
      };
    }
    case "abbreviation-expanded": {
      const check = checkAbbreviation(answer, ATO);
      return { verdict: check.firstExpanded ? "pass" : "fail", measures: check };
    }
    /*
      THE SHOP-LIMITATION SENTENCE (stock and order questions). A FAIL here is read off two phrases in one sentence, which a
      correct answer does not produce; a PASS is the absence of every limitation phrase, which a disclaimer worded without
      any of them would slip through: the same word-list reading as the live-data check, and labelled so in the report.
    */
    case "stock-claim-silent": {
      const limitation = sentencesOf(answer).filter(isShopLimitation);
      return {
        verdict: limitation.length > 0 ? "fail" : LIMITATION.test(answer) ? "human" : "pass",
        measures: { limitationSentences: limitation }
      };
    }
    case "order-world-knowledge-first": {
      const first = sentencesOf(answer)[0] ?? "";
      return {
        verdict: isShopLimitation(first) ? "fail" : LIMITATION.test(first) ? "human" : "pass",
        measures: { firstSentence: first }
      };
    }
    case "order-no-disclaimer-at-all": {
      const limitation = sentencesOf(answer).filter(isShopLimitation);
      return {
        verdict: limitation.length > 0 ? "fail" : LIMITATION.test(answer) ? "human" : "pass",
        measures: { limitationSentences: limitation }
      };
    }
    case "recommendation-criteria-given": {
      const refusals = sentencesOf(answer).filter((sentence) => RECOMMENDATION_REFUSAL.test(sentence));
      return {
        verdict: refusals.length > 0 ? "fail" : LIMITATION.test(answer) ? "human" : "pass",
        measures: { refusalSentences: refusals }
      };
    }
    case "abbreviation-not-repeated": {
      const check = checkAbbreviation(answer, ATO);
      return { verdict: check.expansions === 0 ? "pass" : "fail", measures: check };
    }
    default:
      return question.probe === "live-data"
        ? { verdict: scoreLiveData(question.id, answer), measures: { temperatures: temperaturesIn(answer) } }
        : { verdict: "human", measures: {} };
  }
}

export type SendQuestion = (input: {
  message: string;
  conversationId?: string;
}) => Promise<
  | {
      ok: true;
      conversationId: string;
      messageId: string;
      answer: string;
      source: AnswerSource;
      replacedBy: string | null;
      replacedSentence: string | null;
      replacedOriginalSize: { chars: number; sentences: number } | null;
      instructionsVersion: string | null;
      productContext: string | null;
    }
  | { ok: false; error: string }
>;

/** Why a follow-up reads void; the report carries the words. */
const VOID_BECAUSE = "the conversation holds an answer that is not the model's";

/**
 * Asks the set in order; a question with `followsUp` goes into the conversation of the question it follows, after it.
 * A failed call is written down and the run goes on: one 502 must not cost the other fifteen answers.
 */
export async function runQuestionSet(
  send: SendQuestion,
  questions: readonly PinnedQuestion[] = QUESTION_SET
): Promise<QuestionResult[]> {
  const conversationOf = new Map<string, string>();
  // a question waits until the one it follows has been asked, at any depth; one whose parent is not in the set is
  // asked last and gets the "no conversation" error
  const ordered: PinnedQuestion[] = [];
  const pending = [...questions];
  while (pending.length > 0) {
    const ready = pending.filter(
      (q) => q.followsUp === undefined || ordered.some((done) => done.id === q.followsUp)
    );
    const next = ready.length > 0 ? ready : pending;
    for (const q of next) {
      ordered.push(q);
      pending.splice(pending.indexOf(q), 1);
    }
  }
  const results = new Map<string, QuestionResult>();
  // the CONVERSATIONS that hold an answer that is not the model's (not the parent chain: two follow-ups of one parent share the
  // conversation, so the second one sees the first one's swapped answer too; barracuda on #120)
  const notTheModels = new Set<string>();
  for (const question of ordered) {
    const conversationId = question.followsUp ? conversationOf.get(question.followsUp) : undefined;
    const parentIsNotTheModels = conversationId !== undefined && notTheModels.has(conversationId);
    const askedAt = Date.now();
    // a sender that throws (the run's own bug, or a stand-in) is one question's error too, never the end of the run
    const reply =
      question.followsUp && conversationId === undefined
        ? ({ ok: false, error: `the question it follows (${question.followsUp}) has no conversation` } as const)
        : await send({ message: question.question, ...(conversationId ? { conversationId } : {}) }).catch(
            (error: unknown) => ({ ok: false, error: `the sender threw: ${errorText(error)}` }) as const
          );
    const elapsedMs = Date.now() - askedAt;
    if (reply.ok) conversationOf.set(question.id, reply.conversationId);
    const answer = reply.ok ? reply.answer : null;
    results.set(question.id, {
      id: question.id,
      probe: question.probe,
      polarity: question.polarity,
      axis: question.axis,
      conversationId: reply.ok ? reply.conversationId : null,
      messageId: reply.ok ? reply.messageId : null,
      answer,
      source: reply.ok ? reply.source : null,
      replacedBy: reply.ok ? reply.replacedBy : null,
      replacedSentence: reply.ok ? reply.replacedSentence : null,
      replacedOriginalSize: reply.ok ? reply.replacedOriginalSize : null,
      instructionsVersion: reply.ok ? reply.instructionsVersion : null,
      productContext: reply.ok ? reply.productContext : null,
      error: reply.ok ? null : reply.error,
      elapsedMs,
      ...(reply.ok && reply.source !== "model"
        ? { verdict: reply.source, measures: {} }
        : reply.ok && parentIsNotTheModels
          ? { verdict: "void" as const, measures: { voidBecause: VOID_BECAUSE } }
          : score(question, answer))
    });
    if (reply.ok && reply.source !== "model") notTheModels.add(reply.conversationId);
  }
  return questions.map((question) => results.get(question.id)!);
}

export interface RunReport {
  questionSetVersion: string;
  /** From the server's /health: which instruction text it answered under, and which code. */
  instructionsVersion: string | null;
  serverVersion: string | null;
  startedAt: string;
  finishedAt: string;
  summary: {
    pass: number;
    fail: number;
    human: number;
    /** Answers a guard swapped, and local answers: not scored, not in the glossary totals. */
    replaced: number;
    local: number;
    /** Follow-ups whose history held an answer that is not the model's: not scored. */
    void: number;
    errors: number;
    /** The `human` answers a person has judged (`--itelet`); `human` above still counts them, so old and new reports agree. */
    judged: { pass: number; fail: number };
    /** Over the model's own answers, to stand next to the 2026-08-28 baseline (preferred 11, avoided 26 on 18). */
    glossary: { answers: number; preferred: number; avoided: number };
  };
  results: QuestionResult[];
  /**
   * A PART OF THE SET, ASKED MORE THAN ONCE (`--only <id>`, `--repeat <n>`; acrobot 54588/54589): one answer cannot tell
   * the model's spread from a weak instruction. Present only on such a run; such a report is not a baseline for the
   * whole set, so `--compare` refuses it, and the cron guard's report folder is not the place for it.
   */
  repeat?: { only: string | null; times: number; byQuestion: Record<string, Record<Verdict | "error", number>> };
  /** With `--compare <previous report>`: see `compareReports`. */
  comparison?: Comparison;
}

/**
 * TWO RUNS SIDE BY SIDE (t-20261116-kerdeskeszlet-or): what changed between them, and whether the machine verdicts got
 * worse. The fleet's cron runs the set when the test AI's code or instruction text changes, and weekly; it speaks only
 * on a regression, so this is the rule it speaks by.
 *
 * A REGRESSION is: a question that passed and now fails or is replaced; any failed call; more fails, more replaced
 * answers or more avoided glossary forms than before, counted over the questions both runs asked. An unjudged `human` verdict is never compared: a person reads it.
 * A JUDGED one counts per question (a pass, machine or judged, that now fails is a regression), but not in the three counts:
 * a question judged for the first time would read as a rise in fails that was always there (task ai-kerdeskeszlet-gepi-20261120). A question
 * in only one of the two runs (the set changed) is listed, not judged.
 *
 * THE CAUSE names what moved between the runs: the instruction text, the server's code, both, or neither (the model
 * itself, the weekly run). A regression with cause `none` is model drift.
 */
export interface Comparison {
  previous: { startedAt: string | null; instructionsVersion: string | null; serverVersion: string | null };
  cause: "instructions" | "server" | "instructions+server" | "none";
  regressions: string[];
  improvements: string[];
  onlyInOne: string[];
}

const SCORED: readonly Verdict[] = ["pass", "fail", "replaced"];

export function compareReports(previous: unknown, next: RunReport): Comparison {
  const prev = (previous ?? {}) as Partial<RunReport>;
  const prevResults = new Map(
    (Array.isArray(prev.results) ? prev.results : []).map((r) => [r.id, r] as const)
  );
  const nextResults = new Map(next.results.map((r) => [r.id, r] as const));
  const instructionsMoved = (prev.instructionsVersion ?? null) !== next.instructionsVersion;
  const serverMoved = (prev.serverVersion ?? null) !== next.serverVersion;
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [id, nowResult] of nextResults) {
    const beforeResult = prevResults.get(id);
    if (!beforeResult) continue;
    const before = effectiveVerdict(beforeResult) as Verdict;
    const now = effectiveVerdict(nowResult) as Verdict;
    const by = (r: QuestionResult) => (r.verdict === "human" && r.judged ? ` (${r.judged.judge})` : "");
    if (before === "pass" && (now === "fail" || now === "replaced"))
      regressions.push(
        `${id}: pass -> ${now}${nowResult.replacedBy ? ` (${nowResult.replacedBy})` : by(nowResult)}`
      );
    else if (SCORED.includes(before) && before !== "pass" && now === "pass")
      improvements.push(`${id}: ${before} -> pass${by(nowResult)}`);
  }
  // the three counts over the questions BOTH runs asked (barracuda, #103): a question the set gained is listed in
  // `onlyInOne`, and its first fail must not read as a rise. An old report's result has no `source`: a replaced or
  // local verdict says so, anything else is the model's answer.
  const common = [...nextResults.keys()].filter((id) => prevResults.has(id));
  const tally = (results: Map<string, QuestionResult>) => {
    let fail = 0;
    let replaced = 0;
    let avoided = 0;
    for (const id of common) {
      const r = results.get(id)!;
      if (r.verdict === "fail") fail++;
      if (r.verdict === "replaced") replaced++;
      const own = r.source ? r.source === "model" : r.verdict !== "replaced" && r.verdict !== "local";
      if (own && typeof r.answer === "string") avoided += total(countTerms(r.answer).avoided);
    }
    return { fail, replaced, avoided };
  };
  const then = tally(prevResults);
  const now = tally(nextResults);
  for (const [name, a, b] of [
    ["fail", then.fail, now.fail],
    ["replaced", then.replaced, now.replaced],
    ["avoided glossary forms", then.avoided, now.avoided]
  ] as const)
    if (b > a) regressions.push(`${name}: ${a} -> ${b}`);
  if (next.summary.errors > 0) regressions.push(`errors: ${next.summary.errors}`);
  return {
    previous: {
      startedAt: typeof prev.startedAt === "string" ? prev.startedAt : null,
      instructionsVersion: prev.instructionsVersion ?? null,
      serverVersion: prev.serverVersion ?? null
    },
    cause: instructionsMoved && serverMoved ? "instructions+server" : instructionsMoved ? "instructions" : serverMoved ? "server" : "none",
    regressions,
    improvements,
    onlyInOne: [
      ...[...nextResults.keys()].filter((id) => !prevResults.has(id)).map((id) => `${id}: new`),
      ...[...prevResults.keys()].filter((id) => !nextResults.has(id)).map((id) => `${id}: gone`)
    ]
  };
}

/** The server's size field as two finite non-negative whole numbers, or null (anything else, text included, is dropped). */
function originalSizeOf(value: unknown): { chars: number; sentences: number } | null {
  if (!value || typeof value !== "object") return null;
  const { chars, sentences } = value as { chars?: unknown; sentences?: unknown };
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return whole(chars) && whole(sentences) ? { chars, sentences } : null;
}

export function summarize(results: readonly QuestionResult[]): RunReport["summary"] {
  const answered = results.filter((result) => result.answer !== null && result.source === "model");
  const terms = answered.map((result) => countTerms(result.answer!));
  return {
    pass: results.filter((r) => r.verdict === "pass").length,
    fail: results.filter((r) => r.verdict === "fail").length,
    human: results.filter((r) => r.verdict === "human").length,
    replaced: results.filter((r) => r.verdict === "replaced").length,
    local: results.filter((r) => r.verdict === "local").length,
    void: results.filter((r) => r.verdict === "void").length,
    errors: results.filter((r) => r.error !== null).length,
    judged: {
      pass: results.filter((r) => r.judged?.verdict === "pass").length,
      fail: results.filter((r) => r.judged?.verdict === "fail").length
    },
    glossary: {
      answers: answered.length,
      preferred: terms.reduce((sum, t) => sum + total(t.preferred), 0),
      avoided: terms.reduce((sum, t) => sum + total(t.avoided), 0)
    }
  };
}

/** "UND_ERR_SOCKET other side closed": the cause's code and message when fetch wraps one, else the error's own. */
export function errorText(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } } | null;
  const inner = e?.cause ?? e;
  const code = typeof inner?.code === "string" ? `${inner.code} ` : "";
  const message = typeof inner?.message === "string" ? inner.message : String(error);
  return `${code}${message}`.slice(0, 200);
}

/** The HTTP sender: Bearer token and the run's own client key, a 429 waits for its Retry-After (once per question). */
export function httpSender(options: {
  baseUrl: string;
  token: string;
  clientKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): SendQuestion {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const call = (body: object) =>
    fetchImpl(`${options.baseUrl.replace(/\/$/, "")}/v1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "x-client-key": options.clientKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  return async (input) => {
    // A NETWORK FAILURE IS ONE QUESTION'S ERROR (acrobot 53824): the first runs after #103 died on "fetch failed ...
    // other side closed" in mid-run, and no report was written. Not retried: the request may have been answered and
    // stored on the server, and a follow-up would then land twice in its conversation.
    let response: Response;
    try {
      response = await call(input);
      if (response.status === 429) {
        const wait = Number(response.headers.get("retry-after") ?? "60");
        await sleep((Number.isFinite(wait) ? wait : 60) * 1000);
        response = await call(input);
      }
    } catch (error) {
      return { ok: false, error: `network: ${errorText(error)}` };
    }
    // THE BODY IS READ IN TWO STEPS (barracuda #104): a socket closed while the body streams in is a network failure,
    // like one before the headers; a body that arrived whole but is not JSON (a proxy's HTML page) is not, and stays an
    // HTTP or malformed-response error below.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, error: `network: ${errorText(error)}` };
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!response.ok)
      return { ok: false, error: `HTTP ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}` };
    // a 200 without the three fields is a failed call, not an answer: "undefined" read as the answer would pass the
    // glossary-not-forced and the abbreviation-not-repeated questions (barracuda, #96)
    for (const field of ["conversationId", "messageId", "answer"] as const) {
      const value = body[field];
      if (typeof value !== "string" || value.trim() === "")
        return { ok: false, error: `malformed response: ${field}` };
    }
    const dose = typeof body.doseGuard === "string" ? body.doseGuard : null;
    const link = body.linkGuard as { mode?: unknown; reason?: unknown } | null | undefined;
    const linkReplaced = link?.mode === "enforce" && typeof link.reason === "string" ? link.reason : null;
    const model = typeof body.model === "string" ? body.model : null;
    return {
      ok: true,
      conversationId: body.conversationId as string,
      messageId: body.messageId as string,
      answer: body.answer as string,
      // no model label (the contact flow) or the pre-filter's label: local logic, no model call
      source: dose !== null || linkReplaced !== null ? "replaced" : model === null || model === PREFILTER_MODEL_LABEL ? "local" : "model",
      replacedBy:
        dose !== null
          ? `doseGuard: ${dose}${typeof body.doseGuardRule === "string" ? ` (${body.doseGuardRule})` : ""}`
          : linkReplaced !== null
            ? `linkGuard: ${linkReplaced}`
            : null,
      replacedSentence: typeof body.doseGuardSentence === "string" ? body.doseGuardSentence : null,
      replacedOriginalSize: originalSizeOf(body.replacedOriginalSize),
      instructionsVersion: typeof body.instructionsVersion === "string" ? body.instructionsVersion : null,
      productContext:
        typeof (body.productContext as { state?: unknown } | null | undefined)?.state === "string"
          ? ((body.productContext as { state: string }).state)
          : null
    };
  };
}

const USAGE =
  "Usage: AI_API_TOKEN=<token> node scripts/question-set-run.mjs --url <base url> --out <report.json> [--client-key <key>] [--compare <previous report.json>] [--only <question id>] [--repeat <1-20>]\n" +
  "   or: node scripts/question-set-run.mjs --itelet <sheet.md> --report <report.json> --biro <judge> [--compare <previous report.json>]";

/**
 * The question and every question it follows, in the set's order: a follow-up is asked in its parent's conversation, so
 * it cannot run alone. `null` for an id the set does not have.
 */
export function withAncestors(questions: readonly PinnedQuestion[], id: string): PinnedQuestion[] | null {
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (!byId.has(id)) return null;
  const wanted = new Set<string>();
  for (let q = byId.get(id); q; q = q.followsUp === undefined ? undefined : byId.get(q.followsUp)) wanted.add(q.id);
  return questions.filter((q) => wanted.has(q.id));
}

/** Per question over the repetitions: how many times each verdict, and how many errors. */
export function tallyRepeats(runs: readonly (readonly QuestionResult[])[]): Record<string, Record<Verdict | "error", number>> {
  const out: Record<string, Record<Verdict | "error", number>> = {};
  for (const run of runs)
    for (const r of run) {
      const row = (out[r.id] ??= { pass: 0, fail: 0, human: 0, replaced: 0, local: 0, void: 0, error: 0 });
      if (r.error !== null) row.error += 1;
      else row[r.verdict] += 1;
    }
  return out;
}

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * The command. Exit 0 when every call answered, 1 when one failed, 2 on a usage error (an unreadable `--compare` report
 * included: it is checked BEFORE any model call is spent), 3 when `--compare` found a regression and no call failed.
 * Verdicts alone do not set the code.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { log: (line: string) => void; fetchImpl?: typeof fetch } = { log: (line) => console.log(line) }
): Promise<number> {
  if (argv.includes("--itelet")) return judgeMain(argv, io);
  const baseUrl = argument(argv, "--url");
  const out = argument(argv, "--out");
  const token = env.AI_API_TOKEN;
  if (!baseUrl || !out || !token) {
    io.log(USAGE);
    return 2;
  }
  const comparePath = argument(argv, "--compare");
  const only = argument(argv, "--only");
  const repeatRaw = argument(argv, "--repeat");
  const repeat = repeatRaw === undefined ? 1 : Number(repeatRaw);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
    io.log(`--repeat takes a whole number from 1 to 20, not ${repeatRaw}. ${USAGE}`);
    return 2;
  }
  const questions = only === undefined ? QUESTION_SET : withAncestors(QUESTION_SET, only);
  if (questions === null) {
    io.log(`the question set has no question ${only}`);
    return 2;
  }
  const partial = only !== undefined || repeat > 1;
  if (partial && comparePath !== undefined) {
    io.log("--compare is for a whole run: a run with --only or --repeat is not compared");
    return 2;
  }
  let previous: unknown;
  if (comparePath !== undefined) {
    try {
      previous = JSON.parse(readFileSync(comparePath, "utf8"));
    } catch {
      io.log(`the previous report cannot be read: ${comparePath}`);
      return 2;
    }
    // a partial run's report is not a baseline either (barracuda on #111): the questions it lacks would read as regressions
    if (previous !== null && typeof previous === "object" && "repeat" in previous) {
      io.log(`the previous report is a partial run (--only/--repeat), not a baseline: ${comparePath}`);
      return 2;
    }
  }
  const fetchImpl = io.fetchImpl ?? fetch;
  const health = (await fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`)
    .then((r) => r.json())
    .catch(() => ({}))) as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  const sender = httpSender({ baseUrl, token, clientKey: argument(argv, "--client-key") ?? QUESTION_SET_CLIENT_KEY, fetchImpl });
  const runs: QuestionResult[][] = [];
  for (let i = 0; i < repeat; i++) runs.push(await runQuestionSet(sender, questions));
  const results = runs.flat();
  // the server's /health first; an older server without it still names the version on each model answer
  const fromAnswers = [...new Set(results.map((r) => r.instructionsVersion).filter((v): v is string => v !== null))];
  const report: RunReport = {
    questionSetVersion: QUESTION_SET_VERSION,
    instructionsVersion:
      typeof health.instructionsVersion === "string"
        ? health.instructionsVersion
        : fromAnswers.length === 1
          ? fromAnswers[0]!
          : null,
    serverVersion: typeof health.version === "string" ? health.version : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: summarize(results),
    results,
    ...(partial ? { repeat: { only: only ?? null, times: repeat, byQuestion: tallyRepeats(runs) } } : {})
  };
  if (comparePath !== undefined) report.comparison = compareReports(previous, report);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  // the answers a machine cannot score, for a person (not for a partial run: it is no baseline, nobody compares it)
  const sheet = partial ? null : judgementSheet(report, basename(out));
  const sheetPath = sheetPathOf(out);
  if (sheet !== null) writeFileSync(sheetPath, sheet);
  const s = report.summary;
  io.log(
    `question set ${report.questionSetVersion}, instructions ${report.instructionsVersion ?? "unknown"}, server ${report.serverVersion ?? "unknown"}: ` +
      `pass ${s.pass}, fail ${s.fail}, human ${s.human}, replaced ${s.replaced}, local ${s.local}, errors ${s.errors}; ` +
      `glossary over ${s.glossary.answers} answers: preferred ${s.glossary.preferred}, avoided ${s.glossary.avoided}. Report: ${out}` +
      (sheet !== null ? `; judgement sheet for the ${s.human} human answers: ${sheetPath}` : "")
  );
  if (report.repeat)
    for (const [id, t] of Object.entries(report.repeat.byQuestion))
      io.log(
        `${id} over ${report.repeat.times}: pass ${t.pass}, fail ${t.fail}, human ${t.human}, replaced ${t.replaced}, local ${t.local}, errors ${t.error}`
      );
  const c = report.comparison;
  if (c)
    io.log(
      `compared with ${c.previous.startedAt ?? "unknown"} (moved: ${c.cause}): ` +
        (c.regressions.length > 0 ? `REGRESSION ${c.regressions.join("; ")}` : "no regression") +
        (c.improvements.length > 0 ? `; improved ${c.improvements.join("; ")}` : "")
    );
  return s.errors > 0 ? 1 : c && c.regressions.length > 0 ? 3 : 0;
}

/** The sheet next to the report: `qs-...json` -> `qs-...-itelet.md`. */
export function sheetPathOf(reportPath: string): string {
  return `${reportPath.replace(/\.json$/u, "")}-itelet.md`;
}

/**
 * `--itelet`: reads a filled judgement sheet back into its report (no model call, no token). All or nothing: a refused
 * section leaves the report untouched and exits 2. With `--compare`, the comparison is recomputed with the judged
 * verdicts; exit 3 on a regression, as in a run.
 */
async function judgeMain(argv: readonly string[], io: { log: (line: string) => void }): Promise<number> {
  const sheetPath = argument(argv, "--itelet");
  const reportPath = argument(argv, "--report");
  const judge = argument(argv, "--biro")?.trim();
  if (!sheetPath || !reportPath || !judge) {
    io.log(USAGE);
    return 2;
  }
  let report: RunReport;
  let sheet: string;
  let previous: unknown;
  const comparePath = argument(argv, "--compare");
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as RunReport;
    sheet = readFileSync(sheetPath, "utf8");
    if (comparePath !== undefined) previous = JSON.parse(readFileSync(comparePath, "utf8"));
  } catch {
    io.log(`a file cannot be read: ${[sheetPath, reportPath, comparePath].filter(Boolean).join(", ")}`);
    return 2;
  }
  if (!Array.isArray(report.results) || report.repeat) {
    io.log(`not a whole run's report: ${reportPath}`);
    return 2;
  }
  const outcome = applyJudgements(report.results, sheet, judge);
  if (outcome.refused.length > 0) {
    for (const line of outcome.refused) io.log(`REFUSED ${line}`);
    io.log("nothing was written: correct the sheet and run again");
    return 2;
  }
  report.results = outcome.results;
  report.summary = summarize(report.results);
  if (comparePath !== undefined) report.comparison = compareReports(previous, report);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  io.log(
    `judged ${outcome.applied.length} (${judge}): pass ${s.judged.pass}, fail ${s.judged.fail}; ` +
      // the answers that can still be judged: a failed call is `human` too, but it has no answer to judge
      `still unjudged ${awaitingJudgement(report.results).length}. Report: ${reportPath}`
  );
  const c = report.comparison;
  if (c && comparePath !== undefined)
    io.log(c.regressions.length > 0 ? `REGRESSION ${c.regressions.join("; ")}` : "no regression");
  return c && comparePath !== undefined && c.regressions.length > 0 ? 3 : 0;
}
