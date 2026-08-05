// RED-first — issue #228: `validateOutput` (src/output_validation.ts:20) is exported,
// has its own passing test file, and is NEVER called by the write path.
//
// Independently confirmed against main @ 929f81c. `grep -rn "validateOutput" src tests`
// returns exactly three sites and no production caller:
//   - src/output_validation.ts:20            its own definition
//   - src/index.ts:10                        `export * from "./output_validation.js"`
//   - tests/artifact_validation_criteria.test.ts   its only caller, a test
//
// Read at the seam rather than by grep alone: `outputs.write` (src/outputs.ts:246-257)
// composes exactly one check —
//
//     const result = registry.validate({ core_type, domain_type, data });
//     if (!result.valid) throw new OutputStoreError(...);
//
// — and `registry.validate` returns `{valid:true}` unconditionally for a bare core type
// and for an absent domain_type (issue #227). Nothing else compensates: the only other
// checks on the runtime seal path (src/runtime.ts:729) are the chair output_contract
// check (type LABELS only, never the payload), a `typeof slice === "object"` guard, and a
// "produced no recognized output" guard. None of them looks at whether an Artifact
// carries validation_criteria or a Verdict carries checks.
//
// So the two issues are one defect seen from two sides. registry.validate's short-circuit
// comments both claim "the core_type discipline still holds" — validateOutput IS that
// discipline, and it is dead code.
//
// Contract pinned here: whatever the write path accepts, `validateOutput` must not
// already have rejected. Asserted as a differential so it cannot pass hollowly — each
// test proves the checker rejects the payload AND that the store took it anyway.
//
// RESOLUTION. #228 offered two paths: wire validateOutput in, or delete it and its test.
// The ruling is to WIRE IT IN, taking path (b) — enforce the absent-key case too and amend
// the genome to match. These tests encode that.
//
// `validateOutput` MUST STAY EXPORTED. Every red below is a differential: it proves the
// checker rejects the payload AND that the store took it anyway. That construction is what
// makes these fail for the stated reason rather than incidentally — but it means the
// symbol is load-bearing for the tests. An implementation that folds the invariant into
// `registry.validate` and deletes `src/output_validation.ts` would break these at import,
// which is a wrong-reason failure, not a real one. Keep the export (delegating to it from
// wherever the invariant ends up living is fine). This constraint is recorded on #228.
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  validateOutput,
  OutputStoreError,
  type DomainType,
  type Registry,
} from "../src";

// A Verdict subtype and an Artifact subtype, each OVERLOADING the core's constrained
// property with an unconstrained one. That is not contrived: `seeding-verdict` in this
// repo's genome redeclares `checks` without `minItems`, which is exactly how a real type
// loses the inherited floor. These make the reds reachable through a normal domain type,
// not only through the bare-core hole of #227.
const looseArtifact: DomainType = {
  slug: "loose-doc",
  extends: "Artifact",
  domain: "wiretests",
  schema: {
    properties: {
      title: { type: "string" },
      validation_criteria: { type: "array" }, // no minItems — the core's floor is overloaded away
    },
  },
  required_fields: ["title"],
};

const looseVerdict: DomainType = {
  slug: "loose-ruling",
  extends: "Verdict",
  domain: "wiretests",
  schema: {
    properties: {
      note: { type: "string" },
      checks: { type: "array" }, // no minItems, no per-item required `method`
    },
  },
  required_fields: ["note"],
};

function registry(): Registry {
  const reg = createRegistry();
  reg.registerType(looseArtifact);
  reg.registerType(looseVerdict);
  return reg;
}

