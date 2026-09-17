// RED — an amend round spends a seat only where the verdict's fix can land.
//
// contract-amend-nearest-makers-v1. Today's EXAMINE⇄AMEND block (src/runtime.ts ~2306) selects
// the makers to re-invoke as EVERY chair in the verify seat's depends_on that produces an Artifact:
//
//     const makers = vch.depends_on
//       .map((role) => allChairs.find((c) => c.role === role))
//       .filter((c): c is Chair => !!c && producesArtifact(c));
//
// It never asks whether one of those makers is UPSTREAM of another. So in build-from-red-spec-v0's
// shape — verify depends on attest and build; build depends on attest — an amend round re-invokes
// BOTH attest and build, even though attest's only job was to feed build, whose fix is where the
// verdict lands. Re-running attest re-does settled work AND hands build a freshly-made attestation
// instead of the exact record the failing round judged.
//
// The contract: of today's maker set, an amend round re-invokes ONLY the makers that no OTHER maker
// in the set depends on (directly or through depends_on); an upstream maker's sealed records from
// the failing round remain the amend's inputs, unchanged. These laws FAIL RED on today's engine:
// the selection is not narrowed, so every maker re-runs.
//
// Method: example-based, through runGig's real examine loop with a verifier that fails once, counting
// each chair's invocations (acceptance criterion #2). The graph shapes are hand-enumerated (the space
// is small and closed — chain / fan / independent), so no property-based engine (fast-check) is added;
// F1's "every composed graph shape" clause is covered by iterating that enumerated set. See
// docs/specs/amend-nearest-makers.red-spec.md.
//
// Controls that stay green (named in the acceptance criteria): tests/examine_amend_loop.test.ts,
// tests/spec_amend_round_carries_its_work.test.ts, tests/amend_round_is_not_served_from_cache.test.ts,
// tests/spec_resumed_gig_continues_chair_session.test.ts. No existing law asserts a multi-maker set
// "all re-run" (every examine-loop fixture uses a single maker), so none is rewritten here.
import { describe, it, expect } from "vitest";
import { coreInvariantFields } from "./_support/specs.js";
import { testAgent } from "./_support/agents.js";
import {
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type PhaseDef,
  type Chair,
  type AgentInvoker,
  type AgentInvocationContext,
} from "../src";

// Distinct {domain, required_fields} per type: the registry's reuse scorer keys on
// {extends, domain, required_fields}, so several Artifact subtypes sharing them would score as
// duplicates (>=80) and be refused. A unique required field per Artifact type drops field_coverage
// below the ceiling; each maker emits that field (see `band`).
const mkField = (slug: string) => `${slug}__mk`;
const t = (slug: string, ext: string, distinct = false): DomainType => ({
  slug, extends: ext, domain: `test-${slug}`,
  schema: { properties: { value: { type: "string" }, ...(distinct ? { [mkField(slug)]: { type: "string" } } : {}) } },
  required_fields: distinct ? [mkField(slug)] : [],
});

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts,
});

