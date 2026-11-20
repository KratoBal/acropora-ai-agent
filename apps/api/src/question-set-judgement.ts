import { createHash } from "node:crypto";

import { QUESTION_SET } from "./question-set.js";

/**
 * THE JUDGEMENT SHEET FOR THE `human` ANSWERS (task ai-kerdeskeszlet-gepi-20261120, acrobot 58658, 58661).
 *
 * In the thirteen runs of 11-16 and 11-17 every run left six to ten answers `human`, and no human verdict was ever
 * recorded anywhere: the half of the set a machine cannot score went unread. This gives that half a place without a new
 * surface: the runner writes a Markdown sheet next to its JSON report, a judge (barracuda: independent of the model under
 * test, and working from the criterion; acrobot 58661) fills in one line per answer, and `--itelet` reads it back into
 * the report, where the comparison sees it.
 *
 * THE SHEET IS BOUND TO ITS ANSWERS. Each section carries the answer's fingerprint (`lenyomat`); a verdict is taken only
 * when the report's answer has the same one. A sheet from another run, or an answer edited in the sheet, is refused, not
 * applied to whatever answer now stands under that id.
 *
 * ALL OR NOTHING. One unreadable section (an unknown id, a verdict that is not pass or fail, a verdict without a reason,
 * a fingerprint that does not match) refuses the whole sheet: a half-applied sheet would be a report nobody can trust.
 * An EMPTY verdict is no error: that answer stays `human`.
 */

export type JudgedVerdict = "pass" | "fail";

export interface Judgement {
  verdict: JudgedVerdict;
  /** Who judged: a name, not a role ("barracuda"). */
  judge: string;
  /** One sentence: why the answer does or does not meet the criterion. Required: a bare verdict cannot be checked. */
  reason: string;
  /** The fingerprint of the answer the verdict was given on. */
  answer: string;
}

/** The fields of a result the sheet reads and writes. */
export interface JudgeableResult {
  id: string;
  verdict: string;
  answer: string | null;
  judged?: Judgement;
}

/** The answer's fingerprint: 16 hex characters of its SHA-256, enough to tell two answers apart, short enough to read. */
export function answerFingerprint(answer: string): string {
  return createHash("sha256").update(answer, "utf8").digest("hex").slice(0, 16);
}

/** The results a person has to judge: a `human` verdict on an answer that exists and is not judged yet. */
export function awaitingJudgement<T extends JudgeableResult>(results: readonly T[]): T[] {
  return results.filter((r) => r.verdict === "human" && typeof r.answer === "string" && !r.judged);
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** The sheet, in Markdown. `null` when nothing waits for a person. */
export function judgementSheet(
  report: {
    questionSetVersion: string;
    instructionsVersion: string | null;
    serverVersion: string | null;
    startedAt: string;
    results: readonly JudgeableResult[];
  },
  reportName: string
): string | null {
  const waiting = awaitingJudgement(report.results);
  if (waiting.length === 0) return null;
  const sections = waiting.map((result) => {
    const question = QUESTION_SET.find((q) => q.id === result.id);
    return [
      `## ${result.id}`,
      "",
      question
        ? `proba: ${question.probe}, ${question.polarity}, tengely: ${question.axis}`
        : "proba: (a kerdes mar nincs a keszletben)",
      `kerdes: ${question?.question ?? "-"}`,
      `kriterium: ${question?.criterion ?? "-"}`,
      `lenyomat: ${answerFingerprint(result.answer!)}`,
      "valasz:",
      quote(result.answer!),
      "",
      "itelet:",
      "indok:",
      ""
    ].join("\n");
  });
  return [
    "# Kerdeskeszlet itelet-lap",
    "",
    `Riport: ${reportName}, kerdeskeszlet ${report.questionSetVersion}, utasitas ${report.instructionsVersion ?? "-"}, szerver ${report.serverVersion ?? "-"}, inditva ${report.startedAt}`,
    "",
    "Kitoltes: szakaszonkent az `itelet:` utan `pass` vagy `fail` (a kriterium szerint, nem izles szerint), az `indok:` utan egy mondat, hogy miert. Ures itelet: az a valasz ember-iteletu marad. A `lenyomat` sort ne ird at: azzal kotodik az itelet a valaszhoz.",
    "",
    ...sections
  ].join("\n");
}

export interface ApplyOutcome<T> {
  results: T[];
  applied: string[];
  /** Why the sheet was refused, section by section; non-empty means nothing was applied. */
  refused: string[];
}

/** Reads a filled sheet back. Nothing is changed unless every non-empty section is valid (see the header). */
export function applyJudgements<T extends JudgeableResult>(
  results: readonly T[],
  sheet: string,
  judge: string
): ApplyOutcome<T> {
  const byId = new Map(results.map((r) => [r.id, r] as const));
  const verdicts = new Map<string, Judgement>();
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const section of sheet.split(/^## /mu).slice(1)) {
    const id = section.split("\n", 1)[0]!.trim();
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, "mu").exec(section)?.[1]?.trim() ?? null;
    const verdict = field("itelet");
    if (!verdict) continue;
    if (seen.has(id)) {
      refused.push(`${id}: ketszer szerepel a lapon`);
      continue;
    }
    seen.add(id);
    const result = byId.get(id);
    if (!result) {
      refused.push(`${id}: nincs ilyen kerdes a riportban`);
      continue;
    }
    if (result.verdict !== "human" || typeof result.answer !== "string") {
      refused.push(`${id}: a riportban nem ember-iteletu (${result.verdict})`);
      continue;
    }
    if (field("lenyomat") !== answerFingerprint(result.answer)) {
      refused.push(`${id}: a lenyomat nem a riport valaszae (masik futas lapja, vagy atirt valasz)`);
      continue;
    }
    if (verdict !== "pass" && verdict !== "fail") {
      refused.push(`${id}: az itelet pass vagy fail lehet, nem "${verdict}"`);
      continue;
    }
    const reason = field("indok");
    if (!reason) {
      refused.push(`${id}: indok nelkul az itelet nem ellenorizheto`);
      continue;
    }
    verdicts.set(id, { verdict, judge, reason, answer: answerFingerprint(result.answer) });
  }
  if (refused.length > 0) return { results: [...results], applied: [], refused };
  return {
    results: results.map((r) => (verdicts.has(r.id) ? { ...r, judged: verdicts.get(r.id)! } : r)),
    applied: [...verdicts.keys()],
    refused: []
  };
}

/** The verdict that counts for one result: a person's on a `human` answer, else the machine's. */
export function effectiveVerdict(result: { verdict: string; judged?: Judgement }): string {
  return result.verdict === "human" && result.judged ? result.judged.verdict : result.verdict;
}
