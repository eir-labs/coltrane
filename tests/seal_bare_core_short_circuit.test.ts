// RED-first — issue #227: `src/registry.ts` short-circuits schema validation for outputs
// whose `domain_type` is a BARE CORE TYPE, so any object the invoker produces seals
// unchallenged.
//
//   src/registry.ts:145-146
//     if (isCoreType(output.domain_type)) return { valid: true, errors: [] };
//
// The comment on that branch claims: "The core_type discipline still holds; there's just
// no domain schema to enforce." That claim is FALSE — nothing enforces the core_type
// discipline on this path. `src/output_validation.ts` is the code that would hold it, and
// it is never called from the write path (issue #228, pinned in
// tests/seal_core_invariant_wiring.test.ts).
//
// WHY THIS IS NOT A JUDGEMENT CALL. The engine ALREADY enforces the invariant one level
// down: a domain type extending Artifact inherits the core's
// `validation_criteria: { minItems: 1 }` through CORE_SCHEMA_PROPS (registry.ts:12-17),
// so the identical payload is REJECTED under a subtype and ACCEPTED under the bare core.
// Every test below pins that differential — the same bytes, two verdicts. A reviewer
// cannot dismiss these as "we never intended to check that": the engine demonstrably
// does check it, just not where it matters most.
//
// RULING (received after this file landed RED): "There's no subtype thing. It's all the way
// top to bottom." Every core carries a substance floor and it binds bare cores and domain
// subtypes alike — so the PENDING block that used to close this file is gone, and its case
// (event-clusterer / bare Interpretation) is now an ordinary member of the enforced set.
//
// Contract pinned here:
//   - a bare-core Artifact carrying `validation_criteria: []` must NOT seal
//   - a bare-core Verdict carrying `checks: []` must NOT seal
//   - a bare-core Verdict whose checks omit `method` must NOT seal
//   - the real, shipped `synthesis-walk-v0` standard must not run to `complete` while
//     sealing `{}` under its bare-core `Artifact` output_contract
//   - POSITIVE CONTROLS: a well-formed bare-core output still seals (blocks the hollow
//     "just make bare core always throw" fix)
//
// Verified independently against main @ 929f81c: 4 of 28 top-level agents declare a bare
// core type in `output_types` — delivery-finalizer (Verdict), event-clusterer
// (Interpretation), solution-developer (Artifact), synthesis-writer (Artifact). The
// issue's "4 of 28" is exact.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { CORE_SUBSTANCE } from "../src/output_validation.js";
import {
  createRegistry,
  createOutputStore,
  loadGenome,
  loadRegistry,
  runGig,
  MemoryLedger,
  OutputStoreError,
  type AgentInvoker,
  type DomainType,
  type OutputWrite,
  type Registry,
} from "../src";

