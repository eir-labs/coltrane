import { describe, it, expect } from "vitest";
import { validateOutput } from "../src";

describe("Artifact schema enforcement", () => {
  it("rejects an Artifact missing validation_criteria[]", () => {
    const r = validateOutput({
      core_type: "Artifact",
      domain_type: "test-spec",
      data: { spec_code: "expect(x).toBe(1)" },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/validation_criteria/i);
  });

  it("accepts an Artifact with validation_criteria[] populated", () => {
    const r = validateOutput({
      core_type: "Artifact",
      domain_type: "test-spec",
      data: {
        spec_code: "expect(x).toBe(1)",
        validation_criteria: ["test passes in CI", "selectors verified"],
      },
    });
    expect(r.valid).toBe(true);
  });

  it("rejects an Artifact with validation_criteria as empty array", () => {
    const r = validateOutput({
      core_type: "Artifact",
      domain_type: "test-spec",
      data: { spec_code: "expect(x).toBe(1)", validation_criteria: [] },
    });
    expect(r.valid).toBe(false);
  });
});

describe("Verdict schema enforcement", () => {
  it("rejects a Verdict missing checks[]", () => {
    const r = validateOutput({
      core_type: "Verdict",
      domain_type: "test-result",
      data: { pass: true },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/checks/i);
  });

  it("accepts a Verdict with checks[] populated", () => {
    const r = validateOutput({
      core_type: "Verdict",
      domain_type: "test-result",
      data: {
        pass: true,
        checks: [{ method: "playwright", target_ref: "abc", result: "pass" }],
      },
    });
    expect(r.valid).toBe(true);
  });

  it("requires each check to declare a method field", () => {
    const r = validateOutput({
      core_type: "Verdict",
      domain_type: "test-result",
      data: { pass: true, checks: [{ target_ref: "abc", result: "pass" }] },
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/method/i);
  });
});
