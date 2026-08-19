// Laws for checkGigConformance — the gig-close CLASSIFIER that answers whether a sealed run
// fits its own construction along two axes: FIT (every chair's declared output_contract type is
// satisfied by ≥1 sealed record from that chair; nothing sealed under a type the chair never
// declared) and TIMING (every current-gig sealed record's input_shas resolve to outputs of chairs
// its producer declared depends_on — plus the examine-amend feedback edge and the gig input).
//
// PURITY is the through-line: every law here is built from in-memory Standard / OutputRecord /
// SkippedChair LITERALS. No AgentInvoker, no OutputStore, no gig run, no network, no model. If a
// test in this file needs to spin up a store to make its point, the function under test is not the
// pure classifier the change-request demands — that is itself part of what these laws assert.
import { describe, it, expect } from "vitest";
import { checkGigConformance, type GigConformanceResult } from "../src/gig_conformance.js";
import type { Standard, Chair, PhaseDef } from "../src/composition.js";
import type { OutputRecord } from "../src/outputs.js";
import type { SkippedChair } from "../src/runtime.js";

const GIG = "gig-current";
const PRIOR = "gig-prior";

// ── Minimal literal builders ────────────────────────────────────────────────────────────────
// Just enough of each shape for the classifier to read; every field the function touches is set,
// the rest are given inert defaults so a literal stays a one-liner at the callsite.

function chair(role: string, output_contract: string[], opts?: Partial<Chair>): Chair {
  return {
    role,
    agent_slug: opts?.agent_slug ?? `${role}-agent`,
    depends_on: opts?.depends_on ?? [],
    input_contract: opts?.input_contract ?? [],
    output_contract,
    ...(opts?.optional_outputs ? { optional_outputs: opts.optional_outputs } : {}),
    required_skills: opts?.required_skills ?? [],
  };
}

function std(phases: PhaseDef[], slug = "conformance-std"): Standard {
  // Only the fields checkGigConformance reads have to be real (slug, phases). The rest of the
  // Standard surface is irrelevant to a pure structural check, so it is cast past — the point of
  // the classifier is that it needs the CHART, not a live composed genome.
  return { slug, domain: "eirtests", phases } as unknown as Standard;
}

let recSeq = 0;
function rec(opts: {
  role: string;
  domain_type: string;
  core_type?: string;
  content_sha: string;
  input_shas?: string[];
  gig_id?: string;
  reused_from?: OutputRecord["reused_from"];
}): OutputRecord {
  recSeq += 1;
  return {
    id: `rec-${recSeq}`,
    core_type: opts.core_type ?? "Artifact",
    domain_type: opts.domain_type,
    domain_type_version: 1,
    domain: "eirtests",
    gig_id: opts.gig_id ?? GIG,
    agent_slug: `${opts.role}-agent`,
    from_role: opts.role,
    phase: "p1",
    primitive: "CREATE",
    data: {},
    content_sha: opts.content_sha,
    input_refs: [],
    input_shas: opts.input_shas ?? [],
    created_at: "2026-01-01T00:00:00.000Z",
    ...(opts.reused_from ? { reused_from: opts.reused_from } : {}),
  };
}

// Narrowing helper — a law that asserts a verdict shape wants the payload, not `any`.
function asViolated(r: GigConformanceResult): Extract<GigConformanceResult, { verdict: "VIOLATED" }> {
  expect(r.verdict).toBe("VIOLATED");
  if (r.verdict !== "VIOLATED") throw new Error("unreachable");
  return r;
}

describe("checkGigConformance — FIT", () => {
  it("CLEAN when every chair sealed every declared output type", () => {
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"], { agent_slug: "a" })] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { agent_slug: "b", depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-maker", input_shas: ["sha-scout"] }),
    ];
    expect(checkGigConformance(s, produced, [], "complete", GIG).verdict).toBe("CLEAN");
  });

  it("VIOLATED naming the chair and the type when a declared type sealed nothing", () => {
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      // maker promises BOTH Draft and Rationale but seals only Draft.
      { name: "p2", chairs: [chair("maker", ["Draft", "Rationale"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-maker", input_shas: ["sha-scout"] }),
    ];
    const v = asViolated(checkGigConformance(s, produced, [], "complete", GIG));
    expect(v.fit_violations).toEqual([{ chair_slug: "maker", declared_type: "Rationale" }]);
    expect(v.timing_violations).toEqual([]);
  });

  it("does not flag a declared-optional type that sealed nothing (a conditional output is not a gap)", () => {
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      {
        name: "p2",
        chairs: [chair("triage", ["Verdict", "Draft"], { depends_on: ["scout"], optional_outputs: ["Draft"] })],
      },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "triage", domain_type: "Verdict", core_type: "Verdict", content_sha: "sha-v", input_shas: ["sha-scout"] }),
    ];
    expect(checkGigConformance(s, produced, [], "complete", GIG).verdict).toBe("CLEAN");
  });

  it("VIOLATED with fit_surplus when a record is sealed under a type the chair never declared", () => {
    const s = std([{ name: "p1", chairs: [chair("scout", ["Signal"])] }]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-a" }),
      rec({ role: "scout", domain_type: "SecretPlan", content_sha: "sha-b" }),
    ];
    const v = asViolated(checkGigConformance(s, produced, [], "complete", GIG));
    expect(v.fit_violations).toEqual([]);
    expect(v.fit_surplus).toEqual([{ chair_slug: "scout", sealed_type: "SecretPlan" }]);
  });
});

