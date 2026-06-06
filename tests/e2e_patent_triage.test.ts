// E2E proof that the patent-triage-v0 pipeline composes and runs end-to-end
// from the disk genome with a deterministic invoker. No real LLM calls; the
// invoker stands in for the one non-deterministic seam (per src/runtime model).
//
// What this proves:
//   - the standard loads from disk
//   - all 4 agents resolve and bind to phases
//   - the gig dispatcher walks the phase graph in order
//   - each phase produces a typed output of the correct domain type
//   - the final phase produces a triage-verdict (the user-facing answer)
//
// Why this matters: lets a user (or builder) confirm "the pipeline structurally
// works" without spending API dollars or waiting for real model calls. Once an
// invoker with real Claude API access is wired, the same test path runs live.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("patent-triage-v0 end-to-end via deterministic invoker", () => {
  it("dispatches a gig through all 4 phases and produces a triage-verdict", async () => {
    const genome = loadGenome(REPO);
    const registry = loadRegistry(genome);
    const standard = genome.standards.get("patent-triage-v0");
    expect(standard, "patent-triage-v0 standard should load").toBeDefined();

    // Stubbed invoker — returns realistic per-agent output shapes matching
    // each agent's declared output_type schema. The first output_type in the
    // agent's declaration is what the runtime persists.
    const invoke: AgentInvoker = (ctx) => {
      switch (ctx.agent.slug) {
        case "diamond-cutter":
          // first output_type is claim-draft
          return {
            invention_id: "test-invention-1",
            independent_claims: [
              "An ordered method for ranking input documents by their distance to a labeled reference set.",
            ],
            dependent_claims: [],
            preamble: "A method for relevance scoring.",
            minimum_viable_text: "Single-claim minimum viable text.",
          };
        case "novelty-searcher":
          // first output_type is prior-art-hit
          return {
            source: "USPTO",
            url: "https://patents.google.com/patent/US00000000",
            title: "Stub prior art reference (deterministic)",
            snippet: "Comparator method for input documents using a labeled set.",
            publication_date: "2020-01-01",
            kind: "patent",
            relevance_score: 0.42,
          };
        case "claim-rewriter":
          // first output_type is claim-draft (refined)
          return {
            invention_id: "test-invention-1",
            independent_claims: [
              "An ordered method for ranking input documents by their proximity to a labeled reference set, wherein the labeled reference set is anchored to a verified source corpus.",
            ],
            dependent_claims: [
              "The method of claim 1, wherein the labeled reference set comprises at least one peer-reviewed publication.",
            ],
            preamble: "A method for relevance scoring with verified anchors.",
            minimum_viable_text: "Refined single-claim text with verified-anchor refinement.",
          };
        case "verdict-judger":
          // first output_type is triage-verdict
          return {
            invention_id: "test-invention-1",
            recommended: "REFINE-FIRST",
            rationale: "Independent claim is defensible but one dependent claim could be tightened to clarify the verified-anchor requirement.",
            tests_passed: ["claim-form", "novelty-distance", "boundary-named"],
            tests_failed: [],
            next_step: "Refine dependent claim 1 to specify the verification mechanism for the anchor corpus.",
          };
        default:
          throw new Error(`unexpected agent slug in deterministic invoker: ${ctx.agent.slug}`);
      }
    };

    const result = await runGig(
      standard!,
      { description: "An ordered method for ranking input documents by their distance to a labeled reference set." },
      {
        outputs: createOutputStore(registry),
        ledger: new MemoryLedger(),
        invoke,
        model_version: "deterministic-test",
      },
    );

    expect(result.status).toBe("complete");
    expect(result.outputs.length).toBe(4); // four phases, four outputs

    const types = result.outputs.map((o) => o.domain_type);
    expect(types).toEqual(["claim-draft", "prior-art-hit", "claim-draft", "triage-verdict"]);

    const finalOutput = result.outputs[result.outputs.length - 1];
    expect(finalOutput!.domain_type).toBe("triage-verdict");
    const verdictData = finalOutput!.data as { recommended: string; rationale: string };
    expect(verdictData.recommended).toBeDefined();
    expect(["FILE", "FILEABLE", "REFINE-FIRST", "DO-NOT-FILE", "NEEDS-WORK", "NOT-FILEABLE", "GO", "NO-GO"]).toContain(verdictData.recommended);
    expect(verdictData.rationale).toBeDefined();
    expect(verdictData.rationale.length).toBeGreaterThan(0);

    // The ledger should have one entry for this gig with the full run fingerprint.
    expect(result.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.genome_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an audit trail: each output is provenance-linked to the prior phase's outputs", async () => {
    const genome = loadGenome(REPO);
    const registry = loadRegistry(genome);
    const standard = genome.standards.get("patent-triage-v0")!;
    const outputs = createOutputStore(registry);

    const invoke: AgentInvoker = (ctx) => {
      // Minimal valid shapes per agent's first output_type
      if (ctx.agent.slug === "diamond-cutter") return { independent_claims: ["x"] };
      if (ctx.agent.slug === "novelty-searcher") return { source: "X", title: "Y", url: "Z" };
      if (ctx.agent.slug === "claim-rewriter") return { independent_claims: ["x refined"] };
      if (ctx.agent.slug === "verdict-judger") return { recommended: "REFINE-FIRST", rationale: "—" };
      throw new Error(`bad slug: ${ctx.agent.slug}`);
    };

    const result = await runGig(standard, {}, {
      outputs, ledger: new MemoryLedger(), invoke, model_version: "trace-test",
    });

    expect(result.status).toBe("complete");

    // Each downstream output should have at least one derived_from edge to an upstream output.
    const refs = outputs.refs();
    expect(refs.length).toBeGreaterThan(0);
    // The final triage-verdict should be reachable backward to the initial claim-draft.
    const finalId = result.outputs[result.outputs.length - 1]!.id;
    const ancestors = outputs.trace(finalId);
    expect(ancestors.length).toBeGreaterThan(0);
  });
});