// the repo root = this test file's dir (tests/) joined with ".."
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// A minimal Artifact subtype and Verdict subtype. Neither overloads the core's
// `validation_criteria` / `checks` property, so both INHERIT the core constraint —
// which is exactly what makes the differential below meaningful.
const artifactSubtype: DomainType = {
  slug: "sealed-doc",
  extends: "Artifact",
  domain: "sealtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

const verdictSubtype: DomainType = {
  slug: "sealed-ruling",
  extends: "Verdict",
  domain: "sealtests",
  schema: { properties: { note: { type: "string" } } },
  required_fields: ["note"],
};

function subtypeRegistry(): Registry {
  const registry = createRegistry();
  registry.registerType(artifactSubtype);
  registry.registerType(verdictSubtype);
  return registry;
}

function write(o: Partial<OutputWrite> & Pick<OutputWrite, "core_type" | "domain_type" | "data">): OutputWrite {
  return {
    domain: "sealtests",
    gig_id: "gig-seal-1",
    agent_slug: "synthesis-writer",
    primitive: "CREATE",
    ...o,
  };
}

describe("#227 — a bare core type must not seal an output the same core rejects one level down", () => {
  it("bare-core Artifact with validation_criteria:[] seals today; the identical payload is rejected under a subtype", () => {
    const registry = subtypeRegistry();
    const store = createOutputStore(registry);
    const payload = { validation_criteria: [] };

    // PRECONDITION (green today, and must stay green): under an Artifact SUBTYPE the
    // engine inherits `validation_criteria: { minItems: 1 }` from core_types/artifact.json
    // and rejects this exact payload.
    const asSubtype = registry.validate({
      core_type: "Artifact",
      domain_type: "sealed-doc",
      data: { title: "t", ...payload },
    });
    expect(asSubtype.valid).toBe(false);
    expect(asSubtype.errors.join(" ")).toMatch(/validation_criteria/);

    // RED: the SAME empty validation_criteria under the BARE core seals unchallenged —
    // registry.validate returns {valid:true} before it ever looks at the data.
    //
    // Asserted at the STORE boundary, not at registry.validate, on purpose: #227 could be
    // closed by removing the short-circuit OR by wiring the core-invariant check into
    // outputs.write (#228). Both satisfy this test; neither is presumed.
    expect(() =>
      store.write(write({ core_type: "Artifact", domain_type: "Artifact", data: payload })),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("bare-core Verdict with checks:[] seals today; the identical payload is rejected under a subtype", () => {
    const registry = subtypeRegistry();
    const store = createOutputStore(registry);
    const payload = { pass: true, checks: [] };

    // PRECONDITION (green today): the Verdict subtype inherits `checks: { minItems: 1 }`.
    const asSubtype = registry.validate({
      core_type: "Verdict",
      domain_type: "sealed-ruling",
      data: { note: "n", ...payload },
    });
    expect(asSubtype.valid).toBe(false);
    expect(asSubtype.errors.join(" ")).toMatch(/checks/);

    // RED: bare core accepts it.
    expect(() =>
      store.write(
        write({ core_type: "Verdict", domain_type: "Verdict", primitive: "VERIFY", agent_slug: "delivery-finalizer", data: payload }),
      ),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("bare-core Verdict whose checks omit `method` seals today; the identical payload is rejected under a subtype", () => {
    const registry = subtypeRegistry();
    const store = createOutputStore(registry);
    // core_types/verdict.json declares checks.items.required = ["method"].
    const payload = { pass: true, checks: [{ target_ref: "abc", result: "pass" }] };

    // PRECONDITION (green today): the subtype inherits the per-item `required: ["method"]`.
    const asSubtype = registry.validate({
      core_type: "Verdict",
      domain_type: "sealed-ruling",
      data: { note: "n", ...payload },
    });
    expect(asSubtype.valid).toBe(false);
    expect(asSubtype.errors.join(" ")).toMatch(/method/);

    // RED: bare core accepts a check with no method — an unfalsifiable "verification".
    expect(() =>
      store.write(
        write({ core_type: "Verdict", domain_type: "Verdict", primitive: "VERIFY", agent_slug: "delivery-finalizer", data: payload }),
      ),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });

  it("bare-core Artifact seals a wholly empty {} today — the extractJson-defect payload", () => {
    const registry = subtypeRegistry();
    const store = createOutputStore(registry);

    // This is the exact shape a mis-firing extractJson produces: `{}` parsed out of an
    // illustrative brace in the model's preamble, standing in for the real answer. It
    // seals with a genuine content_sha and genuine provenance edges.
    expect(() =>
      store.write(write({ core_type: "Artifact", domain_type: "Artifact", data: {} })),
    ).toThrow(OutputStoreError);
    expect(store.all()).toHaveLength(0);
  });
});

describe("#227 — the real genome's bare-core agents", () => {
  // Re-derived from the genome rather than copied from the issue: read agents/*.json and
  // pick the ones whose declared output_types contain a bare core slug.
  const genome = loadGenome(REPO_ROOT);
  const CORE = ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"];
  const bareCoreAgents = [...genome.agents.values()]
    .flatMap((a) =>
      a.output_types.filter((t) => CORE.includes(t)).map((core) => ({ slug: a.slug, core })),
    )
    .sort((x, y) => x.slug.localeCompare(y.slug));

  // RULING (#227): "There's no subtype thing. It's all the way top to bottom." ALL SIX
  // cores carry a declared, enforced substance floor — `minItems: 1` / `minLength: 1` in
  // core_types/<core>.json, restated as the CORE_SUBSTANCE table in
  // src/output_validation.ts. The set is derived from that table rather than restated here,
  // so a core that loses its floor cannot quietly drop out of the enforced bucket below.
  const CORE_WITH_DECLARED_FLOOR = Object.keys(CORE_SUBSTANCE);
  const PRIMITIVE_FOR: Record<string, string> = {
    Signal: "SENSE", Interpretation: "INTERPRET", Judgment: "JUDGE",
    Plan: "PLAN", Artifact: "CREATE", Verdict: "VERIFY",
  };
  const withFloor = bareCoreAgents.filter((a) => CORE_WITH_DECLARED_FLOOR.includes(a.core));
  const withoutFloor = bareCoreAgents.filter((a) => !CORE_WITH_DECLARED_FLOOR.includes(a.core));

  it("every core type has a substance floor — no core is exempt (the #227 ruling)", () => {
    expect(
      [...CORE].sort(),
      "a core with no entry in CORE_SUBSTANCE is a core that can seal a shell. The ruling " +
        "is 'all the way top to bottom' — adding a seventh core means deciding what makes " +
        "it substantive, not leaving it floorless.",
    ).toEqual(Object.keys(CORE_SUBSTANCE).sort());
    expect(withoutFloor, "no bare-core agent may bind a floorless core").toEqual([]);
  });

  it("census tripwire: exactly these agents bind a bare core type", () => {
    expect(
      bareCoreAgents,
      "A bare-core output_types binding re-opens #227's short-circuit for a new agent, so " +
        "adding one must be a CONSCIOUS decision, not a drive-by. If this change is " +
        "intended: extend this list, and confirm the new core has a declared substance " +
        "floor (core_types/<core>.json). If it does not, the new agent belongs in the " +
        "PENDING-RULING bucket below, not in the enforced set.",
    ).toEqual([
      { slug: "delivery-finalizer", core: "Verdict" },
      { slug: "event-clusterer", core: "Interpretation" },
      { slug: "solution-developer", core: "Artifact" },
      { slug: "synthesis-writer", core: "Artifact" },
    ]);
    expect(genome.load_errors).toEqual([]);
  });

  // Reds are DRIVEN BY the derived list above, not by a second hardcoded copy of it.
  for (const { slug, core } of withFloor) {
    it(`${slug} (bare ${core}) seals {} today — must not`, () => {
      const store = createOutputStore(loadRegistry(genome));
      expect(() =>
        store.write({
          core_type: core,
          domain_type: core,
          domain: "introspection",
          gig_id: `gig-${slug}`,
          agent_slug: slug,
          primitive: PRIMITIVE_FOR[core]!,
          data: {},
        }),
      ).toThrow(OutputStoreError);
      expect(store.all()).toHaveLength(0);
    });

    // The key-ABSENT case, distinct from `{}` and from `[]`. Under the #228 path-(b)
    // ruling an Artifact with no validation_criteria key at all is invalid, and a
    // bare-core output has no subtype to defer that to. This is exactly the seam where
    // #227 and #228 compose: a payload that looks plausible, carries real content, and
    // still cannot be verified by anyone downstream.
    it(`${slug} (bare ${core}) seals a plausible payload missing its substance key — must not`, () => {
      const store = createOutputStore(loadRegistry(genome));
      expect(() =>
        store.write({
          core_type: core,
          domain_type: core,
          domain: "introspection",
          gig_id: `gig-${slug}-absent`,
          agent_slug: slug,
          primitive: PRIMITIVE_FOR[core]!,
          data: { content: "a plausible-looking result with nothing to check it against" },
        }),
      ).toThrow(OutputStoreError);
      expect(store.all()).toHaveLength(0);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────
  // RULING RECEIVED — this block used to hold a single PENDING test asking whether the
  // four floorless cores (Signal, Interpretation, Plan, Judgment) have any substance floor
  // at all, with event-clusterer's bare `Interpretation` as the live case.
  //
  // The maintainer answered: "There's no subtype thing. It's all the way top to bottom."
  // An empty Interpretation is not an interpretation, exactly as an empty Artifact is not
  // an artifact. The question is settled, so the case is no longer asked as a question —
  // event-clusterer now flows through the `withFloor` loop above with every other bare-core
  // agent, and gets the STRONGER pair of requirements (empty `{}` AND a plausible payload
  // missing its substance key), not the single one it carried as a PENDING probe.
  //
  // The two contested points in the old note, and how the ruling resolved them:
  //   - "registry.ts documents base fields as available, not forced" — that stance was
  //     overturned by this same ruling; see the replacement comment at its old site.
  //   - "would immediately reject every existing Interpretation instance in the repo" —
  //     true, and accepted. Those instances were never valid instances of their own core;
  //     the seal path simply never looked. The floor is now declared in
  //     core_types/interpretation.json and carried by every Interpretation subtype.
  //
  // `withoutFloor` is kept, and asserted EMPTY in the ruling test above, so a future core
  // added without a floor fails loudly instead of silently re-opening this question.
  // ───────────────────────────────────────────────────────────────────────────────────
});

describe("#227 — end-to-end: a shipped standard completes over sealed garbage", () => {
  it("synthesis-walk-v0 runs to `complete` while sealing {} under its bare-core Artifact contract", async () => {
    const genome = loadGenome(REPO_ROOT);
    const standard = genome.standards.get("synthesis-walk-v0");
    // PRECONDITION: this is a real, shipped standard with a `synthesize` chair that seals
    // an Artifact-cored output.
    //
    // Deliberately NOT pinned to output_contract === ["Artifact"]. Retyping
    // synthesis-writer onto a real Artifact subtype is a legitimate genome-side
    // remediation for #227 — and with genome amendment explicitly in scope for the
    // path-(b) fix, a likely one. Pinning the binding would forbid it and make this test
    // fail for a reason that has nothing to do with the defect. The assertion below is on
    // the OUTCOME (no empty Artifact-cored record ever seals), which holds under either
    // remediation.
    expect(standard).toBeDefined();
    const synthesize = standard!.phases.flatMap((p) => p.chairs).find((c) => c.role === "synthesize");
    expect(synthesize).toBeDefined();
    expect(synthesize!.output_contract.length).toBeGreaterThan(0);

    const outputs = createOutputStore(loadRegistry(genome));
    const ledger = new MemoryLedger();

    // Simulate the extractJson defect precisely: the discover chair's answer survives,
    // but the two bare-core chairs get `{}` back instead of the model's real output.
    const invoke: AgentInvoker = (ctx) =>
      ctx.agent.slug === "source-walker"
        ? { repo_path: "/repo", repo_name: "repo", survey_completeness: "complete" }
        : {};

    // The gig may legitimately ABORT once the seal holds, so the run is wrapped: this test
    // does not presume the fix aborts the gig vs. rejects only the chair. The contract
    // asserted is narrower and implementation-agnostic — an empty bare-core Artifact must
    // never end up in the ledger.
    let status: string;
    try {
      status = (await runGig(standard!, { text: "synthesize last 24h" }, { outputs, ledger, invoke })).status;
    } catch (e) {
      status = `aborted: ${(e as Error).message}`;
    }

    // Scoped by CORE_TYPE, not domain_type, so the assertion survives the genome-side
    // remediation of retyping synthesis-writer onto an Artifact subtype — the record would
    // still be Artifact-cored and still must not be empty.
    //
    // Scoped to Artifact only: the `cluster` chair seals a bare `Interpretation`, which is
    // the still-PENDING case above. A correct path-(b) fix reaches Artifact and Verdict
    // only and would still leave that record, and this test must not fail for that reason.
    const emptyArtifacts = outputs
      .all()
      .filter((o) => o.core_type === "Artifact" && Object.keys(o.data).length === 0);

    // RED: today `status === "complete"` and this array holds one record with a real
    // content_sha and real provenance. output_trace reports an intact chain over nothing.
    expect(emptyArtifacts.map((o) => `${o.agent_slug}/${o.phase}`)).toEqual([]);
    expect(status === "complete" && emptyArtifacts.length > 0).toBe(false);
  });
});

describe("#227 — positive controls (must stay green after the fix)", () => {
  it("a bare-core Artifact carrying a non-empty validation_criteria[] still seals", () => {
    const store = createOutputStore(subtypeRegistry());
    const rec = store.write(
      write({
        core_type: "Artifact",
        domain_type: "Artifact",
        data: { content: "the synthesis", validation_criteria: ["cites every source event"] },
      }),
    );
    expect(rec.id).toBeTruthy();
    expect(rec.content_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a bare-core Verdict carrying a non-empty checks[] with methods still seals", () => {
    const store = createOutputStore(subtypeRegistry());
    const rec = store.write(
      write({
        core_type: "Verdict",
        domain_type: "Verdict",
        primitive: "VERIFY",
        agent_slug: "delivery-finalizer",
        data: { pass: true, checks: [{ method: "manual-review", target_ref: "abc", result: "pass" }] },
      }),
    );
    expect(rec.id).toBeTruthy();
  });

  it("a well-formed domain-subtype output still seals (no collateral tightening)", () => {
    const store = createOutputStore(subtypeRegistry());
    // `validation_criteria` is REQUIRED here, not decoration: under the #228 path-(b)
    // ruling an Artifact with the key absent is invalid, subtype or not. A payload of
    // just `{ title: "t" }` would (correctly) fail a compliant implementation, which
    // would make this "positive control" a false alarm rather than a guard.
    const rec = store.write(
      write({
        core_type: "Artifact",
        domain_type: "sealed-doc",
        data: { title: "t", validation_criteria: ["reviewed before seal"] },
      }),
    );
    expect(rec.domain_type).toBe("sealed-doc");
  });
});
