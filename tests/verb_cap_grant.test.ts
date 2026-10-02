// A chair cap may be a store verb grant — the RED laws for VerbCapGrantSchema (#573).
//
// The store has served verb grants on chairs since 20260827300000 ({"grant":"org-lift"},
// {"grant":"force-work-order"}, {"grant":"issue-provisioner-key"} …); the engine's CapGrantSchema
// knew only edge grants and dispatch grants, so a chair carrying a verb grant could not be read as
// genome — and R17 (2 Oct 2026) rules the genome is sealed in the store. These laws were observed
// RED with the schema hunk reverted (law 1 refuses the shape; law 2 admits "") and green with it.
import { describe, it, expect } from "vitest";
import { CapGrantSchema, DispatchCapGrantSchema, InstitutionalChairSchema } from "../src/genome_schema.js";

describe("a chair cap may be a store verb grant", () => {
  it("law 1 — a chair carrying {grant:\"org-lift\"} loads, and the cap is NOT a dispatch grant", () => {
    const chair = InstitutionalChairSchema.safeParse({
      id: "eir-labs.chair.chancellor", institution_slug: "eir-labs", role: "chancellor", function: "CREATE",
      mission: "lift an organization", required_skills: [], obligations: [],
      caps: [{ grant: "org-lift" }],
    });
    expect(chair.success, JSON.stringify(chair.success ? null : chair.error.issues)).toBe(true);
    const cap = CapGrantSchema.parse({ grant: "org-lift" });
    expect(cap).toEqual({ grant: "org-lift", expires: null });
    expect(DispatchCapGrantSchema.safeParse(cap).success, "a verb grant must not parse as a dispatch grant").toBe(false);
  });

  it("law 2 — {grant:\"\"} is REFUSED: a verb grant names its verb", () => {
    expect(CapGrantSchema.safeParse({ grant: "" }).success).toBe(false);
  });

  it("law 3 — {grant:\"dispatch\"} without standards is REFUSED by every member of the union", () => {
    expect(CapGrantSchema.safeParse({ grant: "dispatch" }).success).toBe(false);
    expect(CapGrantSchema.safeParse({ grant: "dispatch", standards: ["x-v0"] }).success, "the dispatch shape still parses").toBe(true);
  });
});
