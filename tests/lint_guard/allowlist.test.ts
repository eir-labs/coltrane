// Allowlist guard test. Proves the project's import-hygiene eslint config actually rejects
// a forbidden import shape.
//
// Strategy:
//   1. Write a temp .ts fixture with a forbidden import.
//   2. Invoke `npx eslint --config eslint.config.js <fixture>` in a subprocess.
//   3. Assert: non-zero exit AND the violation is named in the output.
//
// The toolchain is deliberately NOT a devDependency (see eslint.config.js), so the guard
// can only run where eslint AND @typescript-eslint/parser are installed — CI installs both
// (.github/workflows/lint-imports.yml). Everywhere else each case no-ops with a message
// naming what is missing. See `runGuard` for why "did it run" has to be answered explicitly
// rather than inferred from the exit code.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CONFIG = join(REPO_ROOT, "eslint.config.js");
// Flat config requires fixtures to live under the config's base path
// (the project root). Place them under a gitignored scratch dir within the
// project, not under the OS tmpdir.
const SCRATCH_ROOT = join(REPO_ROOT, "tests", "lint_guard", ".scratch");
mkdirSync(SCRATCH_ROOT, { recursive: true });

// Cached: this spawns `npx`, which costs 1-3s under full-band load, and it was being paid
// once per case ON TOP of the eslint run itself — two subprocesses per test. The answer
// cannot change during a run, so it is resolved at most once.
let eslintAvailableCache: boolean | undefined;
function eslintAvailable(): boolean {
  if (eslintAvailableCache === undefined) {
    const probe = spawnSync("npx", ["--no-install", "eslint", "--version"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    eslintAvailableCache = probe.status === 0;
  }
  return eslintAvailableCache;
}

/**
 * vitest's default 5s is not a realistic budget for a test that shells out. Each case runs
 * `npx eslint` in a subprocess while ~150 other test files run in parallel workers, and the
 * observed cost is 1-3s per spawn — 5-10s when the machine is loaded.
 *
 * This was the second half of what looked like flakiness. Before the outcome-classification
 * fix the cases failed an ASSERTION (exit 0 where non-zero was expected); after it they were
 * correctly skipping but TIMING OUT while doing so. Two different symptoms, one shared cause:
 * the test was measured against a budget that never accounted for subprocess spawn.
 */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * Run the guard against a fixture and say WHICH of three things happened.
 *
 * The original test asked one question — "is eslint available?" — and inferred everything
 * else from the exit code. That could not distinguish "eslint linted this and found no
 * violation" from "eslint linted NOTHING", and the difference is the whole value of the
 * test:
 *
 *   `eslint.config.js` adds its `**\/*.ts` block only `if (tsParser)`, and
 *   `@typescript-eslint/parser` is deliberately not a devDependency. Without it a .ts
 *   fixture matches NO config, so eslint emits "File ignored because no matching
 *   configuration was supplied" and exits 0.
 *
 * With eslint installed but the parser missing, the two "rejects" cases therefore failed
 * (exit 0 where a violation was expected) and the "accepts" case passed VACUOUSLY — an
 * unlinted file trivially contains no violations. Both of those are the wrong answer, and
 * between them they looked exactly like a flaky test rather than a guard that was not
 * guarding.
 */
type GuardOutcome =
  | { ran: false; why: "eslint-missing" | "ts-parser-missing" }
  | { ran: true; status: number; out: string };

function runGuard(source: string): GuardOutcome {
  if (!eslintAvailable()) return { ran: false, why: "eslint-missing" };
  const dir = mkdtempSync(join(SCRATCH_ROOT, "case-"));
  try {
    const fixture = join(dir, "fixture.ts");
    writeFileSync(fixture, source);
    const result = spawnSync("npx", ["--no-install", "eslint", "--config", CONFIG, fixture], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const out = (result.stdout || "") + (result.stderr || "");
    // The tell that nothing was linted. eslint reports it as a WARNING and still exits 0,
    // which is why it has to be detected by text rather than by status.
    if (/no matching configuration was supplied/i.test(out)) {
      return { ran: false, why: "ts-parser-missing" };
    }
    return { ran: true, status: result.status ?? -1, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One place to explain a skip, so a skipped guard reads as skipped and never as passed. */
function explainSkip(why: "eslint-missing" | "ts-parser-missing"): void {
  console.warn(
    why === "eslint-missing"
      ? "IMPORT GUARD NOT RUN: eslint is not installed. `npm install --no-save eslint@^9 @typescript-eslint/parser@^8`"
      : "IMPORT GUARD NOT RUN: @typescript-eslint/parser is missing, so eslint.config.js omits its .ts block " +
          "and the fixture matches no configuration. `npm install --no-save @typescript-eslint/parser@^8`",
  );
}

describe("import allowlist", () => {
  it("rejects an absolute-path import", () => {
    const r = runGuard('import { x } from "/usr/local/lib/external";\nexport const y = x;\n');
    if (!r.ran) return explainSkip(r.why);
    expect(r.status, "eslint exits non-zero when violations exist").not.toBe(0);
    expect(r.out).toMatch(/no-restricted-imports|Imports must be relative/);
  }, SPAWN_TIMEOUT_MS);

  it("rejects a deep parent-traversal import", () => {
    const r = runGuard('import { x } from "../../../external";\nexport const y = x;\n');
    if (!r.ran) return explainSkip(r.why);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/no-restricted-imports|Imports must be relative/);
  }, SPAWN_TIMEOUT_MS);

  it("accepts an in-tree relative import and a package-name import", () => {
    const r = runGuard(
      'import { z } from "zod";\nimport { local } from "./sibling.js";\nexport const y = { z, local };\n',
    );
    // Without the `ran` gate this assertion is the emptiest kind of green: a file that was
    // never linted trivially contains no violation, so it passed in exactly the situation
    // where the guard was doing nothing.
    if (!r.ran) return explainSkip(r.why);
    expect(r.out).not.toMatch(/no-restricted-imports/);
  }, SPAWN_TIMEOUT_MS);

  // Guards the guard. The three cases above all no-op when the toolchain is absent, which is
  // the honest thing to do locally — but it means a permanently-skipped guard looks identical
  // to a passing one. CI installs eslint AND the parser (.github/workflows/lint-imports.yml),
  // so there it must genuinely run, and this is what says so out loud.
  it("reports whether the guard actually ran", () => {
    const r = runGuard('import { x } from "/absolute";\nexport const y = x;\n');
    if (process.env["CI"]) {
      expect(r.ran, "CI installs eslint + @typescript-eslint/parser — the guard must not skip there").toBe(true);
    } else if (!r.ran) {
      explainSkip(r.why);
    }
    expect(typeof r.ran).toBe("boolean");
  }, SPAWN_TIMEOUT_MS);
});
