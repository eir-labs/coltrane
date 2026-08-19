import { describe, it, expect } from "vitest";
import { RESOLVE_WEIGHTS, createRegistry } from "../src";

const finding = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: {
    type: "object",
    properties: {
      pattern_key: { type: "string" },
      severity: { type: "string" },
      title: { type: "string" },
    },
  },
  required_fields: ["pattern_key", "severity", "title"],
};

describe("resolution weights", () => {
  it("sum to one", () => {
    const sum = Object.values(RESOLVE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("match the specified profile", () => {
    expect(RESOLVE_WEIGHTS).toEqual({
      field_coverage: 0.4,
      usage_gravity: 0.15,
      downstream_satisfaction: 0.2,
      domain_affinity: 0.15,
      recency: 0.1,
    });
  });
});

describe("resolve action by score", () => {
  it("uses an existing type at score at least 80", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const r = registry.resolveType({
      extends: "Interpretation",
      domain: "eirtests",
      required_fields: ["pattern_key", "severity", "title"],
    });
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.action).toBe("use");
  });

  it("creates a new type at score below 50", () => {
    const registry = createRegistry();
    const r = registry.resolveType({
      extends: "Verdict",
      domain: "brand-new",
      required_fields: ["a", "b", "c"],
    });
    expect(r.score).toBeLessThan(50);
    expect(r.action).toBe("create");
  });

  it("rejects registration when an existing type already scores at least 80", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    expect(() => registry.registerType({ ...finding, slug: "finding-2" })).toThrow();
  });
});

// RED-SPEC (gig 2b3af80b, draft-laws) — reuse enforcement must distinguish
// "another version of THIS type" (same slug) from "a duplicate of this type"
// (different slug). Today score() carries no slug and registerType scores a
// type's own next version against its stored prior version, so the prior wins
// at >=80 and the next version is refused as a self-duplicate (PR #432 had to
// route around this via replaceTypes). These laws pin the restored distinction.
describe("reuse enforcement — identity of the match (own version vs duplicate)", () => {
  // A genuine NEXT VERSION of `finding`: same slug, same extends/domain, a
  // proper SUPERSET of required_fields (adds `evidence`, declared so the
  // undeclared-required guard in domainTypeDefect does not fire first).
  const nextVersion = {
    ...finding,
    schema: {
      type: "object",
      properties: {
        pattern_key: { type: "string" },
        severity: { type: "string" },
        title: { type: "string" },
        evidence: { type: "string" },
      },
    },
    required_fields: ["pattern_key", "severity", "title", "evidence"],
  };

  // Calibration pin (GREEN today, GREEN after): proves the chosen fixture
  // genuinely trips the >=80 gate against its own prior version, so INV-1's
  // pre-fix failure is a real reuse-enforcement refusal and not a fixture that
  // trivially scores <80. resolveType passes no exclusion, so this is exactly
  // the score registerType sees today. Superset direction: field_coverage of
  // the smaller stored candidate against the larger query = 3/4 = 0.75, so
  // score = 100*(0.4*0.75 + 0.15 + 0.2 + 0.15 + 0.1) = 90 (>=80).
  it("calibration: a same-slug next version scores >= 80 against its own prior version, so it trips the reuse gate", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const r = registry.resolveType({
      extends: nextVersion.extends,
      domain: nextVersion.domain,
      required_fields: nextVersion.required_fields,
    });
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  // INV-1 (RED today by design): the enforcement that distinguishes self from
  // duplicate does not exist yet, so registerType of a same-slug next version
  // throws "reuse enforcement: an existing type scores 90 (>=80)". This is the
  // pre-fix failure the change must eliminate.
  it("INV-1: accepts a same-slug next version (superset required_fields) instead of refusing it as a self-duplicate", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    expect(() => registry.registerType(nextVersion)).not.toThrow();
  });

  // INV-2 (must-not-weaken; GREEN before AND after): a genuinely similar but
  // DIFFERENTLY NAMED new type must still be refused at >=80. This is what
  // reuse enforcement is FOR; the fix must not weaken it. Pins the specific
  // reuse-enforcement error, stronger than the sibling law above which only
  // asserts a bare throw. Would go RED if the fix excluded by existence rather
  // than by the registrar's own slug.
  it("INV-2: still refuses a genuinely similar type under a DIFFERENT slug at >= 80", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    expect(() => registry.registerType({ ...finding, slug: "finding-2" })).toThrow(
      /reuse enforcement: an existing type scores \d+ \(>=80\)/,
    );
  });

  // INV-3 (resolveType unchanged; GREEN before AND after): resolveType answers
  // "what should I reuse?", where a same-slug match is a meaningful reuse
  // target and must NOT be silently dropped. Pins that the same-slug candidate
  // is still surfaced (present in candidates, action "use" at >=80). Would go
  // RED if the fix pushed slug-exclusion into the shared score() path instead
  // of scoping it to registerType's call site.
  it("INV-3: resolveType still surfaces the same-slug candidate rather than silently dropping it", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const r = registry.resolveType({
      extends: finding.extends,
      domain: finding.domain,
      required_fields: finding.required_fields,
    });
    expect(r.candidates.some((c) => c.slug === "finding")).toBe(true);
    expect(r.action).toBe("use");
    expect(r.score).toBeGreaterThanOrEqual(80);
  });
});
