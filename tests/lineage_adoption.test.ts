// The WRITE half of institutional lineage: does a sealed verdict ground an institution?
//
// This function is the ONLY thing permitted to set `approved_by` non-null, and
// `agentLineageGrounding` inherits a ref onto a seated agent only when that field is non-null.
// The two halves of the mechanism meet on exactly one field, so every refusal below is load-
// bearing: each one is a path by which an unapproved lineage could otherwise become grounding.

import { describe, it, expect } from "vitest";
import { lineageAdoption } from "../src/lineage_adoption.js";

const REF = "sha-lineage-record";

describe("lineageAdoption", () => {
  it("adopts a passing, signed verdict and sets approved_by from the approver", () => {
    const r = lineageAdoption({
      verdict: { pass: true, approver: "eugene", rationale: "grounded on both sides" },
      record_ref: REF, question: "where does the board come from?", sealed_at: "2026-08-20T00:00:00.000Z",
    });
    expect(r.adopt).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.ref).toMatchObject({ record_ref: REF, approved_by: "eugene", sealed_at: "2026-08-20T00:00:00.000Z" });
  });

  it("refuses a failing verdict", () => {
    const r = lineageAdoption({ verdict: { pass: false, approver: "eugene" }, record_ref: REF });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["not-a-pass"]);
  });

  it("refuses an ABSENT pass — a parked run is not a yes", () => {
    const r = lineageAdoption({ verdict: { approver: "eugene" }, record_ref: REF });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["not-a-pass"]);
  });

  it("refuses a truthy non-boolean pass — no rounding toward consent", () => {
    for (const p of ["true", 1, {}, []]) {
      const r = lineageAdoption({ verdict: { pass: p, approver: "eugene" }, record_ref: REF });
      expect(r.adopt, `pass=${JSON.stringify(p)}`).toBe(false);
    }
  });

  it("refuses an unsigned pass — an unattributed approval is not an approval", () => {
    for (const a of [undefined, "", "   ", 42, null]) {
      const r = lineageAdoption({ verdict: { pass: true, approver: a }, record_ref: REF });
      expect(r.adopt, `approver=${JSON.stringify(a)}`).toBe(false);
      expect(r.refusals.map((x) => x.reason)).toContain("no-approver");
    }
  });

  it("refuses a reference that names no record", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "eugene" }, record_ref: "   " });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["no-record-ref"]);
  });

  it("collects EVERY applicable refusal rather than short-circuiting", () => {
    const r = lineageAdoption({ verdict: { pass: false }, record_ref: "" });
    expect(r.refusals.map((x) => x.reason).sort()).toEqual(["no-approver", "no-record-ref", "not-a-pass"]);
  });

  it("throws nothing on a null or garbage verdict", () => {
    expect(() => lineageAdoption({ verdict: null, record_ref: REF })).not.toThrow();
    expect(lineageAdoption({ verdict: undefined, record_ref: REF }).adopt).toBe(false);
  });

  it("omits optional fields rather than writing undefined into them", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "tasha" }, record_ref: REF });
    expect(Object.keys(r.ref!).sort()).toEqual(["approved_by", "record_ref"]);
  });
});
