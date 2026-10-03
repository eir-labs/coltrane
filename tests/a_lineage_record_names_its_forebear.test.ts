// A lineage-record names its forebear (v3) — so a store can land the forebear from the record.
//
// MEASURED (3 Oct 2026, by the non-author grade of a store door): the sealed v2 record carries
// external_body items of exactly {source, status, note} (closed), so a store that tried to land a
// forebear row from the record read fields that can never be present and landed a phantom
// ("fb.unnamed") silently. The naming standard's own intent says the scribe cites "the dated forebear
// BY CONTENT ADDRESS" — the record is where the forebear belongs. v3 adds a closed, optional
// `forebear` object; everything v2 required stays required and everything v2 forbade stays forbidden.
import { describe, it, expect } from "vitest";
import { loadGenome, loadRegistry } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = loadRegistry(loadGenome(REPO_ROOT));

const BASE = {
  external_body: [{ source: "https://example.invalid/edda/gylf-35", status: "reached", note: "read" }],
  internal_inventory: [{ reference: "docs/x.md", kind: "doc", summary: "s" }],
  connections: [{ internal_ref: "docs/x.md", external_ref: "https://example.invalid/edda/gylf-35", relation: "descends-from", grounding_internal: "the inventory entry", grounding_external: "Gylf. 35", strength: "dereferenceable-both-sides" }],
  gap: "none",
  alignment_recommendation: "adopt",
  validation_criteria: ["grounded"],
};
const seal = (data: Record<string, unknown>) =>
  registry.validate({ domain_type: "lineage-record", core_type: "Artifact", data } as never);
const FOREBEAR = { slug: "fb.test-forebear", name: "Test Forebear", kind: "figure", domain: "testing", what_taken: "the disposition of being tested", evidence_grade: "archive" };

describe("lineage-record v3 — the record names its forebear", () => {
  it("L1 · the type is version 3 on disk", () => {
    expect(loadGenome(REPO_ROOT).domain_types.get("lineage-record")?.version).toBe(3);
  });
  it("L2 · a record with a forebear object seals", () => {
    const r = seal({ ...BASE, forebear: FOREBEAR });
    expect(r.valid, r.errors.join("; ")).toBe(true);
  });
  it("L3 · a record without one still seals — a pass that grounds an institution carries none", () => {
    expect(seal(BASE).valid).toBe(true);
  });
  it("L4 · the forebear is closed: an unknown field inside it is refused", () => {
    expect(seal({ ...BASE, forebear: { ...FOREBEAR, figure: "smuggled" } }).valid).toBe(false);
  });
  it("L5 · slug, name and what_taken are required; evidence_grade is the closed vocabulary", () => {
    expect(seal({ ...BASE, forebear: { slug: "fb.x", name: "X" } }).valid).toBe(false);
    expect(seal({ ...BASE, forebear: { ...FOREBEAR, evidence_grade: "hearsay" } }).valid).toBe(false);
  });
  it("L6 · v2's closures hold: an external_body item with an extra field is still refused", () => {
    expect(seal({ ...BASE, external_body: [{ source: "s", status: "reached", name: "no" }] }).valid).toBe(false);
  });
});
