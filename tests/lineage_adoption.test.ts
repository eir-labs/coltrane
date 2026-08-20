// The WRITE half of institutional lineage: does a sealed verdict ground an institution?
//
// This function is the ONLY thing permitted to set `approved_by` non-null, and
// `agentLineageGrounding` inherits a ref onto a seated agent only when that field is non-null.
// The two halves of the mechanism meet on exactly one field, so every refusal below is load-
// bearing: each one is a path by which an unapproved lineage could otherwise become grounding.

import { describe, it, expect } from "vitest";
import { lineageAdoption, applyLineageAdoption } from "../src/lineage_adoption.js";

const REF = "sha-lineage-record";
const INST = "studio";   // every adoption must name the institution it grounds

describe("lineageAdoption", () => {
  it("adopts a passing, signed verdict and sets approved_by from the approver", () => {
    const r = lineageAdoption({
      verdict: { pass: true, approver: "eugene", rationale: "grounded on both sides" },
      record_ref: REF, institution_slug: INST, question: "where does the board come from?", sealed_at: "2026-08-20T00:00:00.000Z",
    });
    expect(r.adopt).toBe(true);
    expect(r.refusals).toEqual([]);
    expect(r.ref).toMatchObject({ record_ref: REF, approved_by: "eugene", sealed_at: "2026-08-20T00:00:00.000Z" });
  });

  it("refuses a failing verdict", () => {
    const r = lineageAdoption({ verdict: { pass: false, approver: "eugene" }, record_ref: REF, institution_slug: INST });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["not-a-pass"]);
  });

  it("refuses an ABSENT pass — a parked run is not a yes", () => {
    const r = lineageAdoption({ verdict: { approver: "eugene" }, record_ref: REF, institution_slug: INST });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["not-a-pass"]);
  });

  it("refuses a truthy non-boolean pass — no rounding toward consent", () => {
    for (const p of ["true", 1, {}, []]) {
      const r = lineageAdoption({ verdict: { pass: p, approver: "eugene" }, record_ref: REF, institution_slug: INST });
      expect(r.adopt, `pass=${JSON.stringify(p)}`).toBe(false);
    }
  });

  it("refuses an unsigned pass — an unattributed approval is not an approval", () => {
    for (const a of [undefined, "", "   ", 42, null]) {
      const r = lineageAdoption({ verdict: { pass: true, approver: a }, record_ref: REF, institution_slug: INST });
      expect(r.adopt, `approver=${JSON.stringify(a)}`).toBe(false);
      expect(r.refusals.map((x) => x.reason)).toContain("no-approver");
    }
  });

  it("refuses a reference that names no record", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "eugene" }, record_ref: "   ", institution_slug: INST });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["no-record-ref"]);
  });

  it("collects EVERY applicable refusal rather than short-circuiting", () => {
    const r = lineageAdoption({ verdict: { pass: false }, record_ref: "" });
    expect(r.refusals.map((x) => x.reason).sort()).toEqual(["no-approver", "no-record-ref", "no-target", "not-a-pass"]);
  });

  it("throws nothing on a null or garbage verdict", () => {
    expect(() => lineageAdoption({ verdict: null, record_ref: REF, institution_slug: INST })).not.toThrow();
    expect(lineageAdoption({ verdict: undefined, record_ref: REF, institution_slug: INST }).adopt).toBe(false);
  });

  it("refuses an adoption that names no institution — it would ground nothing", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "eugene" }, record_ref: REF });
    expect(r.adopt).toBe(false);
    expect(r.refusals.map((x) => x.reason)).toEqual(["no-target"]);
  });

  it("returns the institution the caller must write into", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "eugene" }, record_ref: REF, institution_slug: "  studio  " });
    expect(r.institution_slug).toBe("studio");
  });

  it("omits optional fields rather than writing undefined into them", () => {
    const r = lineageAdoption({ verdict: { pass: true, approver: "tasha" }, record_ref: REF, institution_slug: INST });
    expect(Object.keys(r.ref!).sort()).toEqual(["approved_by", "record_ref"]);
    expect(r.institution_slug).toBe(INST);
  });
});

describe("applyLineageAdoption — the middle of the chain", () => {
  const ref = (record_ref: string, approved_by = "eugene") => ({ record_ref, approved_by, sealed_at: "2026-08-20T00:00:00.000Z" });

  it("appends the reference and reports that it changed", () => {
    const { institution, changed } = applyLineageAdoption({ slug: "studio", lineage: [] }, ref("sha-a") as never);
    expect(changed).toBe(true);
    expect(institution.lineage).toHaveLength(1);
  });

  it("treats an absent lineage[] as empty rather than throwing", () => {
    const { institution, changed } = applyLineageAdoption({ slug: "studio" } as never, ref("sha-a") as never);
    expect(changed).toBe(true);
    expect((institution as { lineage?: unknown[] }).lineage).toHaveLength(1);
  });

  it("is IDEMPOTENT by record_ref — re-approving the same record appends nothing", () => {
    const first = applyLineageAdoption({ slug: "studio", lineage: [] }, ref("sha-a") as never);
    const second = applyLineageAdoption(first.institution, ref("sha-a") as never);
    expect(second.changed).toBe(false);
    expect(second.institution.lineage).toHaveLength(1);
  });

  it("does NOT overwrite the first seal on re-adoption — the first seal is the one that happened", () => {
    const doc: { slug: string; lineage: { record_ref: string; approved_by: string | null }[] } = { slug: "studio", lineage: [] };
    const first = applyLineageAdoption(doc as never, ref("sha-a", "tasha") as never);
    const second = applyLineageAdoption(first.institution, ref("sha-a", "someone-else") as never);
    const got = (second.institution as unknown as typeof doc).lineage[0];
    expect(got!.approved_by).toBe("tasha");
  });

  it("does not mutate the input document", () => {
    const before = { slug: "studio", lineage: [] as unknown[] };
    applyLineageAdoption(before as never, ref("sha-a") as never);
    expect(before.lineage).toHaveLength(0);
  });

  it("appends in stable order so a rendered grounding does not reshuffle", () => {
    let doc = { slug: "studio", lineage: [] as unknown[] } as never;
    for (const s of ["sha-a", "sha-b", "sha-c"]) doc = applyLineageAdoption(doc, ref(s) as never).institution;
    expect((doc as { lineage: { record_ref: string }[] }).lineage.map((r) => r.record_ref)).toEqual(["sha-a", "sha-b", "sha-c"]);
  });
});
