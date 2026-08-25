// RED-first — a PlacementResolver backed by the genome's own institutions/ files.
//
// WHY THIS BELONGS IN OSS, given the seam was built for a deployment to fill. The precedent is this
// repo's own: the venue seam defines VenueRealizer AND ships dockerComposeRealizer(); GenomeStore has
// three backings (files, a member JWT, an agent capability token) behind one port. A file-backed
// placement resolver is the same shape — the parallel to a deployment's store-backed one, not a competitor
// to it. The deployment answers from chancery_chair_assignment; this answers from institutions/*.json.
//
// WHAT IT CLOSES. The measured gap: institutions/quartet.json's structure-builder chair supplies a
// real `house-style`, bill's carried structure-conformance skill instructs its agent to "read the
// constraints supplied in the `house-style` slot", and nothing has ever delivered it — because until
// #495 there was no moment at which anything was asked. This is the first thing to answer.
//
// THE SEMANTIC THAT KEEPS IT NON-BREAKING, and it is the whole design decision:
//   SILENCE ADMITS. An institution that says nothing about an agent does not refuse it.
//   CONTRADICTION REFUSES. An institution that seats a DIFFERENT agent in that role does.
// Refusing every unwitnessed seating would break the shipped genome — no standard outside the
// quartet has assignments at all. That was flagged as option (c) in the handoff doc and rejected for
// exactly this reason; this is option (a), enforced rather than warned.
import { describe, it, expect } from "vitest";
import { institutionPlacementResolver } from "../src/placement_institutions.js";
import type { PlacementRequest } from "../src/placement.js";

const QUARTET = {
  slug: "quartet",
  document: {
    chairs: [
      { id: "quartet.chair.structure-builder", institution_slug: "quartet", role: "structure-builder",
        supplies: { "house-style": "complete sentences, no first person" } },
      { id: "quartet.chair.field-reader", institution_slug: "quartet", role: "field-reader", supplies: {} },
    ],
    assignments: [
      { id: "s1", chair_id: "quartet.chair.structure-builder", agent_slug: "bill",
        technique_evidence: [{ source: "tests/x.test.ts", claim: "carries the technique" }] },
      { id: "s2", chair_id: "quartet.chair.field-reader", agent_slug: "john", technique_evidence: [] },
    ],
  },
} as never;

const req = (agent_slug: string, role: string): PlacementRequest =>
  ({ agent_slug, role, standard_slug: "s", phase: "p", gig_id: "g",
     input_contract: [], output_contract: [] }) as PlacementRequest;

describe("a placement resolver backed by institutions/ files", () => {
  it("F1 — the SEATED agent is admitted, and the chair's supplies arrive as hydration", async () => {
    // The measured gap, closed: the quartet's house-style finally reaches the agent told to read it.
    const r = institutionPlacementResolver(new Map([["quartet", QUARTET]]));
    const d = await r.place(req("bill", "structure-builder"));
    expect(d.admitted).toBe(true);
    expect(d.hydration).toEqual({ "house-style": "complete sentences, no first person" });
  });

  it("F2 — SILENCE ADMITS: an agent no institution mentions is not refused", async () => {
    // The decision that keeps this non-breaking. No shipped standard outside the quartet has
    // assignments; refusing on absence would break the genome.
    const r = institutionPlacementResolver(new Map([["quartet", QUARTET]]));
    const d = await r.place(req("code-implementer", "write-change"));
    expect(d.admitted).toBe(true);
    expect(d.hydration).toBeUndefined();
  });

  it("F3 — CONTRADICTION REFUSES: a different agent in a seated role is refused, by name", async () => {
    // The institution has spoken about this chair and named someone else. That is a real conflict,
    // not an absence, and the reason must name both so an operator sees the contradiction.
    const r = institutionPlacementResolver(new Map([["quartet", QUARTET]]));
    const d = await r.place(req("miles", "structure-builder"));
    expect(d.admitted).toBe(false);
    expect(d.reason).toMatch(/bill/);
    expect(d.reason).toMatch(/miles/);
  });

  it("F4 — a seated chair with NO supplies admits without inventing hydration", async () => {
    const r = institutionPlacementResolver(new Map([["quartet", QUARTET]]));
    const d = await r.place(req("john", "field-reader"));
    expect(d.admitted).toBe(true);
    expect(d.hydration).toBeUndefined();
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("F5 — NO institutions at all: everything is admitted, nothing is hydrated", async () => {
    // Without this, a resolver that refused on an empty map would break every deployment that has no
    // institutions/ directory — which is most of them.
    const r = institutionPlacementResolver(new Map());
    const d = await r.place(req("anyone", "any-role"));
    expect(d.admitted).toBe(true);
    expect(d.hydration).toBeUndefined();
  });

  it("F6 — it does not admit on the strength of the ROLE NAME alone", async () => {
    // A resolver matching only on role would hydrate any agent that happened to sit in a chair with
    // the same name, in any standard. The assignment names the AGENT; both must agree.
    const r = institutionPlacementResolver(new Map([["quartet", QUARTET]]));
    const d = await r.place(req("bill", "field-reader"));
    expect(d.admitted).toBe(false);
    expect(d.hydration).toBeUndefined();
  });
});
