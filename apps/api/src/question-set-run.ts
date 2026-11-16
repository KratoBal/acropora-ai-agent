import { readFileSync, writeFileSync } from "node:fs";

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

export type Verdict = "pass" | "fail" | "human" | "replaced" | "local";

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
  | { firstSentence: string }
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
  /** The sentence that set the dose guard off, when the server's debug switch is on (the test AI only); else null. */
  replacedSentence: string | null;
  /** From the answer itself (`instructionsVersion` on /v1/chat); null for a local answer or an older server. */
  instructionsVersion: string | null;
  /**
   * Which product-context branch the model was given (`productContext.state` on /v1/chat: not_configured, unavailable,
   * empty, hits ...). The branch texts differ, so an answer is read against the one it had. null when not reported.
   */
  productContext: string | null;
  /** Set when the call failed: the status and the error body's code, never the answer text. */
  error: string | null;
  verdict: Verdict;
  measures: Measures;
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
      instructionsVersion: string | null;
      productContext: string | null;
    }
  | { ok: false; error: string }
>;

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
  for (const question of ordered) {
    const conversationId = question.followsUp ? conversationOf.get(question.followsUp) : undefined;
    const reply =
      question.followsUp && conversationId === undefined
        ? ({ ok: false, error: `the question it follows (${question.followsUp}) has no conversation` } as const)
        : await send({ message: question.question, ...(conversationId ? { conversationId } : {}) });
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
      instructionsVersion: reply.ok ? reply.instructionsVersion : null,
      productContext: reply.ok ? reply.productContext : null,
      error: reply.ok ? null : reply.error,
      ...(reply.ok && reply.source !== "model"
        ? { verdict: reply.source, measures: {} }
        : score(question, answer))
    });
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
    errors: number;
    /** Over the model's own answers, to stand next to the 2026-08-28 baseline (preferred 11, avoided 26 on 18). */
    glossary: { answers: number; preferred: number; avoided: number };
  };
  results: QuestionResult[];
  /** With `--compare <previous report>`: see `compareReports`. */
  comparison?: Comparison;
}

/**
 * TWO RUNS SIDE BY SIDE (t-20261116-kerdeskeszlet-or): what changed between them, and whether the machine verdicts got
 * worse. The fleet's cron runs the set when the test AI's code or instruction text changes, and weekly; it speaks only
 * on a regression, so this is the rule it speaks by.
 *
 * A REGRESSION is: a question that passed and now fails or is replaced; any failed call; more fails, more replaced
 * answers or more avoided glossary forms than before. A `human` verdict is never compared: a person reads it. A question
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
  for (const [id, now] of nextResults) {
    const before = prevResults.get(id);
    if (!before) continue;
    if (before.verdict === "pass" && (now.verdict === "fail" || now.verdict === "replaced"))
      regressions.push(`${id}: pass -> ${now.verdict}${now.replacedBy ? ` (${now.replacedBy})` : ""}`);
    else if (SCORED.includes(before.verdict) && before.verdict !== "pass" && now.verdict === "pass")
      improvements.push(`${id}: ${before.verdict} -> pass`);
  }
  const before = prev.summary;
  const counts: [string, number, number | undefined][] = [
    ["fail", next.summary.fail, before?.fail],
    ["replaced", next.summary.replaced, before?.replaced],
    ["avoided glossary forms", next.summary.glossary.avoided, before?.glossary?.avoided]
  ];
  for (const [name, now, then] of counts)
    if (typeof then === "number" && now > then) regressions.push(`${name}: ${then} -> ${now}`);
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

export function summarize(results: readonly QuestionResult[]): RunReport["summary"] {
  const answered = results.filter((result) => result.answer !== null && result.source === "model");
  const terms = answered.map((result) => countTerms(result.answer!));
  return {
    pass: results.filter((r) => r.verdict === "pass").length,
    fail: results.filter((r) => r.verdict === "fail").length,
    human: results.filter((r) => r.verdict === "human").length,
    replaced: results.filter((r) => r.verdict === "replaced").length,
    local: results.filter((r) => r.verdict === "local").length,
    errors: results.filter((r) => r.error !== null).length,
    glossary: {
      answers: answered.length,
      preferred: terms.reduce((sum, t) => sum + total(t.preferred), 0),
      avoided: terms.reduce((sum, t) => sum + total(t.avoided), 0)
    }
  };
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
    let response = await call(input);
    if (response.status === 429) {
      const wait = Number(response.headers.get("retry-after") ?? "60");
      await sleep((Number.isFinite(wait) ? wait : 60) * 1000);
      response = await call(input);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
      instructionsVersion: typeof body.instructionsVersion === "string" ? body.instructionsVersion : null,
      productContext:
        typeof (body.productContext as { state?: unknown } | null | undefined)?.state === "string"
          ? ((body.productContext as { state: string }).state)
          : null
    };
  };
}

const USAGE =
  "Usage: AI_API_TOKEN=<token> node scripts/question-set-run.mjs --url <base url> --out <report.json> [--client-key <key>] [--compare <previous report.json>]";

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
  const baseUrl = argument(argv, "--url");
  const out = argument(argv, "--out");
  const token = env.AI_API_TOKEN;
  if (!baseUrl || !out || !token) {
    io.log(USAGE);
    return 2;
  }
  const comparePath = argument(argv, "--compare");
  let previous: unknown;
  if (comparePath !== undefined) {
    try {
      previous = JSON.parse(readFileSync(comparePath, "utf8"));
    } catch {
      io.log(`the previous report cannot be read: ${comparePath}`);
      return 2;
    }
  }
  const fetchImpl = io.fetchImpl ?? fetch;
  const health = (await fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`)
    .then((r) => r.json())
    .catch(() => ({}))) as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  const results = await runQuestionSet(
    httpSender({ baseUrl, token, clientKey: argument(argv, "--client-key") ?? "question-set-run", fetchImpl })
  );
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
    results
  };
  if (comparePath !== undefined) report.comparison = compareReports(previous, report);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  io.log(
    `question set ${report.questionSetVersion}, instructions ${report.instructionsVersion ?? "unknown"}, server ${report.serverVersion ?? "unknown"}: ` +
      `pass ${s.pass}, fail ${s.fail}, human ${s.human}, replaced ${s.replaced}, local ${s.local}, errors ${s.errors}; ` +
      `glossary over ${s.glossary.answers} answers: preferred ${s.glossary.preferred}, avoided ${s.glossary.avoided}. Report: ${out}`
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
