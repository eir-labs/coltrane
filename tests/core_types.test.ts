import { describe, it, expect } from "vitest";
import { CORE_TYPES, REFERENCE_TYPES, PRIMITIVE_OUTPUT_TYPE } from "../src";

describe("core types", () => {
  it("has exactly 6", () => {
    expect(CORE_TYPES).toHaveLength(6);
  });

  it("contains Signal, Interpretation, Judgment, Plan, Artifact, Verdict", () => {
    expect(new Set(CORE_TYPES)).toEqual(
      new Set([
        "Signal",
        "Interpretation",
        "Judgment",
        "Plan",
        "Artifact",
        "Verdict",
      ]),
    );
  });
});

describe("reference types", () => {
  it("has exactly 6", () => {
    expect(REFERENCE_TYPES).toHaveLength(6);
  });

  it("contains derived_from, validates, challenges, refines, triggers, contains", () => {
    expect(new Set(REFERENCE_TYPES)).toEqual(
      new Set([
        "derived_from",
        "validates",
        "challenges",
        "refines",
        "triggers",
        "contains",
      ]),
    );
  });
});

describe("primitive → core type 1:1 mapping", () => {
  it.each([
    ["SENSE", "Signal"],
    ["INTERPRET", "Interpretation"],
    ["JUDGE", "Judgment"],
    ["PLAN", "Plan"],
    ["CREATE", "Artifact"],
    ["VERIFY", "Verdict"],
  ] as const)("%s outputs %s", (primitive, coreType) => {
    expect(PRIMITIVE_OUTPUT_TYPE[primitive]).toBe(coreType);
  });
});
