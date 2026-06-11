// Skills Phase 1 (docs/skills-as-first-class.md): a skill package runs in a
// permission-scoped subprocess, and its fixtures are the load-bearing instrument —
// test suite + determinism meter + evolution gate, all at once.
//
// The first describe block is the GREEN foundation (already implemented). The blocks
// below are RED-first contract tests: the determinism meter must sample N>=3 runs so a
// coincidentally-stable pair can't mask non-determinism, and the fixtures must double as
// the evolution gate (evolveSkill rejects a candidate that regresses any fixture).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { runSkillFixtures, executeSkill } from "../src/skill_subprocess.js";
import { evolveSkill } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");
const ESCAPE_PROBE = join(REPO_ROOT, "tests/_skill_fixtures/escape-probe");
const CLOCK_SKEW = join(REPO_ROOT, "tests/_skill_fixtures/clock-skew");
const CANDIDATE = (f: string) => join(REPO_ROOT, "tests/_skill_fixtures/_candidates", f);

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

describe("the determinism meter measures — it doesn't assume", () => {
  it("catches a non-deterministic skill: fixtures pass, but determinism is false", () => {
    const report = runSkillFixtures(CLOCK_SKEW);
    expect(report.pass_rate).toBe(1.0); // the is_number assertion holds every run
    expect(report.deterministic, "Math.random output must read as non-deterministic").toBe(false);
  });

  it("samples at least 3 runs per fixture, so a coincidentally-stable pair can't pass as deterministic", () => {
    const report = runSkillFixtures(NUMBER_ADDER) as unknown as { determinism_runs?: number };
    expect(report.determinism_runs ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("fixtures are the evolution gate (Eugene: reject improvements that regress a fixture)", () => {
  it("accepts a behavior-preserving candidate — no fixture regresses", () => {
    const v = evolveSkill(NUMBER_ADDER, CANDIDATE("number-adder-good.mjs"));
    expect(v.accepted).toBe(true);
    expect(v.failing_fixtures).toEqual([]);
  });

  it("rejects a regressing candidate and names the fixture it broke", () => {
    const v = evolveSkill(NUMBER_ADDER, CANDIDATE("number-adder-bad.mjs"));
    expect(v.accepted).toBe(false);
    expect(v.failing_fixtures).toContain("basic");
  });
});
