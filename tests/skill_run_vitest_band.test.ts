// RED-first contract tests — skills as first-class, the FIRST PRODUCT SKILL
// (docs/skills-as-first-class.md, Phase 1: "Land run-vitest-band as the first skill").
// run-vitest-band is the degenerate, pure-code case: the code half resolves the ENTIRE
// output (a test verdict), the residual is empty, and the model never runs
// (determinism_ratio = 1.0). Landing it is what properly fixes the e2e-band problem —
// "an LLM should not babysit a deterministic command." Running a deterministic command
// and reading its result is exactly a tier-2 code skill.
//
// We pin the deliverable's SHAPE here (package present, tier 2, pure-code, no reasoning
// half). We deliberately do NOT spawn vitest from inside vitest in this assertion path —
// the subprocess-execution mechanism is already proven green by number-adder/spawner in
// skill_execution.test.ts; an end-to-end run belongs in the e2e suite, not a unit test.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadSkillPackage } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_VITEST_BAND = join(REPO_ROOT, "skills/run-vitest-band");

describe("run-vitest-band — the first pure-code product skill", () => {
  it("ships as a genome skill package", () => {
    expect(existsSync(RUN_VITEST_BAND), "skills/run-vitest-band/ must exist (Phase 1 deliverable)").toBe(true);
    expect(existsSync(join(RUN_VITEST_BAND, "meta.json"))).toBe(true);
    expect(existsSync(join(RUN_VITEST_BAND, "skill.mjs"))).toBe(true);
  });

  it("is a tier-2 skill (it spawns a child process to run the test command)", () => {
    const pkg = loadSkillPackage(RUN_VITEST_BAND);
    expect(pkg.meta.permission?.tier).toBe(2);
  });

  it("is pure-code: a real code half, no reasoning half, declared determinism 1.0", () => {
    const pkg = loadSkillPackage(RUN_VITEST_BAND);
    expect(pkg.codeHash).toMatch(/^sha256:[0-9a-f]{64}$/); // code half present + hashed
    expect(pkg.mdPath).toBeNull(); // no model reasoning — the command IS the answer
    expect(pkg.meta.determinism_ratio).toBe(1.0);
  });

  it("declares a verdict-shaped output contract (passed/total), not free text", () => {
    const pkg = loadSkillPackage(RUN_VITEST_BAND);
    const props = (pkg.meta.output_schema?.properties ?? {}) as Record<string, unknown>;
    expect(props).toHaveProperty("passed");
    expect(props).toHaveProperty("total");
  });
});
