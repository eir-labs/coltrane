// DR-5 — drain:identity-names-the-skills-it-seats (wiki spec.coltrane.the-drain-runs-a-graded-red-pass).
//
// runGig folds every registered skill dir's code hash into producers_sha (runtime.ts resolvedSkillHashes). The
// drain's coldRunIdentity — the identity a re-claim reconstructs and compares against — folded `skills: []`,
// because the drain registered none. Once the drain seats its packaged skills (DR-3), the two must fold the same
// list, or every resumed drain run is refused for identity drift against itself.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import * as worker from "../src/worker.js";
import { drainSkillDirs } from "../src/run_deps.js";
import { producersSha } from "../src/reuse.js";
import { loadSkillPackage } from "../src/skills.js";
import { loadGenome } from "../src/loader.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(ROOT);
type ColdRunIdentity = (standard: unknown, gigInput: Record<string, unknown>, skillDirs?: Map<string, string>) => { producers_sha: string };
const coldRunIdentity = (worker as unknown as { coldRunIdentity?: ColdRunIdentity }).coldRunIdentity;

describe("DR-5 — the drain's reconstructed identity folds exactly the skills it seats", () => {
  it("DR-5 — coldRunIdentity is reachable and takes the skill dirs the drain seats", () => {
    expect(typeof coldRunIdentity, "worker.ts exposes no coldRunIdentity that can be given the drain's skill dirs").toBe("function");
  });

  it("DR-5 — with scope-gate seated, the identity folds its code hash, as runGig's does", () => {
    const std = genome.standards.get("chancery-red-drafting-v0") ?? genome.draft_standards.get("chancery-red-drafting-v0");
    const { dirs } = drainSkillDirs(ROOT);
    expect(dirs.has("scope-gate"), "fixture: scope-gate must be seated (DR-3)").toBe(true);
    const runGigFolds = [...dirs].map(([slug, dir]) => ({ slug, code_hash: loadSkillPackage(dir).codeHash ?? "" }));
    const id = coldRunIdentity!(std, { "change-request": {} }, dirs);
    expect(id.producers_sha, "the reconstructed identity does not fold the seated skills: a resumed drain run drifts from itself")
      .toBe(producersSha({ agents: std!.agents, skills: runGigFolds }));
  });

  it("DR-5 twin — a drain that seats no skill keeps today's identity, byte for byte", () => {
    const std = genome.standards.get("chancery-red-drafting-v0") ?? genome.draft_standards.get("chancery-red-drafting-v0");
    const id = coldRunIdentity!(std, { "change-request": {} }, new Map());
    expect(id.producers_sha).toBe(producersSha({ agents: std!.agents, skills: [] }));
  });
});
