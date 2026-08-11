// RED-first — institutional laws as invocable ADICO contracts, not prose.
//
// Written against a genome_schema.ts whose InstitutionalLawSchema and NormPairSchema do not yet
// exist: the imports resolve to undefined and every assertion errors. The schema makes it green;
// nothing else may. This is the visible RED commit, landed before the schema change.
import { describe, it, expect } from "vitest";
import { InstitutionalLawSchema, NormPairSchema, InstitutionSchema } from "../src/genome_schema.js";

const A_LAW = {
  attributes: "any agent seated in an institutional chair",
  deontic: "forbidden",
  aim: "exercise a capability the seated chair grants do not contain",
  conditions: "while acting under an institutional seating",
  or_else: "the action is refused at dispatch, and the authority lapses the moment the agent is unseated",
  check: {
    predicate: "(subseteq exercised_caps chair_caps)",
    inputs: { exercised_caps: "CapGrant[]", chair_caps: "CapGrant[]" },
  },
  content_hash: "sha256:0d27ad56db185576590af99cd368e5826b7bc1589cf23b95bbbb890f8a863253",
};

describe("institutional law — an ADICO contract, not prose", () => {
  it("parses a full ADICO law to the typed shape", () => {
    const law = InstitutionalLawSchema.parse(A_LAW);
    expect(law.attributes).toBe(A_LAW.attributes);
    expect(law.deontic).toBe("forbidden");
    expect(law.aim.length).toBeGreaterThan(0);
    expect(law.conditions.length).toBeGreaterThan(0);
    expect(law.or_else.length).toBeGreaterThan(0);
    expect(law.content_hash.startsWith("sha256:")).toBe(true);
  });

  it("rejects an invalid deontic operator", () => {
    expect(() => InstitutionalLawSchema.parse({ ...A_LAW, deontic: "allowed" })).toThrow();
  });

  it("exposes a check surface shaped for invocation: {predicate, inputs}", () => {
    const law = InstitutionalLawSchema.parse(A_LAW);
    expect(typeof law.check.predicate).toBe("string");
    expect(law.check.inputs).toEqual({ exercised_caps: "CapGrant[]", chair_caps: "CapGrant[]" });
    // strict: an unknown field on the check surface fails to parse
    expect(() =>
      InstitutionalLawSchema.parse({ ...A_LAW, check: { predicate: "(t)", inputs: {}, solver: "z3" } }),
    ).toThrow();
  });

  it("is strict: an unknown top-level field fails to parse", () => {
    expect(() => InstitutionalLawSchema.parse({ ...A_LAW, severity: "high" })).toThrow();
  });
});

describe("chair obligation — a deontic norm pair", () => {
  it("parses {attributes, aim} with deontic defaulting to 'obliged'", () => {
    const norm = NormPairSchema.parse({
      attributes: "the field-reader",
      aim: "state the boundary of the read in the output",
    });
    expect(norm.deontic).toBe("obliged");
    expect(norm.aim.length).toBeGreaterThan(0);
  });

  it("accepts an explicit deontic operator and rejects an invalid one", () => {
    expect(NormPairSchema.parse({ attributes: "x", aim: "y", deontic: "forbidden" }).deontic).toBe("forbidden");
    expect(() => NormPairSchema.parse({ attributes: "x", aim: "y", deontic: "allowed" })).toThrow();
  });
});

describe("InstitutionSchema.laws no longer accepts prose", () => {
  it("rejects a bare string in laws — a law is a contract, not a sentence", () => {
    expect(() =>
      InstitutionSchema.parse({ slug: "x", name: "X", kind: "institution", laws: ["prose law"] }),
    ).toThrow();
  });

  it("accepts an array of ADICO law records", () => {
    const inst = InstitutionSchema.parse({ slug: "x", name: "X", kind: "institution", laws: [A_LAW] });
    expect(inst.laws).toHaveLength(1);
    expect(inst.laws[0]!.deontic).toBe("forbidden");
  });
});
