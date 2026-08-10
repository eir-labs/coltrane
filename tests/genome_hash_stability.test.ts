// genome_hash stability — a schema default must never move a structural hash.
//
// THE DEFECT THIS PINS (found 2026-08-10). 0.6.6 added `optional_outputs` and `preferred_skills`
// to ChairSchema with `.default([])`. Nothing about any existing standard's STRUCTURE changed —
// same phases, same chairs, same agents, same type flow — but every standard loaded through the
// schema now carried two extra materialized empty arrays, those arrays entered `canonJson`, and
// `genomeHash` moved for every standard in the genome. The ledger's reproducibility key shifted
// under runs that were byte-identical pipelines, and a resume across the bump was refused for a
// drift that did not exist.
//
// THE INVARIANT. `genomeHash` is a STRUCTURAL hash: it folds the standard's phase graph plus each
// bound agent's type surface. A field whose value is "nothing" — an empty array, an absent
// optional, a null domain — states no structure, so it must not be able to change the hash.
// Adding a schema field with an empty/absent default is therefore hash-neutral by construction,
// and the next `.default([])` cannot repeat 0.6.6.
//
// HOW IT IS ENFORCED. `canonStructuralJson` (src/canonical_form.ts) drops undefined, null and
// empty-array members before hashing, and `genomeHash` uses it instead of `canonJson`.
//
// ── THE ONE-TIME MOVE, SAID OUT LOUD ──────────────────────────────────────────────────────────
// Reaching this stable canonicalization MOVES `genome_hash` ONE MORE TIME relative to 0.6.7, for
// every standard whose chairs carry materialized empty arrays — which is every standard loaded
// through the schema. That is a deliberate, final move: it is the cost of making the hash
// insensitive to defaults, and it is paid exactly once. Two consequences an operator must know:
//   1. A ledger row written before this change carries the pre-canonicalization `genome_hash`.
//      Comparing it to a freshly computed hash will differ. That is the bump, not a tamper.
//   2. A resume (src/runtime.ts RunIdentity) or a drained-state reconstruction
//      (src/worker.ts:545) across the bump is REFUSED with a genome_hash drift line. Re-dispatch
//      cold. Nothing is silently spliced — which is the whole point of the gate.
// After this, a new schema default is hash-neutral and no further move is expected or excused.
import { describe, it, expect } from "vitest";
import { genomeHash } from "../src/runtime.js";
import { composeStandard, type Standard, type PhaseDef } from "../src/composition.js";
import { StandardSchema, ChairSchema } from "../src/genome_schema.js";
import { canonJson, canonStructuralJson } from "../src/canonical_form.js";
import { testAgent } from "./_support/agents.js";

