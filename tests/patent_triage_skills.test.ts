// The v1 patent-triage skills must actually WORK, not just load: each runs its fixtures in the
// permission cage DETERMINISM_RUNS times, and we assert every fixture passes AND the output is
// deterministic. This is the "is it good" gate — a skill that loads but mis-parses (or is
// accidentally non-deterministic) is caught here, not in a live gig.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSkillFixtures } from "../src/skill_subprocess.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = [
  "patent-fetch",
  "patent-search",
  "query-expand",
  "citation-verify",
  "claim-element-decompose",
  "element-mapping-matrix",
  "statutory-checklist",
  "verdict-gate",
];

describe("patent-triage v1 skills — fixtures pass + deterministic", () => {
  for (const s of SKILLS) {
    it(`${s} executes, every fixture passes, output is deterministic`, () => {
      const r = runSkillFixtures(join(REPO, "skills", s));
      expect(r.total, `${s} has no fixtures`).toBeGreaterThan(0);
      expect(r.pass_rate, `${s} fixtures: ${JSON.stringify(r.results)}`).toBe(1.0);
      expect(r.deterministic, `${s} is not deterministic`).toBe(true);
    });
  }
});
