// THE REAL-PROCESS AND BINARY-BOUND LAWS RUN IN CI — a skip there is red.
//
// The non-author grade (#553, r7+r8): CI installed neither srt nor claude, so every real-process law (the
// sandbox refusing writes, git/egress as declared, the diff gate under an open .git) and every law bound
// to the installed CLI binary SKIPPED there as UNVERIFIED — green only on a developer's machine. The
// choice made: a CI job (`sandbox`, .github/workflows/ci.yml) installs bubblewrap, socat,
// @anthropic-ai/sandbox-runtime and the pinned CLI binary, sets COLTRANE_SRT / CLAUDE_BIN, and runs those
// files with COLTRANE_REQUIRE_REAL=1 — under which each such file carries a law that goes RED if it would
// skip. This file checks that the job exists and stays wired.
//
//   law                                                        kind        drives                        plant
//   a CI job installs bubblewrap, socat and the sandbox        structural  .github/workflows/ci.yml       drop the apt or npm install step
//   runtime, and the CLI at the version the oracle pins
//   …sets COLTRANE_REQUIRE_REAL=1, COLTRANE_SRT and CLAUDE_BIN structural  same                           drop the env
//   …and runs EVERY test file that carries a required-real law structural  same + tests/*.test.ts        drop a file from the job's list, or add a
//                                                                                                        required-real file without listing it
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
/** The `sandbox:` job's text (up to the next top-level job or EOF). */
const job = (() => {
  const i = ci.search(/^  sandbox:\s*$/m);
  if (i < 0) return "";
  const rest = ci.slice(i + 1);
  const j = rest.search(/^  [a-z][\w-]*:\s*$/m);
  return j < 0 ? ci.slice(i) : ci.slice(i, i + 1 + j);
})();
const CLI_VERSION = "2.1.283"; // the version the oracle, the splitter and the fingerprint were read from

describe("the real-process and binary-bound laws run in CI (structural — the obligation IS the workflow text)", () => {
  it("a `sandbox` job installs bubblewrap, socat, @anthropic-ai/sandbox-runtime, and the CLI at the oracle's version", () => {
    expect(job, "no `sandbox` job in .github/workflows/ci.yml — the real-process laws only ever SKIP in CI").not.toBe("");
    expect(job).toMatch(/apt-get install[^\n]*\bbubblewrap\b/);
    expect(job).toMatch(/apt-get install[^\n]*\bsocat\b/);
    expect(job).toMatch(/@anthropic-ai\/sandbox-runtime/);
    expect(job, `the CI binary is not the CLI version (${CLI_VERSION}) the oracle was read from`).toContain(`@anthropic-ai/claude-code-linux-x64@${CLI_VERSION}`);
  });

  it("it sets COLTRANE_REQUIRE_REAL=1 and exports COLTRANE_SRT and CLAUDE_BIN", () => {
    expect(job).toMatch(/COLTRANE_REQUIRE_REAL:\s*"1"/);
    expect(job).toMatch(/COLTRANE_SRT=/);
    expect(job).toMatch(/CLAUDE_BIN=/);
  });

  it("it runs exactly every test file that carries a required-real law", () => {
    const tests = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.ts") && f !== "the_real_process_laws_run_in_ci.test.ts");
    const required = tests.filter((f) => readFileSync(join(ROOT, "tests", f), "utf8").includes("COLTRANE_REQUIRE_REAL")).map((f) => `tests/${f}`).sort();
    const listed = [...job.matchAll(/tests\/[\w.-]+\.test\.ts/g)].map((m) => m[0]).sort();
    expect(required.length, "non-vacuity: some files carry required-real laws").toBeGreaterThan(3);
    expect([...new Set(listed)], "the CI sandbox job does not run exactly the files whose real-process laws must not skip").toEqual(required);
  });
});
