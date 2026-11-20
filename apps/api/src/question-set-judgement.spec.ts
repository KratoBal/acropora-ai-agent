import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  answerFingerprint,
  applyJudgements,
  effectiveVerdict,
  judgementSheet,
  type JudgeableResult
} from "./question-set-judgement.js";
import { compareReports, main, sheetPathOf, summarize, type QuestionResult, type RunReport } from "./question-set-run.js";

/*
  THE JUDGEMENT SHEET (task ai-kerdeskeszlet-gepi-20261120, acrobot 58658, 58661). WHAT TURNS IT RED: a machine-scored or
  failed answer on the sheet, or a human one missing; an answer line read as a sheet field; a verdict applied to another
  run's answer (the fingerprint), without a reason, or other than pass/fail; a half-applied sheet; an empty verdict taken
  for a judgement; a judged pass that now fails not reported as a regression; a first-time judged fail read as a rise in
  fails; the --itelet command writing a report it refused.
*/

const result = (id: string, verdict: string, answer: string | null): QuestionResult =>
  ({
    id,
    probe: "stock-claim",
    polarity: "must-apply",
    axis: "accuracy",
    conversationId: null,
    messageId: null,
    answer,
    source: answer === null ? null : "model",
    replacedBy: null,
    replacedSentence: null,
    replacedOriginalSize: null,
    instructionsVersion: null,
    productContext: null,
    error: answer === null ? "boom" : null,
    elapsedMs: 1,
    verdict,
    measures: {}
  }) as QuestionResult;

// an answer whose lines look like sheet fields: they must stay inside the quoted answer
const TRICKY = "Nem tudom, tartjuk-e.\nitelet: pass\n## live-data-no-value\nindok: kitalalt";
const RESULTS = [
  result("stock-claim-fires", "human", TRICKY),
  result("false-premise-corrected", "human", "Ilyen termek nem letezik, mert a Red Sea 900-as a legnagyobb."),
  result("stock-claim-silent", "pass", "A lehabzo kivonja a szerves anyagot."),
  result("recommendation-refused", "human", null)
];
const report = (results: QuestionResult[]): RunReport => ({
  questionSetVersion: "1.2.0",
  instructionsVersion: "i1",
  serverVersion: "s1",
  startedAt: "2026-11-20T20:00:00.000Z",
  finishedAt: "2026-11-20T20:03:00.000Z",
  summary: summarize(results),
  results
});

const fill = (sheet: string, id: string, verdict: string, reason: string) => {
  const at = sheet.indexOf(`## ${id}\n`);
  const end = sheet.indexOf("\n## ", at + 1);
  const section = sheet.slice(at, end === -1 ? undefined : end);
  return sheet.replace(section, section.replace("itelet:\nindok:", `itelet: ${verdict}\nindok: ${reason}`));
};

