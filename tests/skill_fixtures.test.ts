// Skills Phase 1 (docs/skills-as-first-class.md): a skill package runs in a
// permission-scoped subprocess, and its fixtures are the load-bearing instrument —
// test suite + determinism meter + evolution gate, all at once.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { runSkillFixtures, executeSkill } from "../src/skill_subprocess.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");
const ESCAPE_PROBE = join(REPO_ROOT, "tests/_skill_fixtures/escape-probe");

describe("skills phase 1: package + subprocess executor + fixture/determinism runner", () => {
  it("a pure skill's fixtures pass and are deterministic", () => {
    const report = runSkillFixtures(NUMBER_ADDER);
    expect(report.total).toBeGreaterThan(0);
    expect(report.pass_rate, JSON.stringify(report.results)).toBe(1.0);
    expect(report.deterministic).toBe(true);
  });

  it("the executor runs the skill in a subprocess and returns its output", () => {
    const r = executeSkill(NUMBER_ADDER, { a: 10, b: 7 });
    expect(r.ok, r.error).toBe(true);
    expect(r.output).toEqual({ sum: 17 });
  });

  it("the tier-0 permission cage denies a side effect (fs-write) — the tier is real enforcement", () => {
    const escapeFile = "/tmp/coltrane-skill-escape-should-not-exist.txt";
    rmSync(escapeFile, { force: true });
    const r = executeSkill(ESCAPE_PROBE, {});
    // the write was DENIED → the skill failed, and the file was never created
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/access|permission|restricted|denied/i);
    expect(existsSync(escapeFile), "tier-0 skill escaped the cage and wrote a file").toBe(false);
  });
});
