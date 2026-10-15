import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The CI dependency audit (`scripts/dependency-audit.mjs`, Security Baseline B32). WHAT TURNS
 * THIS RED:
 *   - report mode failing the step, or strict mode passing with a finding at the level;
 *   - a finding below the level shown or counted as a failure;
 *   - an unreadable audit (not JSON, an error object, no severity counts) read as clean
 *     instead of exit 2 in both modes;
 *   - the pnpm or the npm format losing the package, the title or the fix column;
 *   - the summary not reaching $GITHUB_STEP_SUMMARY.
 * The fixtures are trimmed copies of real entries from the 2026-10-15 audits of the Acropora OS
 * main (2adaa57f), not invented shapes; the script's logic is the same in both repositories.
 */

function futtat(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { kod: number; kimenet: string } {
  try {
    const kimenet = execFileSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "dependency-audit.mjs"),
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
      },
    );
    return { kod: 0, kimenet };
  } catch (hiba) {
    const h = hiba as { status?: number; stdout?: string; stderr?: string };
    return {
      kod: h.status ?? -1,
      kimenet: `${h.stdout ?? ""}${h.stderr ?? ""}`,
    };
  }
}

const dir = mkdtempSync(join(tmpdir(), "dependency-audit-"));
function fajl(nev: string, tartalom: unknown): string {
  const p = join(dir, nev);
  writeFileSync(
    p,
    typeof tartalom === "string" ? tartalom : JSON.stringify(tartalom),
  );
  return p;
}

const PNPM = fajl("pnpm.json", {
  actions: [],
  advisories: {
    "1130718": {
      id: 1130718,
      module_name: "undici",
      severity: "high",
      title:
        "undici vulnerable to cross-user information disclosure and parse-time crash via degenerate private cache directives",
      patched_versions: ">=7.29.0",
      github_advisory_id: "GHSA-4cwx-7wf7-3272",
    },
    "1240038": {
      id: 1240038,
      module_name: "undici",
      severity: "low",
      title:
        "undici vulnerable to downstream response splitting via retry interceptor",
      patched_versions: ">=7.29.1",
      github_advisory_id: "GHSA-r53p-7pc4-xj5r",
    },
  },
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0 },
  },
});

const PNPM_ALACSONY = fajl("pnpm-low.json", {
  advisories: {
    "1240038": {
      id: 1240038,
      module_name: "undici",
      severity: "low",
      title:
        "undici vulnerable to downstream response splitting via retry interceptor",
      patched_versions: ">=7.29.1",
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
  },
});

const NPM = fajl("npm.json", {
  auditReportVersion: 2,
  vulnerabilities: {
    "shell-quote": {
      name: "shell-quote",
      severity: "critical",
      isDirect: false,
      via: [
        {
          source: 1241332,
          name: "shell-quote",
          dependency: "shell-quote",
          title:
            "shell-quote: `quote()` command injection via a line terminator in a token after a `{ comment }` token",
          url: "https://github.com/advisories/GHSA-pqg4-j6r4-53mv",
          severity: "critical",
          range: ">=1.8.4 <1.11.0",
        },
      ],
      effects: [],
      range: "1.8.4 - 1.10.0",
      nodes: [],
      fixAvailable: true,
    },
    "@expo/config": {
      name: "@expo/config",
      severity: "high",
      isDirect: false,
      via: ["@expo/config-plugins"],
      effects: [],
      range: "*",
      nodes: [],
      fixAvailable: { name: "expo", version: "57.0.0", isSemVerMajor: true },
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 1,
      total: 2,
    },
  },
});

describe("dependency-audit (B32)", () => {
  it("AUDIT-REPORT: report mode passes and lists only what is at or above the level", () => {
    const r = futtat([
      "--tool",
      "pnpm",
      "--label",
      "workspace",
      "--input",
      PNPM,
    ]);
    assert.equal(r.kod, 0, "AUDIT-REPORT exit");
    assert.match(
      r.kimenet,
      /critical 0, high 1, moderate 0, low 1, info 0/,
      "AUDIT-REPORT counts",
    );
    assert.match(
      r.kimenet,
      /\| undici \| high \| undici vulnerable to cross-user information disclosure/,
      "AUDIT-REPORT high row",
    );
    assert.match(r.kimenet, /\| >=7\.29\.0 \|/, "AUDIT-REPORT fix column");
    assert.doesNotMatch(
      r.kimenet,
      /retry interceptor/,
      "AUDIT-REPORT low row hidden",
    );
  });

  it("AUDIT-STRICT: strict mode fails on a finding at the level, and passes below it", () => {
    assert.equal(
      futtat(["--tool", "pnpm", "--strict", "--input", PNPM]).kod,
      1,
      "AUDIT-STRICT high",
    );
    assert.equal(
      futtat(["--tool", "pnpm", "--strict", "--input", PNPM_ALACSONY]).kod,
      0,
      "AUDIT-STRICT low only",
    );
    assert.equal(
      futtat([
        "--tool",
        "pnpm",
        "--strict",
        "--level",
        "low",
        "--input",
        PNPM_ALACSONY,
      ]).kod,
      1,
      "AUDIT-STRICT level low",
    );
  });

  it("AUDIT-NPM: the npm format gives the package, its own title or what it inherits, and the fix", () => {
    const r = futtat(["--tool", "npm", "--strict", "--input", NPM]);
    assert.equal(r.kod, 1, "AUDIT-NPM exit");
    assert.match(
      r.kimenet,
      /\| shell-quote \| critical \| shell-quote: `quote\(\)` command injection/,
      "AUDIT-NPM own title",
    );
    assert.match(
      r.kimenet,
      /\| @expo\/config \| high \| a függősége miatt: @expo\/config-plugins \| főverzió-váltással \|/,
      "AUDIT-NPM inherited",
    );
    const rows = r.kimenet
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| csomag"));
    assert.deepEqual(
      rows.map((l) => l.split(" | ")[1]),
      ["critical", "high"],
      "AUDIT-NPM order",
    );
  });

  it("AUDIT-UNREADABLE: not JSON, an error object, or no counts is exit 2 in both modes, never clean", () => {
    const hibaJson = fajl("error.json", {
      error: {
        code: "ENOTFOUND",
        summary: "request to https://registry.npmjs.org failed",
      },
    });
    const rossz = [
      fajl("garbage.json", "not json at all"),
      hibaJson,
      fajl("nocounts.json", { advisories: {}, metadata: {} }),
    ];
    const kodok = rossz.flatMap((p) => [
      futtat(["--tool", "npm", "--input", p]).kod,
      futtat(["--tool", "npm", "--strict", "--input", p]).kod,
    ]);
    assert.deepEqual(kodok, [2, 2, 2, 2, 2, 2], "AUDIT-UNREADABLE codes");
    assert.match(
      futtat(["--tool", "npm", "--input", hibaJson]).kimenet,
      /NEM MÉRHETŐ .*ENOTFOUND/,
      "AUDIT-UNREADABLE reason",
    );
  });

  it("AUDIT-SUMMARY: the summary is appended to GITHUB_STEP_SUMMARY", () => {
    const summary = fajl("summary.md", "");
    futtat(["--tool", "npm", "--label", "mobile", "--input", NPM], {
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.match(
      readFileSync(summary, "utf8"),
      /### Függőség-vizsgálat: mobile \(npm\)/,
      "AUDIT-SUMMARY",
    );
  });
});