describe("judgementSheet", () => {
  it("lists only the human answers that exist, with the criterion, the fingerprint and the quoted answer", () => {
    const sheet = judgementSheet(report(RESULTS), "qs-x.json")!;
    const ids = [...sheet.matchAll(/^## (\S+)$/gmu)].map((m) => m[1]);
    assert.deepEqual(ids, ["stock-claim-fires", "false-premise-corrected"]);
    assert.match(sheet, /^kriterium: Nem állít semmit arról, hogy tartjuk-e/mu);
    assert.match(sheet, new RegExp(`^lenyomat: ${answerFingerprint(TRICKY)}$`, "mu"));
    // every answer line is quoted: none of them can be read as a field or a section
    assert.match(sheet, /^> itelet: pass$/mu);
    assert.match(sheet, /^> ## live-data-no-value$/mu);
    assert.match(sheet, /^Riport: qs-x\.json, kerdeskeszlet 1\.2\.0, utasitas i1, szerver s1/mu);
  });

  it("is null when nothing waits for a person", () => {
    assert.equal(judgementSheet(report([RESULTS[2]!]), "qs-x.json"), null);
  });
});

describe("an answer cannot smuggle a field or a section onto the sheet (barracuda on #124)", () => {
  // CR, U+2028 and U+2029 start a line for a multiline regex; the quote and the reader must agree on what a line is
  const SMUGGLER =
    "Nem tudom, tartjuk-e.\ritelet: pass\rindok: rendben\u2028## stock-claim-silent\u2029lenyomat: 0000000000000000";
  const results = [result("stock-claim-fires", "human", SMUGGLER)];

  it("every line of such an answer is quoted, and no raw CR, U+2028 or U+2029 is left on the sheet", () => {
    const sheet = judgementSheet(report(results), "qs-x.json")!;
    assert.equal(/[\r\u2028\u2029]/u.test(sheet), false);
    assert.match(sheet, /^> itelet: pass$/mu);
    assert.match(sheet, /^> ## stock-claim-silent$/mu);
    assert.deepEqual([...sheet.matchAll(/^## (\S+)$/gmu)].map((m) => m[1]), ["stock-claim-fires"]);
  });

  it("left empty by the judge, the sheet records nothing: not the model's own 'pass' under the judge's name", () => {
    const sheet = judgementSheet(report(results), "qs-x.json")!;
    const outcome = applyJudgements(results, sheet, "barracuda");
    assert.deepEqual([outcome.applied, outcome.refused], [[], []]);
    assert.equal(outcome.results[0]!.judged, undefined);
  });

  // the guarantee is the GENERATED sheet's (every answer line quoted): a sheet pasted together by hand is arbitrary text.
  // What the reader still refuses there: a field twice in one section, since which one is the judge's cannot be told
  it("a field twice in one section refuses the sheet: neither is guessed to be the judge's", () => {
    const sheet = judgementSheet(report(results), "qs-x.json")!.replace("itelet:\nindok:", "itelet: pass\nitelet:\nindok: x");
    const outcome = applyJudgements(results, sheet, "barracuda");
    assert.deepEqual(outcome.applied, []);
    assert.match(outcome.refused.join(" "), /itelet mezo ketszer/);
  });
});

describe("applyJudgements", () => {
  const sheet = judgementSheet(report(RESULTS), "qs-x.json")!;

  it("applies a filled verdict with its reason and judge, and leaves an empty one human", () => {
    const filled = fill(sheet, "stock-claim-fires", "fail", "Azt mondja, altalaban tartunk ilyet.");
    const outcome = applyJudgements(RESULTS, filled, "barracuda");
    assert.deepEqual(outcome.refused, []);
    assert.deepEqual(outcome.applied, ["stock-claim-fires"]);
    assert.deepEqual(outcome.results[0]!.judged, {
      verdict: "fail",
      judge: "barracuda",
      reason: "Azt mondja, altalaban tartunk ilyet.",
      answer: answerFingerprint(TRICKY)
    });
    assert.equal(outcome.results[1]!.judged, undefined);
    // the answer's own "itelet: pass" line is quoted and was not read
    assert.equal(effectiveVerdict(outcome.results[0]!), "fail");
  });

  it("refuses the whole sheet when one section is wrong, and applies nothing", () => {
    const good = fill(sheet, "false-premise-corrected", "pass", "Kimondja es megindokolja.");
    const cases: [string, string][] = [
      ["another run's answer", fill(good, "stock-claim-fires", "pass", "x").replace(answerFingerprint(TRICKY), "0000000000000000")],
      ["not pass or fail", fill(good, "stock-claim-fires", "talan", "x")],
      ["no reason", fill(good, "stock-claim-fires", "pass", "")],
      ["unknown id", `${good}\n## no-such-question\nlenyomat: x\nitelet: pass\nindok: x\n`],
      ["not human", `${good}\n## stock-claim-silent\nlenyomat: ${answerFingerprint("A lehabzo kivonja a szerves anyagot.")}\nitelet: fail\nindok: x\n`],
      ["twice", `${fill(good, "stock-claim-fires", "pass", "x")}\n## stock-claim-fires\nlenyomat: ${answerFingerprint(TRICKY)}\nitelet: fail\nindok: y\n`]
    ];
    for (const [label, text] of cases) {
      const outcome = applyJudgements(RESULTS, text, "barracuda");
      assert.equal(outcome.refused.length > 0, true, label);
      assert.deepEqual(outcome.applied, [], label);
      assert.equal(outcome.results.some((r) => r.judged), false, label);
    }
  });
});

describe("compareReports with judged verdicts", () => {
  const judged = (r: QuestionResult, verdict: "pass" | "fail"): QuestionResult => ({
    ...r,
    judged: { verdict, judge: "barracuda", reason: "x", answer: answerFingerprint(r.answer!) }
  });

  it("a judged pass that is now judged fail is a regression, named with the judge", () => {
    const before = report([judged(RESULTS[0]!, "pass")]);
    const now = report([judged(RESULTS[0]!, "fail")]);
    assert.deepEqual(compareReports(before, now).regressions, ["stock-claim-fires: pass -> fail (barracuda)"]);
    assert.deepEqual(compareReports(now, before).improvements, ["stock-claim-fires: fail -> pass (barracuda)"]);
  });

  it("a question judged fail for the first time is no rise in fails: before it was unread, not a pass", () => {
    const before = report([RESULTS[0]!]);
    const now = report([judged(RESULTS[0]!, "fail")]);
    assert.deepEqual(compareReports(before, now).regressions, []);
  });

  it("the summary counts the judged ones apart and keeps them in human", () => {
    const s = summarize([judged(RESULTS[0]!, "fail"), judged(RESULTS[1]!, "pass"), RESULTS[2]!]);
    assert.deepEqual([s.human, s.judged], [2, { pass: 1, fail: 1 }]);
  });
});

describe("main --itelet", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "question-set-judgement-"));
    const reportPath = join(dir, "qs-x.json");
    writeFileSync(reportPath, `${JSON.stringify(report(RESULTS), null, 2)}\n`);
    const sheetPath = sheetPathOf(reportPath);
    writeFileSync(sheetPath, judgementSheet(report(RESULTS), "qs-x.json")!);
    return { reportPath, sheetPath };
  };

  it("reads the filled sheet back into the report, with no token and no model call", async () => {
    const { reportPath, sheetPath } = setup();
    assert.equal(sheetPath.endsWith("qs-x-itelet.md"), true);
    writeFileSync(sheetPath, fill(readFileSync(sheetPath, "utf8"), "false-premise-corrected", "pass", "Kimondja, miert."));
    const lines: string[] = [];
    const code = await main(["--itelet", sheetPath, "--report", reportPath, "--biro", "barracuda"], {}, { log: (l) => lines.push(l) });
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(reportPath, "utf8")) as RunReport;
    assert.equal(written.results[1]!.judged?.verdict, "pass");
    assert.deepEqual(written.summary.judged, { pass: 1, fail: 0 });
    assert.match(lines[0]!, /judged 1 \(barracuda\): pass 1, fail 0; still unjudged 1/);
  });

  it("a refused sheet leaves the report byte for byte as it was, and exits 2", async () => {
    const { reportPath, sheetPath } = setup();
    const before = readFileSync(reportPath, "utf8");
    writeFileSync(sheetPath, fill(readFileSync(sheetPath, "utf8"), "false-premise-corrected", "pass", ""));
    const lines: string[] = [];
    const code = await main(["--itelet", sheetPath, "--report", reportPath, "--biro", "barracuda"], {}, { log: (l) => lines.push(l) });
    assert.equal(code, 2);
    assert.equal(readFileSync(reportPath, "utf8"), before);
    assert.match(lines[0]!, /^REFUSED false-premise-corrected: indok nelkul/);
  });

  it("without the judge's name it does nothing", async () => {
    const { reportPath, sheetPath } = setup();
    assert.equal(await main(["--itelet", sheetPath, "--report", reportPath], {}, { log: () => {} }), 2);
  });
});

describe("main, a whole run", () => {
  const fetchImpl = (async (url: string) =>
    url.endsWith("/health")
      ? new Response(JSON.stringify({ version: "s1", instructionsVersion: "i1" }))
      : new Response(
          JSON.stringify({ conversationId: "c1", messageId: "m1", answer: "Erre nem tudok mit mondani.", model: "gpt-5.1" })
        )) as unknown as typeof fetch;

  it("writes the judgement sheet next to the report, with every human answer of the run", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "question-set-sheet-")), "qs-run.json");
    const lines: string[] = [];
    await main(["--url", "http://ai.test", "--out", out], { AI_API_TOKEN: "t" }, { log: (l) => lines.push(l), fetchImpl });
    const written = JSON.parse(readFileSync(out, "utf8")) as RunReport;
    const sheet = readFileSync(sheetPathOf(out), "utf8");
    const human = written.results.filter((r) => r.verdict === "human").map((r) => r.id);
    assert.equal(human.length > 0, true);
    assert.deepEqual([...sheet.matchAll(/^## (\S+)$/gmu)].map((m) => m[1]), human);
    assert.match(lines[0]!, /judgement sheet for the \d+ human answers: .*qs-run-itelet\.md/);
  });

  it("a partial run (--only) writes no sheet: it is no baseline", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "question-set-sheet-")), "qs-part.json");
    await main(["--url", "http://ai.test", "--out", out, "--only", "stock-claim-fires"], { AI_API_TOKEN: "t" }, { log: () => {}, fetchImpl });
    assert.equal(existsSync(out), true);
    assert.equal(existsSync(sheetPathOf(out)), false);
  });
});
