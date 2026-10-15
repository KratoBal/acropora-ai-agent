#!/usr/bin/env node
// Dependency audit for CI (Security Baseline B32, acrobot 31391).
//
// WHY: this repository's CI ran the typecheck and the tests, and nothing looked at the
// dependencies: there is no image scan here either (the Acropora OS repo has a Trivy job on its
// images; this one does not). On 2026-10-15 (main 313eb17) `npm audit` reported 2 high.
//
// HOW: it runs the package manager's own audit on the lockfile (no new service, no token: the
// registry the install already uses answers it), and writes a summary to the job log and to
// $GITHUB_STEP_SUMMARY. npm is pinned here (NPM_VERSION), because the npm that ships with
// Node 22 moves with the minor release. The pnpm branch is kept so the logic stays the same as
// in the Acropora OS copy (only this header differs).
//
// MODES:
//   report (default)  the step passes whatever it finds; the summary lists it. This is where it
//                     starts, so today's findings show before anything blocks a PR.
//   --strict          exit 1 when anything at or above --level (default high) is reported.
// An audit that cannot be read (a network error, a changed output format) is never a clean
// result: exit 2 in both modes, with the reason, so "no findings" can only mean "looked, none".
//
// Usage:
//   node scripts/dependency-audit.mjs --tool pnpm|npm [--dir <path>] [--label <name>]
//                                     [--strict] [--level low|moderate|high|critical]
//                                     [--input <audit.json>]   (parse a saved audit; tests)
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const NPM_VERSION = "10.9.8";
const LEVELS = ["info", "low", "moderate", "high", "critical"];
const MAX_ROWS = 50;

function parseArgs(argv) {
  const args = {
    tool: "",
    dir: ".",
    label: "",
    strict: false,
    level: "high",
    input: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--strict") args.strict = true;
    else if (["--tool", "--dir", "--label", "--level", "--input"].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = v;
      i += 1;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!["pnpm", "npm"].includes(args.tool))
    throw new Error("--tool must be pnpm or npm");
  if (!LEVELS.includes(args.level))
    throw new Error(`--level must be one of ${LEVELS.join(", ")}`);
  return args;
}

function runAudit(tool, dir) {
  const [cmd, cmdArgs] =
    tool === "pnpm"
      ? ["pnpm", ["audit", "--json"]]
      : ["npx", ["--yes", `npm@${NPM_VERSION}`, "audit", "--json"]];
  const r = spawnSync(cmd, cmdArgs, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`could not run ${cmd}: ${r.error.message}`);
  // both tools exit non-zero when they find something: the JSON decides, not the exit code
  return r.stdout;
}

/** Counts by severity and the findings, from either tool's JSON; throws if it cannot be read. */
export function summarize(tool, text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("the audit output is not JSON");
  }
  const counts = data?.metadata?.vulnerabilities;
  if (
    !counts ||
    typeof counts !== "object" ||
    !LEVELS.every((l) => Number.isInteger(counts[l]))
  ) {
    const why = data?.error
      ? `the audit reported an error: ${JSON.stringify(data.error).slice(0, 300)}`
      : "no severity counts in the audit output";
    throw new Error(why);
  }
  const items = [];
  if (tool === "pnpm") {
    for (const a of Object.values(data.advisories ?? {})) {
      const patched =
        typeof a.patched_versions === "string" &&
        a.patched_versions !== "<0.0.0";
      items.push({
        name: a.module_name,
        severity: a.severity,
        title: a.title ?? "",
        fix: patched ? a.patched_versions : "nincs",
      });
    }
  } else {
    for (const v of Object.values(data.vulnerabilities ?? {})) {
      const own = (v.via ?? []).filter((x) => x && typeof x === "object");
      const title = own.length
        ? own[0].title
        : `a függősége miatt: ${(v.via ?? []).join(", ")}`;
      const fix =
        v.fixAvailable === true
          ? "igen"
          : v.fixAvailable && typeof v.fixAvailable === "object"
            ? v.fixAvailable.isSemVerMajor
              ? "főverzió-váltással"
              : "igen"
            : "nincs";
      items.push({ name: v.name, severity: v.severity, title, fix });
    }
  }
  return {
    counts: Object.fromEntries(LEVELS.map((l) => [l, counts[l]])),
    items,
  };
}

export function report({ tool, label, level, strict }, { counts, items }) {
  const at = LEVELS.indexOf(level);
  const shown = items
    .filter((i) => LEVELS.indexOf(i.severity) >= at)
    .sort(
      (a, b) =>
        LEVELS.indexOf(b.severity) - LEVELS.indexOf(a.severity) ||
        a.name.localeCompare(b.name),
    );
  const over = shown.length;
  const cell = (s) => String(s).replaceAll("|", "/").replaceAll("\n", " ");
  const lines = [
    `### Függőség-vizsgálat: ${label || tool} (${tool})`,
    "",
    `critical ${counts.critical}, high ${counts.high}, moderate ${counts.moderate}, low ${counts.low}, info ${counts.info}`,
    "",
    strict
      ? `Szigorú mód: a lépés ${over ? "BUKIK" : "átmegy"} (${over} tétel ${level} vagy súlyosabb).`
      : `Jelentő mód: a lépés nem bukik; ${over} tétel ${level} vagy súlyosabb.`,
  ];
  if (over) {
    lines.push(
      "",
      "| csomag | súlyosság | mi | javítás |",
      "|---|---|---|---|",
    );
    for (const i of shown.slice(0, MAX_ROWS))
      lines.push(
        `| ${cell(i.name)} | ${i.severity} | ${cell(i.title)} | ${cell(i.fix)} |`,
      );
    if (over > MAX_ROWS) lines.push("", `... és még ${over - MAX_ROWS}.`);
  }
  return { text: lines.join("\n") + "\n", fail: strict && over > 0 };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`dependency-audit: ${e.message}`);
    process.exit(2);
  }
  let summary;
  try {
    const text = args.input
      ? readFileSync(args.input, "utf8")
      : runAudit(args.tool, args.dir);
    summary = summarize(args.tool, text);
  } catch (e) {
    const msg = `NEM MÉRHETŐ (${args.label || args.tool}): ${e.message}`;
    console.error(`::error::${msg}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Függőség-vizsgálat\n\n${msg}\n`,
      );
    process.exit(2);
  }
  const out = report(args, summary);
  process.stdout.write(out.text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.text + "\n");
  process.exit(out.fail ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