// ── the fixture, built from PLAIN LITERALS ────────────────────────────────────────────────────
// Deliberately hand-written rather than loaded: a fixture that came out of the loader would carry
// whatever defaults the loader applies today, which is exactly the variable under test.
const scout = testAgent({ slug: "hash-scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "hashfix" });
const reader = testAgent({ slug: "hash-reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "hashfix" });

/** The LEAN form: chairs state only what they mean. No empty arrays, no null placeholders. */
const lean = {
  slug: "hash-fixture", domain: "hashfix",
  agents: [scout, reader],
  phases: [
    { name: "p1", chairs: [{ role: "r1", agent_slug: "hash-scout", output_contract: ["Signal"] }] },
    { name: "p2", chairs: [{ role: "r2", agent_slug: "hash-reader", depends_on: ["r1"], input_contract: ["Signal"], output_contract: ["Interpretation"] }] },
  ],
} as unknown as Standard;

/** The DEFAULTED form: the same structure after every schema default has been materialized. */
const defaulted = (): Standard =>
  composeStandard({
    slug: "hash-fixture", domain: "hashfix",
    agents: [scout, reader],
    phases: lean.phases.map((p) => ({
      name: p.name,
      chairs: p.chairs.map((c) => ChairSchema.parse(c)),
    })) as unknown as readonly PhaseDef[],
  });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("genome_hash — schema defaults are hash-neutral", () => {
  it("the lean literal and the fully-defaulted parse hash IDENTICALLY", () => {
    // This is the 0.6.6 defect, stated as an equality. Before the canonicalization the defaulted
    // form carried `depends_on: []`, `input_contract: []`, `optional_outputs: []`,
    // `preferred_skills: []`, `required_skills: []` and hashed differently from the lean one.
    expect(genomeHash(defaulted())).toBe(genomeHash(lean));
  });

  it("a NEW schema field defaulting to empty cannot move the hash", () => {
    // The next `.default([])`, simulated: a field the current schema does not have, materialized
    // as empty on every chair. If this moves the hash, 0.6.6 is repeatable.
    const withFutureField = {
      ...lean,
      phases: lean.phases.map((p) => ({
        name: p.name,
        chairs: p.chairs.map((c) => ({ ...c, future_field_v7: [], future_record_v7: {}, future_opt_v7: undefined })),
      })),
    } as unknown as Standard;
    expect(genomeHash(withFutureField)).toBe(genomeHash(lean));
  });

  it("a null and an absent agent domain are the same claim, so they hash the same", () => {
    // `AgentSchema.domain` defaults to null, and a hand-rolled literal leaves it undefined.
    // Both mean domain-agnostic (composition.ts, Rob #134) — a hash that separated them would
    // report a structural difference where the engine sees none.
    const nullDomain = testAgent({ slug: "agnostic", primitives: ["SENSE"], output_types: ["Signal"], domain: null });
    const absentDomain = { ...nullDomain } as Record<string, unknown>;
    delete absentDomain["domain"];
    const std = (a: unknown): Standard => ({
      slug: "agnostic-fixture", domain: "hashfix", agents: [a],
      phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "agnostic", output_contract: ["Signal"] }] }],
    } as unknown as Standard);
    expect(genomeHash(std(absentDomain))).toBe(genomeHash(std(nullDomain)));
  });

  it("PINNED — the fixture's exact hash", () => {
    // Minted when the canonicalization landed. Its job is to catch the NEXT accidental move: a
    // change to the folded field set, the projection, or the canonical form will red this line
    // even when both forms above still agree with each other. If you moved it on purpose, say so
    // in the commit and in CHANGELOG — a moved structural hash re-keys the ledger.
    expect(genomeHash(lean)).toBe("8a32fd511e49a37a246877acd1957e7b855aad3e1207536848c548c347528dff");
  });

  it("a REAL structural change still moves the hash (this is not hollow-green)", () => {
    const renamed = {
      ...lean,
      phases: [
        { name: "p1", chairs: [{ role: "r1-renamed", agent_slug: "hash-scout", output_contract: ["Signal"] }] },
        lean.phases[1],
      ],
    } as unknown as Standard;
    expect(genomeHash(renamed)).not.toBe(genomeHash(lean));

    const retyped = {
      ...lean,
      agents: [testAgent({ slug: "hash-scout", primitives: ["SENSE"], output_types: ["Judgment"], domain: "hashfix" }), reader],
    } as unknown as Standard;
    expect(genomeHash(retyped)).not.toBe(genomeHash(lean));
  });

  it("the standard's own status/description do not enter the structural hash", () => {
    // genomeHash folds {slug, domain, phases} + the agent projection, deliberately. A lifecycle
    // marker is not structure; pinning it here documents the boundary instead of leaving the
    // next reader to infer it from the absence of a field.
    const std = StandardSchema.parse({
      slug: "hash-fixture", domain: "hashfix", status: "deprecated", description: "annotated",
      phases: lean.phases,
    });
    const annotated = { ...std, agents: [scout, reader], phases: lean.phases } as unknown as Standard;
    expect(genomeHash(annotated)).toBe(genomeHash(lean));
  });
});

describe("canonStructuralJson — the canonicalization itself", () => {
  it("drops empty arrays, nulls and undefined; keeps everything that states something", () => {
    expect(canonStructuralJson({ a: 1, b: [], c: null, d: undefined, e: [0] })).toBe(canonStructuralJson({ a: 1, e: [0] }));
    expect(canonStructuralJson({ a: 1, b: {} })).toBe(canonStructuralJson({ a: 1 }));
  });

  it("does NOT drop a meaningful falsy value", () => {
    // 0, "" and false are values, not absences. Dropping them would make the hash blind to a
    // real difference — the opposite failure of the one this closes.
    expect(canonStructuralJson({ a: 0 })).not.toBe(canonStructuralJson({}));
    expect(canonStructuralJson({ a: "" })).not.toBe(canonStructuralJson({}));
    expect(canonStructuralJson({ a: false })).not.toBe(canonStructuralJson({}));
  });

  it("keeps array POSITIONS honest — a dropped member inside an array is not a hole", () => {
    // Arrays are ordered structure. Stripping a null member would silently re-index its
    // neighbours, so members are canonicalized in place and only OBJECT keys are dropped.
    expect(canonStructuralJson([1, null, 2])).not.toBe(canonStructuralJson([1, 2]));
  });

  it("sorts keys like canonJson (the two agree on everything that survives)", () => {
    expect(canonStructuralJson({ b: 1, a: 2 })).toBe(canonJson({ a: 2, b: 1 }));
  });
});