describe("checkGigConformance — CARDINALITY is not the question", () => {
  it("CLEAN when a chair seals MANY records of one declared type (the lineage-scout case)", () => {
    // The multi-record seal fix (main 716da74) is exactly what makes this the RIGHT answer:
    // a scout gathering fifteen hits of its one declared type is conformant, not surplus.
    const s = std([{ name: "p1", chairs: [chair("lineage-scout", ["lineage-hit"])] }]);
    const produced = Array.from({ length: 15 }, (_, i) =>
      rec({ role: "lineage-scout", domain_type: "lineage-hit", content_sha: `hit-${i}` }),
    );
    const r = checkGigConformance(s, produced, [], "complete", GIG);
    expect(r.verdict).toBe("CLEAN");
  });
});

describe("checkGigConformance — TIMING", () => {
  it("VIOLATED naming both chairs when a record's input_sha comes from an undeclared chair", () => {
    // maker depends_on scout ONLY, but consumed an output whose sha belongs to `sibling` — a seat
    // that read a sibling's work it was never seated to see.
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"]), chair("sibling", ["Rumor"])] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "sibling", domain_type: "Rumor", content_sha: "sha-sibling" }),
      rec({
        role: "maker",
        domain_type: "Draft",
        content_sha: "sha-maker",
        input_shas: ["sha-scout", "sha-sibling"],
      }),
    ];
    const v = asViolated(checkGigConformance(s, produced, [], "complete", GIG));
    expect(v.fit_violations).toEqual([]);
    expect(v.timing_violations).toEqual([
      {
        record_id: produced[2]!.id,
        sealing_chair_slug: "maker",
        unauthorized_sha: "sha-sibling",
        unauthorized_source_chair_slug: "sibling",
      },
    ]);
  });

  it("CLEAN when provenance respects the declared edges", () => {
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-maker", input_shas: ["sha-scout"] }),
    ];
    expect(checkGigConformance(s, produced, [], "complete", GIG).verdict).toBe("CLEAN");
  });

  it("does not flag an entry chair whose input_sha resolves to no in-gig record (a chart seed)", () => {
    // A seed carried over a chart edge is a real cross-gig record NOT present in produced[]. Its
    // sha appears in the entry chair's input_shas but resolves to nothing here — unresolvable, so
    // the check must stay silent rather than manufacture a violation on every movement.
    const s = std([{ name: "p1", chairs: [chair("entry", ["Draft"])] }]);
    const produced = [
      rec({ role: "entry", domain_type: "Draft", content_sha: "sha-entry", input_shas: ["sha-from-prior-movement"] }),
    ];
    expect(checkGigConformance(s, produced, [], "complete", GIG).verdict).toBe("CLEAN");
  });
});

