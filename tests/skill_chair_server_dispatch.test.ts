// The MCP server must thread skill_dirs into runGig, or a standard with a skill-backed chair
// (patent-triage-v1's verdict-gate gate) fails at dispatch — "skill-backed but no skill_dir
// registered". This dispatches patent-triage-v1 THROUGH the server's gig_dispatch tool (wait
// mode) with a deterministic stub invoker (no model, no cost) and asserts the gate chair ran
// and sealed the gated triage-verdict. Without the server wiring, this is RED.
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { loadGenome } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { AgentInvoker } from "../src/runtime.js";

const REPO = process.cwd();

const STUB: Record<string, unknown> = {
  "disclosure-analyst": { real_contribution: "the integrity-gated dual-resolution switch" },
  "claim-architect": { independent_claims: [{ number: 1, text: "A method comprising: a; b; c." }] },
  "prior-art-scout": {
    "prior-art-hit": { source: "USPTO PatentsView", title: "Some prior patent", verified: true, verification_method: "fetch" },
    "novelty-verdict": { verdict: "NOVEL-ON-INDEPENDENT", rationale: "1b un-anticipated", coverage_fraction: 0.33 },
    "coverage-report": { corpora_searched: [{ corpus: "USPTO PatentsView", status: "searched" }], patent_hit_count: 1 },
  },
  "anticipation-mapper": { matrix: [{ element_id: "1a", status: "present" }], coverage_fraction: 0.33 },
  "patent-examiner": { rejections: [{ statute: "§112(a)", cleared: false }], all_cleared: false },
  "claim-amender": { round_n: 1, amended_claim: "A method ...", claim_state_sha: "h1", rejection_state_sha: "h2", predecessor_sha: "h0", survived: false },
  "triage-judge": {
    "triage-verdict": { recommended: "FILEABLE", rationale: "candidate" },
    "verdict-record": { disclosure_input_sha: "d", coverage_report_sha: "c", examine_round_record_sha: "e" },
  },
  "spec-drafter": { markdown_text: "" },
};

describe("the server threads skill_dirs into dispatch — the gate chair runs end-to-end", () => {
  it("gig_dispatch(patent-triage-v1, wait) runs the verdict-gate chair and seals a gated verdict", async () => {
    const genome = loadGenome(REPO);
    const registry = loadRegistry(genome);
    const invoke: AgentInvoker = (ctx) => {
      const out = STUB[ctx.agent.slug];
      if (!out) throw new Error(`no stub for ${ctx.agent.slug}`);
      return out as Record<string, unknown>;
    };
    const deps: ServerDeps = {
      registry,
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      standards: genome.standards,
      invoke,
      skills: genome.skills,
      // the wiring under test: derived exactly as bootstrapServerDeps does
      skill_dirs: new Map([...genome.skills.values()].map((s): [string, string] => [s.slug, String(s.package_dir)])),
      model_version: "deterministic-test",
    };

    const r = await dispatchTool("gig_dispatch", {
      standard_slug: "patent-triage-v1",
      input: { disclosure: "an integrity-gated skill cage" },
      wait: true,
    }, deps);

    expect(r.ok, `dispatch failed: ${r.error}`).toBe(true);
    const gigId = (r.data as { gig_id: string }).gig_id;
    // the gate sealed the final verdict — the judge's over-stated FILEABLE was downgraded
    const verdicts = deps.outputs.all().filter((o) => o.gig_id === gigId && o.domain_type === "triage-verdict");
    const gated = verdicts.find((o) => o.from_role === "gate");
    expect(gated, "the gate chair must have run and sealed a triage-verdict").toBeTruthy();
    expect(gated!.core_type).toBe("Verdict");
    expect(gated!.data["recommended"]).toBe("INSUFFICIENT-EVIDENCE");
    expect(gated!.data["gated"]).toBe(true);
  });
});
