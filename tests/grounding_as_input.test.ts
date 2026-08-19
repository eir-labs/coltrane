// RED SPEC — grounding arrives as an INPUT, and judgment cannot be replaced by lookup.
//
// Two decoupled obligations the subsystem-contract holds apart:
//   (1) GROUNDING-AS-INPUT (C1/O1-O2/O8): change-context becomes a first-class input a standard may
//       be dispatched WITH, from any of four interchangeable producers (reader / compiler / prior
//       standard / human), and software-change-pr-v1 stops caring which. The precedent already
//       exists in this genome — lineage-reweave-v0 seeds an entry chair with senses it did not
//       gather (tests/studio_repass.test.ts) — it has simply never been applied to change-context.
//   (2) DO-NOT-COMPILE-AWAY-THE-CLAIMS (C3/O5-O6/O11): the mechanical fields may be compiled, but a
//       change-context is UNSATISFIABLE by a record whose claims are empty or merely restate the
//       index. A fast index that notices nothing does not pass.
//
// The seam is verified in ISOLATION (the Pact consumer/provider split, grounding-dossier
// method_findings #3): the consumer is checked against a seeded change-context over the REAL loaded
// genome (compose-time, no live agent — the studio_repass posture), and each producer/guard is
// checked against the shared change-context TYPE without running the consumer.
//
// RED by design: `src/grounding.ts` does not exist, and software-change-pr-v1 does not yet accept
// change-context as a dispatchable input. Every case fails for exactly that reason until the
// structural change lands.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const g = loadGenome(REPO);

// The grounding seam module — the assembler + the judgment guards. RED: does not exist yet.
async function grounding(): Promise<{
  assembleChangeContext: (index: RepositoryIndexLike, judgment: JudgmentLike) => Record<string, unknown>;
  admitChangeContext: (rec: Record<string, unknown>, index: RepositoryIndexLike) => { ok: boolean; reason?: string };
  freshnessGate: (rec: Record<string, unknown>, currentRevision: string) => { ok: boolean; reason?: string };
  snapshotMechanical: (rec: Record<string, unknown>) => Record<string, unknown>;
  consumerAcceptsGrounding: (rec: Record<string, unknown>) => { ok: boolean; reason?: string };
}> {
  return (await import("../src/grounding.js")) as never;
}

type RepositoryIndexLike = {
  source_revision: string;
  files_to_exports: Record<string, string[]>;
  file_importers: { from: string; to: string; symbol: string }[];
  module_tests: { module: string; test: string }[];
  entry_points: { module: string; symbol: string }[];
  conventions_observed: string[];
  boundary: string[];
};
type JudgmentLike = { claims: unknown[]; unknowns: string[]; frame: string; confidence?: number };

const fixtureIndex = (): RepositoryIndexLike => ({
  source_revision: "rev-A",
  files_to_exports: { "src/runtime.ts": ["runGig", "pullSeeds"], "src/loader.ts": ["loadGenome"] },
  file_importers: [{ from: "src/loader.ts", to: "src/runtime.ts", symbol: "pullSeeds" }],
  module_tests: [{ module: "src/runtime.ts", test: "tests/runtime.test.ts" }],
  entry_points: [{ module: "src/runtime.ts", symbol: "runGig" }],
  conventions_observed: ["files-not-DB; MCP-sole-writer"],
  boundary: ["src/runtime.ts", "src/loader.ts"],
});

// A claim that MERELY restates the index (mechanical, derivable) — a lookup masquerading as a reading.
const derivableClaim = { claim: "src/runtime.ts exports pullSeeds", locator: "src/runtime.ts" };
// A load-bearing claim — a READING: references a specific line AND asserts something the index cannot
// hold (this is the sentence in the brief that made the fix correct).
const loadBearingClaim = {
  claim: "src/runtime.ts:2072 short-circuits pullSeeds when depends_on>0, so a seed never reaches a non-entry chair — the comment concedes the scoping is deliberate",
  locator: "src/runtime.ts:2072",
};