describe("#228 — the write path must not accept what validateOutput rejects", () => {
  it("an Artifact with validation_criteria:[] reaches the store; validateOutput would have rejected it", () => {
    const store = createOutputStore(registry());
    const data = { title: "the draft", validation_criteria: [] };

    // PRECONDITION (green today, guarded by tests/artifact_validation_criteria.test.ts):
    // the checker exists, works, and says no.
    const checked = validateOutput({ core_type: "Artifact", domain_type: "loose-doc", data });
    expect(checked.valid).toBe(false);
    expect(checked.reason).toMatch(/validation_criteria/i);

    // RED: outputs.write never consults it, so the record seals.
    expect(() =>
      store.write({
        core_type: "Artifact",
        domain_type: "loose-doc",
        domain: "wiretests",
        gig_id: "gig-wire-1",
        agent_slug: "solution-developer",
        primitive: "CREATE",
        data,
      }),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("a Verdict with checks:[] reaches the store; validateOutput would have rejected it", () => {
    const store = createOutputStore(registry());
    const data = { note: "shipped", pass: true, checks: [] };

    const checked = validateOutput({ core_type: "Verdict", domain_type: "loose-ruling", data });
    expect(checked.valid).toBe(false);
    expect(checked.reason).toMatch(/checks/i);

    // RED: a Verdict with zero evidence seals as a passing verification.
    expect(() =>
      store.write({
        core_type: "Verdict",
        domain_type: "loose-ruling",
        domain: "wiretests",
        gig_id: "gig-wire-2",
        agent_slug: "delivery-finalizer",
        primitive: "VERIFY",
        data,
      }),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("a Verdict whose checks omit `method` reaches the store; validateOutput would have rejected it", () => {
    const store = createOutputStore(registry());
    const data = { note: "shipped", pass: true, checks: [{ target_ref: "abc", result: "pass" }] };

    const checked = validateOutput({ core_type: "Verdict", domain_type: "loose-ruling", data });
    expect(checked.valid).toBe(false);
    expect(checked.reason).toMatch(/method/i);

    expect(() =>
      store.write({
        core_type: "Verdict",
        domain_type: "loose-ruling",
        domain: "wiretests",
        gig_id: "gig-wire-3",
        agent_slug: "delivery-finalizer",
        primitive: "VERIFY",
        data,
      }),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("the freeform path (no domain_type) skips the core invariant too", () => {
    // Rob #133 made domain_type OPTIONAL, and that is settled, tested behavior — see
    // tests/rob_ergonomic_fixes.test.ts and tests/server_runtime_wires.test.ts, neither of
    // which this test touches. #133's own comment scopes the bypass precisely:
    //
    //     "The core_type discipline still holds; only the domain-schema strictness is
    //      bypassed."                                          (src/registry.ts:138-139)
    //
    // This test asserts that scoping is real. A freeform output still declares a
    // core_type, and an Artifact with no validation_criteria is not an Artifact. #133's
    // tests use core_type "Interpretation" (no declared floor) and a bare `{}` call with
    // no core_type at all, so both stay green under this rule.
    const store = createOutputStore(registry());
    const data = { content: "freeform prose", validation_criteria: [] };

    const checked = validateOutput({ core_type: "Artifact", domain_type: "", data });
    expect(checked.valid).toBe(false);

    expect(() =>
      store.write({
        core_type: "Artifact",
        domain_type: "",
        domain: "wiretests",
        gig_id: "gig-wire-4",
        agent_slug: "synthesis-writer",
        primitive: "CREATE",
        data,
      }),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });
});

describe("#228 — positive controls (must stay green after the fix)", () => {
  it("an Artifact with a populated validation_criteria[] passes both the checker and the store", () => {
    const store = createOutputStore(registry());
    const data = { title: "the draft", validation_criteria: ["reviewed by a human", "cites sources"] };
    expect(validateOutput({ core_type: "Artifact", domain_type: "loose-doc", data }).valid).toBe(true);
    expect(store.write({
      core_type: "Artifact",
      domain_type: "loose-doc",
      domain: "wiretests",
      gig_id: "gig-ok-1",
      agent_slug: "solution-developer",
      primitive: "CREATE",
      data,
    }).id).toBeTruthy();
  });

  it("a Verdict with populated checks[] passes both the checker and the store", () => {
    const store = createOutputStore(registry());
    const data = { note: "shipped", pass: true, checks: [{ method: "e2e", target_ref: "abc", result: "pass" }] };
    expect(validateOutput({ core_type: "Verdict", domain_type: "loose-ruling", data }).valid).toBe(true);
    expect(store.write({
      core_type: "Verdict",
      domain_type: "loose-ruling",
      domain: "wiretests",
      gig_id: "gig-ok-2",
      agent_slug: "delivery-finalizer",
      primitive: "VERIFY",
      data,
    }).id).toBeTruthy();
  });

  it("a non-Artifact, non-Verdict output meets ITS OWN core's floor and no more", () => {
    // Blocks the hollow "make write() stricter for everything" fix.
    //
    // THE ONE ASSERTION THE #227 RULING INVERTED. This control was written when Artifact and
    // Verdict were the only cores with a floor, so "a Signal is untouched" was the way to
    // prove the fix had not degenerated into blanket strictness. The ruling — "there's no
    // subtype thing, it's all the way top to bottom" — makes Signal carry a floor too
    // (`source`), so "untouched" is no longer the right control and asserting it would
    // forbid the ruling rather than guard the fix.
    //
    // The PURPOSE is preserved and the test is strictly stronger: it now pins BOTH halves
    // of "per-core floor, not blanket strictness". A Signal missing its own floor is
    // rejected (the ruling), and a Signal that meets it seals carrying NONE of the other
    // cores' floor fields — no validation_criteria, no checks, no claims. A degenerate
    // "reject everything" implementation fails the second half; a "reject nothing but
    // Artifact/Verdict" implementation fails the first.
    const reg = createRegistry();
    reg.registerType({
      slug: "loose-signal",
      extends: "Signal",
      domain: "wiretests",
      schema: { properties: { raw: { type: "string" }, source: { type: "string" } } },
      required_fields: ["raw"],
    });
    const store = createOutputStore(reg);

    // half 1 — Signal's own floor binds it, exactly as Artifact's binds an Artifact.
    const floorless = validateOutput({ core_type: "Signal", domain_type: "loose-signal", data: { raw: "x" } });
    expect(floorless.valid).toBe(false);
    expect(floorless.reason).toMatch(/source/i);

    // half 2 — meeting Signal's floor is ENOUGH. No other core's floor is imposed on it.
    const data = { raw: "x", source: "sensor://wiretests/probe-3" };
    expect(validateOutput({ core_type: "Signal", domain_type: "loose-signal", data }).valid).toBe(true);
    expect(store.write({
      core_type: "Signal",
      domain_type: "loose-signal",
      domain: "wiretests",
      gig_id: "gig-ok-3",
      agent_slug: "sensor",
      primitive: "SENSE",
      data,
    }).id).toBeTruthy();
  });
});

describe("#228 — the absent-key case (RULED: path (b))", () => {
  // ───────────────────────────────────────────────────────────────────────────────────
  // RULED — these are live requirements, not open questions. #228 takes path (b):
  // enforce the ABSENT-key case as well as present-but-empty, and amend the genome types
  // to match. Path (a) (present-but-empty only) was considered and rejected.
  //
  // The conflict that was adjudicated:
  //   validateOutput says REJECT: `!Array.isArray(vc)` covers the absent case, so an
  //     Artifact with NO validation_criteria key at all is invalid.
  //   registry.validate says ACCEPT: `required` stays the subtype's own, and
  //     src/registry.ts:154-156 documents that deliberately — "base fields are available,
  //     not forced … so existing instances that don't carry base fields still validate."
  //     Today an Artifact subtype that simply omits validation_criteria validates fine;
  //     only an explicitly EMPTY array trips the inherited minItems.
  // validateOutput wins. Genome amendment is part of the fix, not a reason to avoid it.
  //
  // GENOME AMENDMENT REQUIRED — 8 of 8 Artifact/Verdict subtypes, not 7 of 8:
  //   Artifact (4 of 4): draft-agent-profile, draft-domain-type, draft-standard,
  //     provisional-draft — none declares validation_criteria at all, not even as a
  //     property. These need a field added.
  //   Verdict (4 of 4): e2e-verdict, triage-verdict, verdict-record need `checks` added.
  //     seeding-verdict is the WORST case, not the safe one: it declares `checks` but
  //     overloads the item schema to require ["name","passed"] while never mentioning
  //     `method`, which validateOutput requires. A maximally schema-valid seeding-verdict
  //     is therefore REJECTED under (b). Its amendment is a genuine schema conflict, not a
  //     missing-field top-up. (The overload mechanism — a subtype redeclaring a core
  //     property silently voiding the inherited constraint — is filed as #230.)
  //
  // Test-fixture collateral is tracked separately; see the branch report. Every case found
  // was a fixture lacking checks/validation_criteria — no assertion needed weakening.
  // ───────────────────────────────────────────────────────────────────────────────────
  it("an Artifact with NO validation_criteria key seals today — must not", () => {
    const store = createOutputStore(registry());
    const data = { title: "the draft" }; // key absent entirely, not empty

    expect(validateOutput({ core_type: "Artifact", domain_type: "loose-doc", data }).valid).toBe(false);

    expect(() =>
      store.write({
        core_type: "Artifact",
        domain_type: "loose-doc",
        domain: "wiretests",
        gig_id: "gig-pending-1",
        agent_slug: "solution-developer",
        primitive: "CREATE",
        data,
      }),
    ).toThrow(OutputStoreError);
  });

  it("a Verdict with NO checks key seals today — must not", () => {
    const store = createOutputStore(registry());
    const data = { note: "shipped", pass: true };

    expect(validateOutput({ core_type: "Verdict", domain_type: "loose-ruling", data }).valid).toBe(false);

    expect(() =>
      store.write({
        core_type: "Verdict",
        domain_type: "loose-ruling",
        domain: "wiretests",
        gig_id: "gig-pending-2",
        agent_slug: "delivery-finalizer",
        primitive: "VERIFY",
        data,
      }),
    ).toThrow(OutputStoreError);
  });
});