// Every Artifact subtype and the Plan/Verdict a shape can name, registered once. A shape uses a subset.
function stores() {
  const registry = createRegistry();
  registry.registerType(t("plan-in", "Plan"));
  registry.registerType(t("verdict", "Verdict"));
  for (const a of ["attestation", "build-art", "art-base", "art-mid", "art-top", "art-leafa", "art-leafb"]) {
    registry.registerType(t(a, "Artifact", true));
  }
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

interface Band {
  invoke: AgentInvoker;
  calls: Map<string, number>;
  ctxs: Map<string, AgentInvocationContext[]>;
}

/** A deterministic band: the planner plans once, each maker emits `slug#N` (N varies per call so a
 *  re-made record hashes differently), and the verifier fails its FIRST verdict then passes. */
function band(verifierSlug: string, makerSlugs: readonly string[]): Band {
  const calls = new Map<string, number>();
  const ctxs = new Map<string, AgentInvocationContext[]>();
  const invoke: AgentInvoker = (ctx) => {
    const s = ctx.agent.slug;
    const n = (calls.get(s) ?? 0) + 1;
    calls.set(s, n);
    (ctxs.get(s) ?? ctxs.set(s, []).get(s)!).push(ctx);
    if (s === verifierSlug) return { ...coreInvariantFields("Verdict"), pass: n >= 2, value: `verdict#${n}` };
    if (makerSlugs.includes(s)) {
      const out = ctx.agent.output_types[0]!; // the Artifact subtype this maker seals
      return { ...coreInvariantFields("Artifact"), value: `${s}#${n}`, [mkField(out)]: `${s}#${n}` };
    }
    return { ...coreInvariantFields("Plan"), value: "plan" };
  };
  return { invoke, calls, ctxs };
}

const A = (slug: string, input_types: string[], output: string) =>
  testAgent({ slug, primitives: ["CREATE"], input_types, output_types: [output] });

// ── I2 / O2 shape: build-from-red-spec-v0 — verify ⟵ {attest, build}, build ⟵ attest ────────────
function stdI2() {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const attest = A("attest", ["plan-in"], "attestation");
  const build = A("build", ["plan-in", "attestation"], "build-art");
  const verify = testAgent({ slug: "verify", primitives: ["VERIFY"], input_types: ["attestation", "build-art"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-nearest-i2", domain: "test", agents: [planner, attest, build, verify], max_examine_rounds: 2,
    phases: [
      { name: "plan", chairs: [chair("planner", "planner", { output_contract: ["plan-in"] })] },
      { name: "attest", chairs: [chair("attest", "attest", { depends_on: ["planner"], input_contract: ["plan-in"], output_contract: ["attestation"] })] },
      { name: "build", chairs: [chair("build", "build", { depends_on: ["attest"], input_contract: ["attestation"], output_contract: ["build-art"] })] },
      { name: "check", chairs: [chair("verify", "verify", { depends_on: ["attest", "build"], input_contract: ["attestation", "build-art"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

// ── O1 shape: a transitive chain — verify ⟵ {base, mid, top}, top ⟵ mid ⟵ base ─────────────────
function stdChain() {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const base = A("base", ["plan-in"], "art-base");
  const mid = A("mid", ["art-base"], "art-mid");
  const top = A("top", ["art-mid"], "art-top");
  const verify = testAgent({ slug: "verify", primitives: ["VERIFY"], input_types: ["art-base", "art-mid", "art-top"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-nearest-chain", domain: "test", agents: [planner, base, mid, top, verify], max_examine_rounds: 2,
    phases: [
      { name: "plan", chairs: [chair("planner", "planner", { output_contract: ["plan-in"] })] },
      { name: "base", chairs: [chair("base", "base", { depends_on: ["planner"], input_contract: ["plan-in"], output_contract: ["art-base"] })] },
      { name: "mid", chairs: [chair("mid", "mid", { depends_on: ["base"], input_contract: ["art-base"], output_contract: ["art-mid"] })] },
      { name: "top", chairs: [chair("top", "top", { depends_on: ["mid"], input_contract: ["art-mid"], output_contract: ["art-top"] })] },
      { name: "check", chairs: [chair("verify", "verify", { depends_on: ["base", "mid", "top"], input_contract: ["art-base", "art-mid", "art-top"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

// ── I1 shape: a fan — verify ⟵ {base, leafa, leafb}, leafa ⟵ base, leafb ⟵ base ─────────────────
function stdFan() {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const base = A("base", ["plan-in"], "art-base");
  const leafa = A("leafa", ["art-base"], "art-leafa");
  const leafb = A("leafb", ["art-base"], "art-leafb");
  const verify = testAgent({ slug: "verify", primitives: ["VERIFY"], input_types: ["art-base", "art-leafa", "art-leafb"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-nearest-fan", domain: "test", agents: [planner, base, leafa, leafb, verify], max_examine_rounds: 2,
    phases: [
      { name: "plan", chairs: [chair("planner", "planner", { output_contract: ["plan-in"] })] },
      { name: "base", chairs: [chair("base", "base", { depends_on: ["planner"], input_contract: ["plan-in"], output_contract: ["art-base"] })] },
      { name: "leaves", chairs: [
        chair("leafa", "leafa", { depends_on: ["base"], input_contract: ["art-base"], output_contract: ["art-leafa"] }),
        chair("leafb", "leafb", { depends_on: ["base"], input_contract: ["art-base"], output_contract: ["art-leafb"] }),
      ] },
      { name: "check", chairs: [chair("verify", "verify", { depends_on: ["base", "leafa", "leafb"], input_contract: ["art-base", "art-leafa", "art-leafb"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

// ── independent pair — verify ⟵ {leafa, leafb}, neither depends on the other ────────────────────
function stdIndep() {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const leafa = A("leafa", ["plan-in"], "art-leafa");
  const leafb = A("leafb", ["plan-in"], "art-leafb");
  const verify = testAgent({ slug: "verify", primitives: ["VERIFY"], input_types: ["art-leafa", "art-leafb"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-nearest-indep", domain: "test", agents: [planner, leafa, leafb, verify], max_examine_rounds: 2,
    phases: [
      { name: "plan", chairs: [chair("planner", "planner", { output_contract: ["plan-in"] })] },
      { name: "make", chairs: [
        chair("leafa", "leafa", { depends_on: ["planner"], input_contract: ["plan-in"], output_contract: ["art-leafa"] }),
        chair("leafb", "leafb", { depends_on: ["planner"], input_contract: ["plan-in"], output_contract: ["art-leafb"] }),
      ] },
      { name: "check", chairs: [chair("verify", "verify", { depends_on: ["leafa", "leafb"], input_contract: ["art-leafa", "art-leafb"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

describe("an amend round re-invokes only the makers no other re-run maker depends on", () => {
  it("I2 — build-from-red-spec-v0's shape: an amend round invokes build and not attest", async () => {
    const b = band("verify", ["attest", "build"]);
    const res = await runGig(stdI2(), {}, { ...stores(), invoke: b.invoke });
    expect(
      b.calls.get("attest"),
      "attest is upstream of build (build depends on it): its sealed record from the failing round is the amend's input, so attest must run once across the whole gig — not be re-made",
    ).toBe(1);
    expect(
      b.calls.get("build"),
      "build is the only maker in the set with no dependant in the set — the amend re-runs exactly it",
    ).toBe(2);
    expect(b.calls.get("verify"), "the verifier fails once, so it re-verifies the amended build").toBe(2);
    expect(res.status).toBe("complete");
  });

  it("O1 — a maker upstream of another in the set, even transitively, is not re-invoked", async () => {
    // top ⟵ mid ⟵ base, verify ⟵ {base, mid, top}. Only `top` has no dependant in the set; `mid` is
    // depended on by top, and `base` by mid (and transitively by top). So the amend re-runs top alone.
    const b = band("verify", ["base", "mid", "top"]);
    await runGig(stdChain(), {}, { ...stores(), invoke: b.invoke });
    expect(b.calls.get("base"), "base is depended on (through mid, transitively through top): it is settled, not re-made").toBe(1);
    expect(b.calls.get("mid"), "mid is depended on by top in the set: it is settled, not re-made").toBe(1);
    expect(b.calls.get("top"), "top is the only maker with no dependant in the set — the amend re-runs it").toBe(2);
    expect(b.calls.get("verify")).toBe(2);
  });

  it("O2 — the skipped maker's record is carried into the amend unchanged (same id and content_sha)", async () => {
    const b = band("verify", ["attest", "build"]);
    await runGig(stdI2(), {}, { ...stores(), invoke: b.invoke });
    const buildCtxs = b.ctxs.get("build") ?? [];
    expect(buildCtxs, "the verdict failed once, so build must run twice").toHaveLength(2);
    const attestIn = (ctx: AgentInvocationContext) => ctx.inputs.filter((o) => o.domain_type === "attestation");
    const first = attestIn(buildCtxs[0]!);
    const second = attestIn(buildCtxs[1]!);
    expect(first, "fixture: build consumes exactly one attestation in the failing round").toHaveLength(1);
    expect(second, "fixture: build consumes exactly one attestation in the amend round").toHaveLength(1);
    expect(
      second[0]!.id,
      "the amend re-made attest, so build was fed a NEW attestation record — not the exact record (same id) the failing round sealed",
    ).toBe(first[0]!.id);
    expect(
      second[0]!.content_sha,
      "the amend re-made attest, so the carried attestation hashes differently than the record the failing round sealed — the re-run makers no longer see what they saw before",
    ).toBe(first[0]!.content_sha);
  });

  it("I1 — independent makers both re-run; the shared upstream they consume is not re-made", async () => {
    // leafa and leafb are two independent Artifact makers both depended on by the verifier — neither
    // depends on the other, so both re-run (as today). base is depended on by both, so it is settled.
    const b = band("verify", ["base", "leafa", "leafb"]);
    await runGig(stdFan(), {}, { ...stores(), invoke: b.invoke });
    expect(b.calls.get("leafa"), "leafa has no dependant in the set: an independent maker re-runs, exactly as today").toBe(2);
    expect(b.calls.get("leafb"), "leafb has no dependant in the set: an independent maker re-runs, exactly as today").toBe(2);
    expect(b.calls.get("base"), "base is depended on by both leaves: the makers that re-run are exactly the independent ones, so base is settled — not re-made").toBe(1);
    expect(b.calls.get("verify")).toBe(2);
  });

  it("F1 — the amend selection is never empty and never the whole set: exactly the makers with no dependant re-run, for every composed graph shape", async () => {
    const shapes: Array<{ name: string; std: ReturnType<typeof stdI2>; makers: string[]; sinks: string[] }> = [
      { name: "build-from-red-spec-v0 (verify ⟵ {attest,build}, build ⟵ attest)", std: stdI2(), makers: ["attest", "build"], sinks: ["build"] },
      { name: "transitive chain (top ⟵ mid ⟵ base)", std: stdChain(), makers: ["base", "mid", "top"], sinks: ["top"] },
      { name: "fan (leafa,leafb ⟵ base)", std: stdFan(), makers: ["base", "leafa", "leafb"], sinks: ["leafa", "leafb"] },
      { name: "independent pair", std: stdIndep(), makers: ["leafa", "leafb"], sinks: ["leafa", "leafb"] },
    ];
    for (const { name, std, makers, sinks } of shapes) {
      const b = band("verify", makers);
      await runGig(std, {}, { ...stores(), invoke: b.invoke });
      const reInvoked = makers.filter((m) => (b.calls.get(m) ?? 0) > 1).sort();
      expect(reInvoked.length, `${name}: the amend must never select zero makers — at least the sink makers re-run`).toBeGreaterThan(0);
      expect(reInvoked, `${name}: the selection must be exactly the makers with no dependant in the set — never the whole set`).toEqual([...sinks].sort());
    }
  });
});
