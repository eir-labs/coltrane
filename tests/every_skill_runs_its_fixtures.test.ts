// EVERY SHIPPED SKILL RUNS ITS FIXTURES — a skill's fixtures are its guarantee, and a
// guarantee nobody is obliged to run is not one.
//
// Found in #545's non-author review (26 Sep): the landscape skills' fifteen fixtures were
// run by no law, no laws.sh band and no CI job. With case folding planted in
// landscape-evidence-check/skill.mjs the whole root suite stayed green. The existing
// skill_fixtures law runs `runSkillFixtures` on hand-picked packages only, so every skill
// added since was unprotected by construction.
//
// So this law DISCOVERS the skills: every directory under skills/ that carries fixtures is
// run through the engine's own runner (never a re-implementation). A new skill is covered
// the moment it lands. The only way out is the BOOKED list below — skills that fail their
// own fixtures on main today, named with the date they were found. It may only shrink:
// a booked skill that starts passing turns this law red until it is struck from the list.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { runSkillFixtures } from "../src/skill_subprocess.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = join(REPO_ROOT, "skills");

// Booked 26 Sep 2026: failing their own fixtures on main (29c9a44) when this law was written.
// Each is a finding for its owner, not a waiver: fix the skill, then strike it here.
const BOOKED: Record<string, string> = {
  "diamond-cutting-discipline": "1/1 fixture fails and the output is non-deterministic",
  "obligation-adjudicate": "1 of 8 fixtures fails",
  "summarize-tight": "1/1 fixture fails and the output is non-deterministic",
};

const withFixtures = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, "fixtures")))
  .map((d) => d.name)
  .sort();

describe("every shipped skill runs its fixtures, discovered not listed", () => {
  it("discovers the skills — an empty walk is a broken law, not a green one", () => {
    expect(withFixtures.length).toBeGreaterThan(0);
    for (const s of ["landscape-evidence-check", "landscape-gate", "landscape-cartograph"]) {
      expect(withFixtures, `${s} must be discovered`).toContain(s);
    }
  });

  for (const skill of withFixtures) {
    it(`${skill}: ${BOOKED[skill] ? "booked red — still fails (strike it when it passes)" : "every fixture passes, deterministically"}`, () => {
      const report = runSkillFixtures(join(SKILLS, skill));
      expect(report.total, `${skill} has a fixtures directory but the runner found none`).toBeGreaterThan(0);
      const clean = report.pass_rate === 1.0 && report.deterministic === true;
      if (BOOKED[skill]) {
        expect(clean, `${skill} now passes — strike it from BOOKED`).toBe(false);
      } else {
        expect(report.pass_rate, JSON.stringify(report.results)).toBe(1.0);
        expect(report.deterministic, `${skill} is non-deterministic`).toBe(true);
      }
    }, 120_000);
  }

  it("the booked list names only skills that exist", () => {
    for (const s of Object.keys(BOOKED)) expect(withFixtures, `booked ${s} is gone — strike it`).toContain(s);
  });
});
