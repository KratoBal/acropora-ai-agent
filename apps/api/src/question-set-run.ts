import { writeFileSync } from "node:fs";

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
 * Everything else is `human`: the live-data answers can name a temperature legitimately (the aquarium's own target),
 * so a regex would mark a correct answer wrong. The temperatures found are listed as a hint, not as a verdict.
 *
 * The 2026-08-28 baseline (18 answers: preferred 11, avoided 26, wrong translation 0) is in glossary.ts; the summary
 * gives the same two counts, so the two can stand side by side.
 */

export type Verdict = "pass" | "fail" | "human";

export interface TermCounts {
  preferred: Record<string, number>;
  avoided: Record<string, number>;
}

const lower = (text: string) => text.toLocaleLowerCase("hu");

/**
 * Occurrences of each form, longest first and without overlap: "fehérjelehabzó" is one preferred form, not also a
 * "lehabzó". A suffix is part of the word in Hungarian ("zátonyakváriumot"), so a form counts where the word starts
 * with it.
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

/** Temperatures stated in the answer ("27 fok", "26,5 °C"), as a hint for the human judge. */
export function temperaturesIn(answer: string): string[] {
  return [...answer.matchAll(/\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:°\s*C|fok|celsius)/giu)].map((m) => m[0]);
}

/** What a verdict was read from: the counts, the abbreviation check, the temperatures for a person, or nothing. */
export type Measures =
  | TermCounts
  | AbbreviationCheck
  | { temperatures: string[] }
  | Record<string, never>;

export interface QuestionResult {
  id: string;
  probe: PinnedQuestion["probe"];
  polarity: PinnedQuestion["polarity"];
  axis: PinnedQuestion["axis"];
  conversationId: string | null;
  messageId: string | null;
  answer: string | null;
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
    case "glossary-not-forced": {
      const terms = countTerms(answer);
      return {
        verdict: total(terms.avoided) + total(terms.preferred) === 0 ? "pass" : "fail",
        measures: terms
      };
    }
    case "abbreviation-expanded": {
      const check = checkAbbreviation(answer, ATO);
      return { verdict: check.firstExpanded ? "pass" : "fail", measures: check };
    }
    case "abbreviation-not-repeated": {
      const check = checkAbbreviation(answer, ATO);
      return { verdict: check.expansions === 0 ? "pass" : "fail", measures: check };
    }
    default:
      return {
        verdict: "human",
        measures: question.probe === "live-data" ? { temperatures: temperaturesIn(answer) } : {}
      };
  }
}

export type SendQuestion = (input: {
  message: string;
  conversationId?: string;
}) => Promise<
  | { ok: true; conversationId: string; messageId: string; answer: string }
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
  const ordered = [...questions].sort(
    (a, b) => Number(a.followsUp !== undefined) - Number(b.followsUp !== undefined)
  );
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
      error: reply.ok ? null : reply.error,
      ...score(question, answer)
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
    errors: number;
    /** Over every answer of the run, to stand next to the 2026-08-28 baseline (preferred 11, avoided 26 on 18). */
    glossary: { answers: number; preferred: number; avoided: number };
  };
  results: QuestionResult[];
}

export function summarize(results: readonly QuestionResult[]): RunReport["summary"] {
  const answered = results.filter((result) => result.answer !== null);
  const terms = answered.map((result) => countTerms(result.answer!));
  return {
    pass: results.filter((r) => r.verdict === "pass").length,
    fail: results.filter((r) => r.verdict === "fail").length,
    human: results.filter((r) => r.verdict === "human").length,
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
    return {
      ok: true,
      conversationId: String(body.conversationId),
      messageId: String(body.messageId),
      answer: String(body.answer)
    };
  };
}

const USAGE =
  "Usage: AI_API_TOKEN=<token> node scripts/question-set-run.mjs --url <base url> --out <report.json> [--client-key <key>]";

function argument(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The command. Exit 0 when every call answered, 1 when one failed, 2 on a usage error. Verdicts do not set the code. */
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
  const fetchImpl = io.fetchImpl ?? fetch;
  const health = (await fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`)
    .then((r) => r.json())
    .catch(() => ({}))) as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  const results = await runQuestionSet(
    httpSender({ baseUrl, token, clientKey: argument(argv, "--client-key") ?? "question-set-run", fetchImpl })
  );
  const report: RunReport = {
    questionSetVersion: QUESTION_SET_VERSION,
    instructionsVersion: typeof health.instructionsVersion === "string" ? health.instructionsVersion : null,
    serverVersion: typeof health.version === "string" ? health.version : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: summarize(results),
    results
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const s = report.summary;
  io.log(
    `question set ${report.questionSetVersion}, instructions ${report.instructionsVersion ?? "unknown"}, server ${report.serverVersion ?? "unknown"}: ` +
      `pass ${s.pass}, fail ${s.fail}, human ${s.human}, errors ${s.errors}; ` +
      `glossary over ${s.glossary.answers} answers: preferred ${s.glossary.preferred}, avoided ${s.glossary.avoided}. Report: ${out}`
  );
  return s.errors > 0 ? 1 : 0;
}
