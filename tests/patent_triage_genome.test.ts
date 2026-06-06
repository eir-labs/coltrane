// Patent-triage-v0 pipeline — genome-level tests.
//
// Pre-reg
// =======
// predict: the patent-triage-v0 standard, its 4 agents, and the 7 domain
//          types load cleanly into the genome, and the composition resolves
//          all agent references without error.
// test:    this file
// kill:    if any of the agents / standard / domain types fails to load, or
//          composition rejects the wiring, the test flags it.
// note:    this test does NOT exercise live phase execution (no LLM calls);
//          phase-execution tests are in patent_triage_pipeline.test.ts.
// verdict: green expected post-merge.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..");

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

describe("patent-triage-v0 — genome files exist on disk", () => {
  it("standards/patent-triage-v0.json exists and is valid JSON", () => {
    const p = join(REPO_ROOT, "standards", "patent-triage-v0.json");
    expect(existsSync(p)).toBe(true);
    const s = readJson(p);
    expect(s.slug).toBe("patent-triage-v0");
  });

  it("all 4 agent files exist", () => {
    for (const slug of ["diamond-cutter", "novelty-searcher", "claim-rewriter", "verdict-judger"]) {
      const p = join(REPO_ROOT, "agents", `${slug}.json`);
      expect(existsSync(p), `missing agent ${slug}`).toBe(true);
      const a = readJson(p);
      expect(a.slug).toBe(slug);
    }
  });

  it("all 7 domain types exist", () => {
    for (const slug of [
      "invention-spec",
      "prior-art-hit",
      "novelty-verdict",
      "claim-draft",
      "failure-modes",
      "provisional-draft",
      "triage-verdict",
    ]) {
      const p = join(REPO_ROOT, "domain_types", `${slug}.json`);
      expect(existsSync(p), `missing domain_type ${slug}`).toBe(true);
    }
  });
});

describe("patent-triage-v0 — composition wiring (structural)", () => {
  const standardPath = join(REPO_ROOT, "standards", "patent-triage-v0.json");
  const standard = existsSync(standardPath) ? readJson(standardPath) : null;

  it("standard names exactly the 4 agents", () => {
    expect(standard).not.toBeNull();
    const slugs = (standard as { agent_slugs: string[] }).agent_slugs;
    expect(slugs).toEqual(["diamond-cutter", "novelty-searcher", "claim-rewriter", "verdict-judger"]);
  });

  it("standard has 4 phases in correct order", () => {
    const phases = (standard as { phases: { name: string; agent: string }[] }).phases;
    expect(phases.map((p) => p.name)).toEqual(["cleave", "search-novelty", "refine-claim", "judge"]);
    expect(phases.map((p) => p.agent)).toEqual([
      "diamond-cutter",
      "novelty-searcher",
      "claim-rewriter",
      "verdict-judger",
    ]);
  });

  it("standard input_types = [invention-spec], output_types contain triage-verdict", () => {
    const s = standard as { input_types: string[]; output_types: string[] };
    expect(s.input_types).toContain("invention-spec");
    expect(s.output_types).toContain("triage-verdict");
  });

  it("diamond-cutter consumes invention-spec and produces claim-draft + failure-modes", () => {
    const a = readJson(join(REPO_ROOT, "agents", "diamond-cutter.json"));
    expect(a.input_types).toEqual(["invention-spec"]);
    expect(a.output_types).toEqual(expect.arrayContaining(["claim-draft", "failure-modes"]));
  });

  it("novelty-searcher consumes claim-draft and produces prior-art-hit + novelty-verdict", () => {
    const a = readJson(join(REPO_ROOT, "agents", "novelty-searcher.json"));
    expect(a.input_types).toEqual(["claim-draft"]);
    expect(a.output_types).toEqual(expect.arrayContaining(["prior-art-hit", "novelty-verdict"]));
  });

  it("claim-rewriter consumes claim-draft and produces claim-draft (reads novelty-verdict from substrate)", () => {
    // novelty-verdict is read from the substrate at runtime, not declared as
    // a strict input_type — keeps the composition cycle-free.
    const a = readJson(join(REPO_ROOT, "agents", "claim-rewriter.json"));
    expect(a.input_types).toEqual(["claim-draft"]);
    expect(a.output_types).toContain("claim-draft");
  });

  it("verdict-judger consumes all upstream outputs and produces triage-verdict", () => {
    const a = readJson(join(REPO_ROOT, "agents", "verdict-judger.json"));
    expect(a.input_types).toEqual(
      expect.arrayContaining(["claim-draft", "novelty-verdict", "failure-modes"]),
    );
    expect(a.output_types).toContain("triage-verdict");
  });
});

describe("patent-triage-v0 — diamond-cutting-discipline skill wiring", () => {
  it("skills/diamond-cutting-discipline.json exists and parses", () => {
    const p = join(REPO_ROOT, "skills", "diamond-cutting-discipline.json");
    expect(existsSync(p)).toBe(true);
    const s = readJson(p);
    expect(s.slug).toBe("diamond-cutting-discipline");
    expect(typeof s.md).toBe("string");
    expect((s.md as string).length).toBeGreaterThan(500);
  });

  it("all 4 patent-triage agents declare skill_slugs containing diamond-cutting-discipline", () => {
    for (const slug of ["diamond-cutter", "novelty-searcher", "claim-rewriter", "verdict-judger"]) {
      const a = readJson(join(REPO_ROOT, "agents", `${slug}.json`));
      expect(a.skill_slugs, `agent ${slug} missing skill_slugs`).toBeDefined();
      expect(a.skill_slugs as string[], `agent ${slug} does not ground in diamond-cutting-discipline`)
        .toContain("diamond-cutting-discipline");
    }
  });
});

describe("patent-triage-v0 — runtime contract (todo until executor lands)", () => {
  // These name the contract the runtime + executor must satisfy. They will
  // turn GREEN when the four agents are invoked against a Claude executor
  // and produce typed outputs that meet the contract.
  it.todo("diamond-cutter phase: invention-spec → claim-draft with ≥3 failure modes + ≥5 what-this-is-NOT distinctions");
  it.todo("novelty-searcher phase: claim-draft → ≥1 prior-art-hit OR a novelty-verdict=PASS");
  it.todo("claim-rewriter phase: enforces ≤1 independent claim + ≤3 functional elements joined by `comprising`");
  it.todo("verdict-judger phase: emits FILEABLE / REFINE-FIRST / NOT-FILEABLE + named axis when REFINE-FIRST");
  it.todo("end-to-end: invention-spec input → triage-verdict output, all 4 phases sealed in chain");
});