/** A well-formed change-context record (Interpretation subtype) built from an index + judgment. */
const changeContext = (claims: unknown[], unknowns: string[]): Record<string, unknown> => ({
  id: "cc-1",
  input_refs: ["change-request/req-1"],
  frame: "the seeding seam and its scoping",
  confidence: 0.7,
  claims,
  relevant_files: [{ path: "src/runtime.ts", why: "holds the seeding seam", locator: "src/runtime.ts" }],
  existing_tests: ["tests/runtime.test.ts"],
  unknowns,
  index_revision: "rev-A",
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// (1) The seam — the consumer runs on seeded grounding; the producer is interchangeable
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("grounding-as-input — software-change-pr-v1 is dispatchable WITH a change-context", () => {
  it("I9 the consuming standard declares change-context a seedable input at its entry chair", () => {
    // O1: a payload change-context must satisfy the read-context chair's input WITHOUT the reader
    // re-deriving the mechanical half. The runtime seam already exists — #156 (runtime.ts:2101)
    // lets a gig-payload record whose type is in the standard's input_types satisfy an entry chair
    // (depends_on []). What is missing is the DECLARATION: change-context is not yet an input_type.
    const std = g.standards.get("software-change-pr-v1");
    expect(std, "software-change-pr-v1 must load").toBeTruthy();
    // RED: input_types is currently ["change-request"] only.
    expect(std!.input_types).toEqual(expect.arrayContaining(["change-request", "change-context"]));
    const readCtx = std!.phases.flatMap((p) => p.chairs).find((c) => c.role === "read-context");
    expect(readCtx, "the read-context chair must still exist").toBeTruthy();
    // It stays an ENTRY chair so a seed can satisfy it (pullSeeds is scoped to depends_on []).
    expect(readCtx!.depends_on).toEqual([]);

    // AMENDED 2026-08-20 — the third clause is withdrawn, in the open, because it contradicts I11.
    //
    // It formerly asserted the entry chair's own input_contract names change-context. But EVERY
    // input_contract entry is REQUIRED: runtime.ts:2101 throws missingGigInput for each unsatisfied
    // one, and a dispatch measured on 2026-08-20 failed with "gig input missing change-request
    // required by chair read-context (MissingGigInput)". Naming change-context there therefore makes
    // a PRE-BUILT reading MANDATORY on every run of this standard.
    //
    // I11 (immediately below) pins the opposite: the consumer is producer-agnostic across FOUR
    // interchangeable producers — a reader, the compiler, a prior standard, a human — one of which is
    // the reading chair itself. A standard that cannot run without a reading it was supposed to be
    // able to PRODUCE has lost that producer. The two laws cannot both hold.
    //
    // The seedable declaration is the STANDARD's input_types, asserted above and satisfied: #156's
    // seam (runtime.ts:2101) admits a gig-payload record whose type is in input_types at an entry
    // chair. That is the mechanism O1 actually needs. The chair-contract clause added a second,
    // stricter requirement the seam never asked for.
    //
    // Amended rather than deleted: the contradiction is recorded here so the next reader sees a
    // decision, not a gap. If input_contract later grows an optional arm — a chair that may be
    // SEEDED or may PRODUCE, which the type system cannot express today — this clause should return
    // in that form.
  });

  it("I11 the consumer is producer-agnostic — it keys on the TYPE, never on who produced it", async () => {
    const { consumerAcceptsGrounding } = await grounding();
    const base = changeContext([loadBearingClaim], ["src/chart.ts not read"]);
    // The SAME record, labelled as coming from four different producers, is accepted identically —
    // the standard cannot branch on producer identity (Pact decoupling, F7).
    const asReader = { ...base, produced_by: "john" };
    const asCompiler = { ...base, produced_by: "repo-index-compiler" };
    const asHuman = { ...base, produced_by: "human" };
    const asPrior = { ...base, produced_by: "spec-drafting-v1" };
    const r = consumerAcceptsGrounding(asReader);
    expect(r.ok).toBe(true);
    expect(consumerAcceptsGrounding(asCompiler)).toEqual(r);
    expect(consumerAcceptsGrounding(asHuman)).toEqual(r);
    expect(consumerAcceptsGrounding(asPrior)).toEqual(r);
    // The change-context TYPE carries no producer discriminant for the consumer to key on.
    const dt = g.domain_types.get("change-context")!;
    const props = Object.keys(((dt.schema as { properties?: Record<string, unknown> }).properties) ?? {});
    expect(props).not.toContain("produced_by");
  });

  it("I10 every producer emits a record that satisfies the shared change-context type", async () => {
    const { assembleChangeContext } = await grounding();
    const reg = loadRegistry(g);
    // The compiler-plus-enricher producer: mechanical fields from the index, judgment from a reader.
    const rec = assembleChangeContext(fixtureIndex(), { claims: [loadBearingClaim], unknowns: ["src/chart.ts not read"], frame: "the seam", confidence: 0.7 });
    const res = reg.validate({ core_type: "Interpretation", domain_type: "change-context", data: rec });
    expect(res.valid, `assembled record must satisfy change-context: ${res.errors.join("; ")}`).toBe(true);
    // Provider-contract negative: a record missing a required mechanical field does NOT conform.
    const missing = { ...rec };
    delete (missing as Record<string, unknown>)["relevant_files"];
    expect(reg.validate({ core_type: "Interpretation", domain_type: "change-context", data: missing }).valid).toBe(false);
  });

  it("I16 freshness gate — a change-context whose index revision != current source is refused", async () => {
    const { freshnessGate } = await grounding();
    const rec = changeContext([loadBearingClaim], ["src/chart.ts not read"]); // index_revision: "rev-A"
    expect(freshnessGate(rec, "rev-A").ok, "a matching revision is fresh").toBe(true);
    // A stale index seeding a change is worse than a slow reader (F1) — fail closed.
    expect(freshnessGate(rec, "rev-B").ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// (2) Judgment is not lookup — the load-bearing-claim predicate, the golden-master prohibition
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("do-not-compile-away-the-claims — judgment cannot be replaced by lookup", () => {
  it("I13 a change-context with empty or purely-derivable claims is refused; a reading is admitted", async () => {
    const { admitChangeContext } = await grounding();
    const idx = fixtureIndex();
    // empty claims → refused (a judgment-free grounding does not pass, O6/F3)
    expect(admitChangeContext(changeContext([], ["x"]), idx).ok).toBe(false);
    // every claim derivable from the mechanical fields → refused (template pseudo-claim, F3)
    expect(admitChangeContext(changeContext([derivableClaim], ["x"]), idx).ok).toBe(false);
    // ≥1 load-bearing claim (a locator with a line AND a non-derivable assertion) → admitted
    expect(admitChangeContext(changeContext([loadBearingClaim], ["x"]), idx).ok).toBe(true);
    // a load-bearing claim is not laundered by adding derivable ones alongside it
    expect(admitChangeContext(changeContext([derivableClaim, loadBearingClaim], ["x"]), idx).ok).toBe(true);
  });

  it("I14 judgment fields have no fixed oracle — the golden-master surface strips claims/unknowns/frame", async () => {
    const { snapshotMechanical } = await grounding();
    const rec = changeContext([loadBearingClaim], ["src/chart.ts not read"]);
    const snap = snapshotMechanical(rec);
    // No golden-master / diff snapshot may pin a fixed correct value for a judgment field — judgment
    // has no ground-truth oracle. The only snapshot-able surface is the MECHANICAL fields (I14).
    expect("claims" in snap).toBe(false);
    expect("unknowns" in snap).toBe(false);
    expect("frame" in snap).toBe(false);
    // and it does preserve the mechanical fields (a snapshot that is empty is not a snapshot)
    expect(snap["relevant_files"] ?? snap["existing_tests"]).toBeTruthy();
  });

  it("I17 degrade-not-die — a partial seal still carries a load-bearing claim and names its gaps", async () => {
    const { admitChangeContext } = await grounding();
    const reg = loadRegistry(g);
    const idx = fixtureIndex();
    // A reader/human that hit its cap seals what it HAS: a real reading, plus the unreached areas in
    // unknowns (O9/I17). It is admissible ONLY because it still carries a load-bearing claim.
    const partial = changeContext([loadBearingClaim], ["src/venue.ts — not reached before the tool-call cap", "src/drain.ts — unread"]);
    expect(admitChangeContext(partial, idx).ok).toBe(true);
    expect((partial["unknowns"] as string[]).length, "the honest bound of the read is named").toBeGreaterThan(0);
    // and it still satisfies the type (a degraded seal is not a malformed one)
    expect(reg.validate({ core_type: "Interpretation", domain_type: "change-context", data: partial }).valid).toBe(true);
  });
});
