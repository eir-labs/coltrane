// Producer/enforcer contract unification — the defect class behind three live chair
// failures on 2026-08-08 (gigs 724d502c and d4965ebc, domain "lineage").
//
// THE DEFECT. A domain type's sealing contract is compiled at the seal boundary as
//   { properties: coreProps ∪ ownProps, required: schema.required ∪ required_fields }
// (registry.ts validate(), #227/#229) — but the chair prompt renders the RAW authored
// `dt.schema` (claude_invoker.ts schemaOf). A field required only via `required_fields`
// (or inherited as a core floor: Signal.source, Interpretation.claims, Judgment.criteria)
// is therefore INVISIBLE to the producer and enforced against it anyway. The producer
// emits a maximally-schema-valid object; the seal rejects it; the chair fails closed.
// Three consecutive live failures reproduced this exact gap before it was pinned.
//
// THE RULE THIS FILE FREEZES: the schema shown to a producer and the schema enforced at
// the seal are THE SAME OBJECT — `Registry.effectiveSchema(slug)` — and a type whose
// required fields name properties declared NOWHERE (neither own nor core-inherited) is
// refused at authoring time, not discovered at a terminal chair.
import { describe, it, expect } from "vitest";
import { createRegistry, domainTypeDefect, type DomainType } from "../src/registry.js";
import { promptSchemaFor } from "../src/claude_invoker.js";

// The live reproduction: lineage-map v1 exactly as authored on 2026-08-08 — `claims`
// (Interpretation core floor) listed in required_fields, absent from properties.
const lineageMapV1: DomainType = {
  slug: "lineage-map",
  extends: "Interpretation",
  domain: "lineage",
  schema: {
    properties: {
      assertion_id: { type: "string" },
      covered: { type: "string" },
      residue: { type: "string" },
    },
  },
  required_fields: ["assertion_id", "covered", "residue", "claims"],
};

describe("effectiveSchema — one contract for producer and seal", () => {
  it("exists on the registry and unions required_fields into `required`", () => {
    const reg = createRegistry([lineageMapV1]);
    const eff = reg.effectiveSchema("lineage-map");
    expect(eff).toBeDefined();
    expect(eff!["required"]).toContain("claims");
    expect(eff!["required"]).toContain("assertion_id");
  });

  it("merges core-inherited properties so every required field is a declared field", () => {
    const reg = createRegistry([lineageMapV1]);
    const eff = reg.effectiveSchema("lineage-map")!;
    const props = eff["properties"] as Record<string, unknown>;
    // `claims` is required; it must also be VISIBLE as a property (inherited from
    // Interpretation's core schema) — required-but-undeclared is the whole defect.
    expect(props["claims"]).toBeDefined();
    expect(props["assertion_id"]).toBeDefined();
  });

  it("agrees with validate(): a payload satisfying effectiveSchema seals, one missing a required_fields-only field does not", () => {
    const reg = createRegistry([lineageMapV1]);
    const missingClaims = {
      core_type: "Interpretation",
      domain_type: "lineage-map",
      data: { assertion_id: "L1", covered: "x", residue: "y" },
    };
    expect(reg.validate(missingClaims).valid).toBe(false);
    const withClaims = {
      core_type: "Interpretation",
      domain_type: "lineage-map",
      data: { assertion_id: "L1", covered: "x", residue: "y", claims: ["c1"] },
    };
    expect(reg.validate(withClaims).valid).toBe(true);
  });

  it("returns undefined for unknown slugs and bare core types (freeform outputs keep their stance)", () => {
    const reg = createRegistry([lineageMapV1]);
    expect(reg.effectiveSchema("no-such-type")).toBeUndefined();
    expect(reg.effectiveSchema("Interpretation")).toBeUndefined();
  });
});

describe("promptSchemaFor — the producer is shown the effective contract", () => {
  it("renders the same required set the seal will enforce", () => {
    const reg = createRegistry([lineageMapV1]);
    const shown = promptSchemaFor(reg, "lineage-map");
    expect(shown).toBeDefined();
    expect(shown!["required"]).toContain("claims");
  });

  it("is undefined when there is no registry or no such type (schema hint simply omitted)", () => {
    const reg = createRegistry([]);
    expect(promptSchemaFor(reg, "lineage-map")).toBeUndefined();
    expect(promptSchemaFor(undefined, "lineage-map")).toBeUndefined();
  });
});

describe("authoring-time refusal — required fields must be declared somewhere", () => {
  it("refuses a required field declared in neither own properties nor the core schema", () => {
    const defect = domainTypeDefect({
      slug: "typo-type",
      extends: "Signal",
      schema: { properties: { text: { type: "string" } } },
      required_fields: ["text", "sourc"], // typo: neither an own prop nor a Signal core prop
    });
    expect(defect).toMatch(/sourc/);
  });

  it("accepts required fields inherited from the core (Signal.source, Interpretation.claims)", () => {
    expect(
      domainTypeDefect({
        slug: "ok-signal",
        extends: "Signal",
        schema: { properties: { text: { type: "string" } } },
        required_fields: ["text", "source"],
      }),
    ).toBeNull();
    expect(
      domainTypeDefect({
        slug: "ok-interp",
        extends: "Interpretation",
        schema: { properties: { gist: { type: "string" } } },
        required_fields: ["gist", "claims"],
      }),
    ).toBeNull();
  });

  it("honors schema.required the same way (#229 union: both declaration styles are one contract)", () => {
    const defect = domainTypeDefect({
      slug: "typo-in-schema-required",
      extends: "Signal",
      schema: { properties: { text: { type: "string" } }, required: ["text", "claimz"] },
      required_fields: [],
    });
    expect(defect).toMatch(/claimz/);
  });

  it("registerType enforces the refusal (both doors guarded)", () => {
    const reg = createRegistry([]);
    expect(() =>
      reg.registerType({
        slug: "typo-type",
        extends: "Signal",
        domain: "demo",
        schema: { properties: { text: { type: "string" } } },
        required_fields: ["sourc"],
      }),
    ).toThrow(/sourc/);
  });
});
