// The seat inherits the institution's lineage.
//
// `institutionLineageGrounding` shipped as a named seam with ZERO call sites — the accessor
// existed, the field existed, the schema comment said "every agent seated there inherits it",
// and nothing in src/ ever asked. That is the same defect class the repo names elsewhere: the
// right vocabulary with no mechanism behind it, indistinguishable from a working one until
// somebody greps.
//
// These tests are the mechanism's floor. The load-bearing one is UNAPPROVED LINEAGE IS NOT
// INHERITED: LineageRecordRefSchema.approved_by is nullable and defaulted to null so that a
// record which reached the approve chair and was not sealed stays inert. Without that filter a
// parked lineage pass would silently ground an institution, which is exactly the "nothing is
// adopted on an absent yes" rule the lineage-verdict type states.

import { describe, it, expect } from "vitest";
import { agentLineageGrounding, type LoadedInstitution } from "../src/institution_loader.js";
import { InstitutionSchema, type LineageRecordRefOutput } from "../src/genome_schema.js";

const ref = (record_ref: string, approved_by: string | null): LineageRecordRefOutput => ({
  record_ref,
  question: `why ${record_ref}`,
  approved_by,
  sealed_at: "2026-08-19T00:00:00.000Z",
});

function inst(slug: string, lineage: LineageRecordRefOutput[], extra: Partial<LoadedInstitution["document"]> = {}): LoadedInstitution {
  return {
    slug,
    document: {
      institution: InstitutionSchema.parse({ slug, name: slug, kind: "institution", lineage }),
      ...extra,
    },
  };
}

const chair = (id: string, institution_slug: string) => ({
  id, institution_slug, role: `role-${id}`, human: false, function: "CREATE",
  mission: "m", required_skills: [], preferred_skills: [],
}) as never;

const seat = (chair_id: string, agent_slug: string) => ({ id: `a-${chair_id}`, chair_id, agent_slug }) as never;

describe("agentLineageGrounding", () => {
  it("inherits an approved lineage ref from the institution whose office the agent is seated in", () => {
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha-approved", "eugene")], {
        chairs: [chair("c1", "studio")], assignments: [seat("c1", "board-wright")],
      })],
    ]);
    expect(agentLineageGrounding(m, "board-wright").map((r) => r.record_ref)).toEqual(["sha-approved"]);
  });

  it("does NOT inherit lineage that was never approved — a parked pass grounds nothing", () => {
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha-parked", null), ref("sha-sealed", "eugene")], {
        chairs: [chair("c1", "studio")], assignments: [seat("c1", "board-wright")],
      })],
    ]);
    expect(agentLineageGrounding(m, "board-wright").map((r) => r.record_ref)).toEqual(["sha-sealed"]);
  });

  it("grounds nothing for an agent seated nowhere", () => {
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha", "eugene")], { chairs: [chair("c1", "studio")], assignments: [seat("c1", "someone-else")] })],
    ]);
    expect(agentLineageGrounding(m, "board-wright")).toEqual([]);
  });

  it("follows the CHAIR's institution, not the document the assignment is filed in", () => {
    // The office is studio's; the paperwork sits in labs. Lineage follows the office.
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha-studio", "tasha")], { chairs: [chair("c1", "studio")] })],
      ["labs", inst("labs", [ref("sha-labs", "eugene")], { assignments: [seat("c1", "board-wright")] })],
    ]);
    expect(agentLineageGrounding(m, "board-wright").map((r) => r.record_ref)).toEqual(["sha-studio"]);
  });

  it("deduplicates by record_ref when one agent holds two offices of the same institution", () => {
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha-one", "eugene")], {
        chairs: [chair("c1", "studio"), chair("c2", "studio")],
        assignments: [seat("c1", "board-wright"), seat("c2", "board-wright")],
      })],
    ]);
    expect(agentLineageGrounding(m, "board-wright").map((r) => r.record_ref)).toEqual(["sha-one"]);
  });

  it("an assignment naming a chair the genome does not hold grounds nothing, and does not throw", () => {
    const m = new Map<string, LoadedInstitution>([
      ["studio", inst("studio", [ref("sha", "eugene")], { assignments: [seat("ghost-chair", "board-wright")] })],
    ]);
    expect(agentLineageGrounding(m, "board-wright")).toEqual([]);
  });
});