describe("checkGigConformance — the four false-violation cases", () => {
  it("REUSE: a contract satisfied by a prior gig's reused output is CLEAN, and TIMING skips it", () => {
    // The reuse cache re-seals a prior gig's output into THIS gig, carrying reused_from and the
    // SOURCE gig's provenance shas (which resolve to nothing here). Both FIT and TIMING must read
    // it as conformant: the source gig validated its own chain at close.
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({
        role: "maker",
        domain_type: "Draft",
        content_sha: "sha-maker",
        // shas from the prior gig — unresolvable in THIS gig, and skipped because reused_from is set.
        input_shas: ["sha-prior-upstream"],
        reused_from: { output_id: "prior-out", gig_id: PRIOR, cache_key: "k1" },
      }),
    ];
    const skipped: SkippedChair[] = [
      {
        phase: "p2",
        role: "maker",
        reason: "reuse",
        source_gig_id: PRIOR,
        output_types: ["Draft"],
        content_shas: ["sha-maker"],
        cache_key: "k1",
      },
    ];
    expect(checkGigConformance(s, produced, skipped, "complete", GIG).verdict).toBe("CLEAN");
  });

  it("REUSE (referenced, not re-sealed): a SkippedChair covers the declared type even with no in-gig record", () => {
    // The alternate reuse shape the change-request names literally: the covering record lives under
    // the PRIOR gig_id and is not in produced[]. The SkippedChair's output_types is what satisfies
    // the contract; a cross-gig record present in produced is skipped by TIMING on gig_id alone.
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      // The reused output as it lived in the prior gig, offered by reference.
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-prior", gig_id: PRIOR, input_shas: ["x"] }),
    ];
    const skipped: SkippedChair[] = [
      { phase: "p2", role: "maker", reason: "reuse", source_gig_id: PRIOR, output_types: ["Draft"], content_shas: ["sha-prior"], cache_key: "k1" },
    ];
    expect(checkGigConformance(s, produced, skipped, "complete", GIG).verdict).toBe("CLEAN");
  });

  it("PARKED: awaiting_approval is INCOMPLETE, never VIOLATED, and runs no FIT/TIMING", () => {
    // A human chair legitimately has no output yet. INCOMPLETE and NONCONFORMANT must not collapse:
    // the missing approval output is NOT a FIT violation.
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      { name: "p2", chairs: [chair("approver", ["Judgment"], { depends_on: ["scout"] })] },
    ]);
    const produced = [rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" })];
    const r = checkGigConformance(s, produced, [], "awaiting_approval", GIG);
    expect(r.verdict).toBe("INCOMPLETE");
  });

  it("AMEND ROUNDS: several records from one chair are clean, and consuming the verify feedback is not a timing violation", () => {
    // The examine-amend loop re-runs the maker with the FAILING verdict fed back in — so an amend
    // record's input_shas legitimately include the verify chair's verdict, and the verify chair
    // depends_on the maker (the edge, read in reverse for feedback). Neither the multiple records
    // (surplus) nor the feedback provenance (timing) may read as a violation.
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      {
        name: "p2",
        chairs: [
          chair("maker", ["Draft"], { depends_on: ["scout"] }),
          chair("verify", ["Verdict"], { depends_on: ["maker"] }),
        ],
      },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      // round 0 maker + failing verdict
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-draft-0", input_shas: ["sha-scout"] }),
      rec({ role: "verify", domain_type: "Verdict", core_type: "Verdict", content_sha: "sha-verdict-0", input_shas: ["sha-draft-0"] }),
      // round 1 amend — the maker consumed the verify feedback (a reverse edge) plus its own input
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-draft-1", input_shas: ["sha-scout", "sha-verdict-0"] }),
      rec({ role: "verify", domain_type: "Verdict", core_type: "Verdict", content_sha: "sha-verdict-1", input_shas: ["sha-draft-1"] }),
    ];
    const r = checkGigConformance(s, produced, [], "complete", GIG);
    expect(r.verdict).toBe("CLEAN");
  });

  it("FAILED: a status that is neither complete nor awaiting_approval is described, not condemned", () => {
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"])] },
      { name: "p2", chairs: [chair("maker", ["Draft"], { depends_on: ["scout"] })] },
    ]);
    // A run that died mid-phase — the maker never sealed. This is NOT a FIT violation.
    const produced = [rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" })];
    const r = checkGigConformance(s, produced, [], "failed", GIG);
    expect(r.verdict).toBe("FAILED");
    if (r.verdict !== "FAILED") throw new Error("unreachable");
    expect(r.description).toContain("failed");
  });
});

describe("checkGigConformance — PURITY", () => {
  it("both violation axes populate in a single VIOLATED, from literals alone", () => {
    // FIT gap AND timing breach in one run → one VIOLATED with both arrays populated. Nothing in
    // this test constructs a store, an invoker, or a gig — the classifier is a pure function of
    // (chart, sealed set).
    const s = std([
      { name: "p1", chairs: [chair("scout", ["Signal"]), chair("sibling", ["Rumor"])] },
      { name: "p2", chairs: [chair("maker", ["Draft", "Rationale"], { depends_on: ["scout"] })] },
    ]);
    const produced = [
      rec({ role: "scout", domain_type: "Signal", content_sha: "sha-scout" }),
      rec({ role: "sibling", domain_type: "Rumor", content_sha: "sha-sibling" }),
      rec({ role: "maker", domain_type: "Draft", content_sha: "sha-maker", input_shas: ["sha-scout", "sha-sibling"] }),
    ];
    const v = asViolated(checkGigConformance(s, produced, [], "complete", GIG));
    expect(v.fit_violations).toEqual([{ chair_slug: "maker", declared_type: "Rationale" }]);
    expect(v.timing_violations).toEqual([
      {
        record_id: produced[2]!.id,
        sealing_chair_slug: "maker",
        unauthorized_sha: "sha-sibling",
        unauthorized_source_chair_slug: "sibling",
      },
    ]);
  });

  it("the union is constructible and matchable for every variant with no runtime dependency", () => {
    const variants: GigConformanceResult[] = [
      { verdict: "CLEAN" },
      { verdict: "INCOMPLETE", awaiting_status: "awaiting_approval" },
      { verdict: "FAILED", description: "gig ended in status \"aborted\"" },
      { verdict: "VIOLATED", fit_violations: [], fit_surplus: [], timing_violations: [] },
    ];
    for (const v of variants) {
      switch (v.verdict) {
        case "CLEAN":
          expect(v.verdict).toBe("CLEAN");
          break;
        case "INCOMPLETE":
          expect(v.awaiting_status).toBe("awaiting_approval");
          break;
        case "FAILED":
          expect(v.description).toContain("aborted");
          break;
        case "VIOLATED":
          expect(v.fit_violations).toEqual([]);
          break;
      }
    }
  });
});
