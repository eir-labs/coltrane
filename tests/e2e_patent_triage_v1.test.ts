// Deterministic e2e for patent-triage-v1's FAITHFUL chair contracts. The v1 standard now
// carries real depends_on/input_contract per chair (not the depends_on:[] workaround), so the
// runtime wires each chair's inputs from its depended-on roles rather than the all-prior-outputs
// fallback. This proves that routing end-to-end with a deterministic invoker (no model, no cost):
// all 8 phases run, multi-output chairs seal each declared type, and — the load-bearing check —
// the judge receives exactly the four upstream types its input_contract names, via depends_on.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// minimal schema-valid output per agent; multi-output agents return a blob keyed by domain_type.
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
    // the judge now emits its honest CANDIDATE — here an (over-stated) FILEABLE that the
    // deterministic gate chair must downgrade, since the stub coverage is literature-only and
    // the examine-round-record did not survive.
    "triage-verdict": { recommended: "FILEABLE", rationale: "candidate: claim 1 reads novel on the cited art" },
    "verdict-record": { disclosure_input_sha: "d", coverage_report_sha: "c", examine_round_record_sha: "e" },
  },
  "spec-drafter": { markdown_text: "" },
};

describe("patent-triage-v1 — faithful chair contracts route inputs via depends_on (deterministic)", () => {
  it("runs all 8 phases, seals each multi-output type, and the judge gets its four declared inputs", async () => {
    const genome = loadGenome(REPO);
    const standard = genome.standards.get("patent-triage-v1");
    expect(standard, "patent-triage-v1 must load").toBeTruthy();

    let judgeInputs: string[] = [];
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "triage-judge") judgeInputs = ctx.inputs.map((i) => i.domain_type).sort();
      const out = STUB[ctx.agent.slug];
      if (!out) throw new Error(`no stub for ${ctx.agent.slug}`);
      return out as Record<string, unknown>;
    };

    // the gate phase is a skill-backed chair — wire each skill's package dir so the runtime can
    // run the verdict-gate code half (no model) when it reaches the gate.
    const skill_dirs = new Map<string, string>([...genome.skills.values()].map((s) => [s.slug, String(s.package_dir)] as [string, string]));
    const res = await runGig(standard!, { disclosure: "an integrity-gated skill cage" }, {
      outputs: createOutputStore(loadRegistry(genome)),
      ledger: new MemoryLedger(),
      invoke,
      skills: genome.skills,
      skill_dirs,
      model_version: "deterministic-test",
    });

    expect(res.status).toBe("complete");
    // 9 chairs; multi-output: search→3, judge→2; gate→1 (the gated triage-verdict) (+ analyze,
    // claim,map,examine,amend,draft singles) = 12
    const types = res.outputs.map((o) => o.domain_type).sort();
    expect(res.outputs.length).toBe(12);
    for (const t of ["invention-analysis", "claim-draft", "prior-art-hit", "novelty-verdict", "coverage-report",
      "novelty-analysis", "examiner-rejection", "examine-round-record", "triage-verdict", "verdict-record", "provisional-draft"]) {
      expect(types, `missing sealed ${t}`).toContain(t);
    }
    // THE gate proof: the deterministic gate chair downgrades the judge's over-stated FILEABLE
    // candidate to INSUFFICIENT-EVIDENCE (the stub claim did not survive an examine round). The
    // gated verdict is the one from the `gate` role; the judge's candidate is from `judge`.
    const verdicts = res.outputs.filter((o) => o.domain_type === "triage-verdict");
    expect(verdicts.length, "judge candidate + gate final = two triage-verdicts").toBe(2);
    const gated = verdicts.find((o) => o.from_role === "gate");
    const candidate = verdicts.find((o) => o.from_role === "judge");
    expect(candidate!.data["recommended"]).toBe("FILEABLE");
    expect(gated, "the gate must seal the final verdict").toBeTruthy();
    expect(gated!.core_type).toBe("Verdict");
    expect(gated!.data["recommended"]).toBe("INSUFFICIENT-EVIDENCE");
    expect(gated!.data["gated"]).toBe(true);
    // THE load-bearing check: the judge's inputs are routed via depends_on [search, map, examine,
    // amend] — it receives all four required input_contract types (search contributes 3 outputs,
    // so prior-art-hit/novelty-verdict ride along too — role-scoped is fine)...
    for (const t of ["coverage-report", "novelty-analysis", "examiner-rejection", "examine-round-record"]) {
      expect(judgeInputs, `judge missing required input ${t}`).toContain(t);
    }
    // ...and it is SCOPED to those roles — it does NOT get analyze/claim outputs, which the legacy
    // all-prior-outputs fallback would have dumped in. This is the faithful-contract proof.
    expect(judgeInputs).not.toContain("invention-analysis");
    expect(judgeInputs).not.toContain("claim-draft");
  });
});
