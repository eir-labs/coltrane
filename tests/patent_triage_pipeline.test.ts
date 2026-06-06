// End-to-end pipeline tests for the patent-triage-v0 standard.
//
// Structural assertions are GREEN now. Verdict-contract and discipline-gate
// tests are todo until the runtime is wired against a Claude executor; each
// names the contract the pipeline must satisfy when the executor is live.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");
const STANDARD_PATH = join(REPO_ROOT, "standards", "patent-triage-v0.json");

function standardExists(): boolean {
  return existsSync(STANDARD_PATH);
}

function readStandard(): any | null {
  if (!standardExists()) return null;
  try {
    return JSON.parse(readFileSync(STANDARD_PATH, "utf8"));
  } catch {
    return null;
  }
}

describe("patent-triage-v0 — pipeline contract", () => {
  it("standards/patent-triage-v0.json exists and parses", () => {
    expect(standardExists()).toBe(true);
    const s = readStandard();
    expect(s).not.toBeNull();
    expect(s.slug).toBe("patent-triage-v0");
  });

  it("standard composes 4 phases in order: cleave → search-novelty → refine-claim → judge", () => {
    const s = readStandard();
    expect(s).not.toBeNull();
    const phases = (s.phases ?? []).map((p: any) => p.name);
    expect(phases).toEqual(["cleave", "search-novelty", "refine-claim", "judge"]);
  });

  it("standard agent_slugs references {diamond-cutter, novelty-searcher, claim-rewriter, verdict-judger}", () => {
    const s = readStandard();
    expect(s).not.toBeNull();
    expect(s.agent_slugs).toEqual([
      "diamond-cutter",
      "novelty-searcher",
      "claim-rewriter",
      "verdict-judger",
    ]);
  });
});

describe("patent-triage-v0 — verdict contract on known invention shapes", () => {
  // The three canonical input shapes. Inputs are placeholders — the discipline
  // is in the verdict each shape should drive. When the runtime is wired,
  // these tests will execute the standard and assert the output verdict.

  it.todo("CLEAR-FILEABLE shape → triage_verdict = FILEABLE + provisional_draft attached");
  it.todo("CLEAR-NOT-FILEABLE shape → triage_verdict = NOT-FILEABLE + cited prior-art-hit + no provisional draft");
  it.todo("CLEAR-REFINE-FIRST shape → triage_verdict = REFINE-FIRST + refinement direction text");
});

describe("patent-triage-v0 — discipline gates on pipeline output", () => {
  it.todo("phase-1 output includes a non-empty what-this-is-NOT list");
  it.todo("provisional-draft output passes the substrate-leakage gate");
  it.todo("chain receipt seals each phase event in declared order");
});
