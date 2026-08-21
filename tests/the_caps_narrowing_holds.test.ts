// RED-first — a seating may NARROW what its chair grants, never widen it. The rule is written down
// in three places and enforced in none.
//
// WHERE IT IS WRITTEN. CLAUDE.md: "Authorization for running standards sits ON THE CHAIR CONTRACT: a
// chair's `caps` may carry {"grant":"dispatch","standards":[...]}, an agent is seated by a chair
// assignment, and a credential presented by the incumbent MAY ONLY NARROW what the chair grants —
// never widen it." DispatchCapGrantSchema's own docstring repeats it. And the quartet declares it as
// a formal ADICO law:
//
//   deontic:   forbidden
//   aim:       "exercise a capability the seated chair grants do not contain"
//   or_else:   "the action is refused at dispatch, and the authority lapses the moment the agent is
//               unseated"
//   check:     "(subseteq exercised_caps chair_caps)"
//
// WHERE IT IS ENFORCED: nowhere. Measured — `evaluate(check, facts)` exists at
// src/institution_enforcement.ts:290, `exercised_caps` appears in no src/ file, and no dispatch path
// (server.ts, runtime.ts, worker.ts) calls evaluate() at all. The law's own `or_else` asserts it is
// "refused at dispatch"; dispatch has never asked. A rule that states its own enforcement and has
// none is the sharpest form of the defect this repo keeps finding.
//
// WHAT IS CHECKABLE AT PLACEMENT. `exercised_caps` is a runtime fact — what the agent actually did —
// and the placement moment cannot know it. But the DECLARED half can be checked exactly: an
// assignment's `contract_caps` must be a subset of its chair's `caps`. That is the credential
// narrowing the office, which is the sentence CLAUDE.md actually writes. A widening is a static
// contradiction and is refusable before a token is spent.
import { describe, it, expect } from "vitest";
import { institutionPlacementResolver } from "../src/placement_institutions.js";
import type { PlacementRequest } from "../src/placement.js";

const inst = (chairCaps: unknown[], seatCaps: unknown[]) =>
  ({
    slug: "quartet",
    document: {
      chairs: [{ id: "c1", institution_slug: "quartet", role: "runner", supplies: {}, caps: chairCaps }],
      assignments: [{ id: "s1", chair_id: "c1", agent_slug: "bill", contract_caps: seatCaps }],
    },
  }) as never;

const dispatch = (...standards: string[]) => ({ grant: "dispatch", standards, expires: null });
const req = (): PlacementRequest =>
  ({ agent_slug: "bill", role: "runner", standard_slug: "s", phase: "p", gig_id: "g",
     input_contract: [], output_contract: [] }) as PlacementRequest;

describe("a seating narrows its chair, never widens it", () => {
  it("N1 — a seating claiming a standard its chair does not grant is REFUSED, naming it", async () => {
    const r = institutionPlacementResolver(new Map([["quartet", inst([dispatch("alpha")], [dispatch("alpha", "beta")])]]));
    const d = await r.place(req());
    expect(d.admitted).toBe(false);
    expect(d.reason).toMatch(/beta/);
  });

  it("N2 — a seating that NARROWS is admitted: fewer standards than the chair grants is the point", async () => {
    const r = institutionPlacementResolver(new Map([["quartet", inst([dispatch("alpha", "beta")], [dispatch("alpha")])]]));
    expect((await r.place(req())).admitted).toBe(true);
  });

  it("N3 — an EQUAL seating is admitted: subset, not proper subset", async () => {
    const r = institutionPlacementResolver(new Map([["quartet", inst([dispatch("alpha")], [dispatch("alpha")])]]));
    expect((await r.place(req())).admitted).toBe(true);
  });

  it("N4 — a chair granting NO dispatch caps refuses any seating that claims one", async () => {
    // The empty set narrows to nothing. A seat claiming authority an office does not hold is the
    // clearest widening there is.
    const r = institutionPlacementResolver(new Map([["quartet", inst([], [dispatch("alpha")])]]));
    const d = await r.place(req());
    expect(d.admitted).toBe(false);
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("N5 — a seating with NO contract_caps is admitted: claiming nothing is not widening", async () => {
    // Without this, an implementation that refused on absence would break every existing assignment
    // — the quartet's three all carry `contract_caps: []`.
    const r = institutionPlacementResolver(new Map([["quartet", inst([dispatch("alpha")], [])]]));
    expect((await r.place(req())).admitted).toBe(true);
  });

  it("N6 — a NON-dispatch cap on the seat does not trip the dispatch check", async () => {
    // Only dispatch grants are compared here; an edge-cap is a different authority with a different
    // shape, and silently refusing it would be a check exceeding its own stated scope.
    // Carries a `standards` array but is NOT a dispatch grant. The earlier fixture had no
    // `standards` at all, so the array check filtered it before the grant-kind check mattered —
    // removing the grant-kind test entirely left this law green. Caught by sabotage, not by reading.
    const edge = { edge_type: "adopted_by", scope: {}, expires: null, standards: ["alpha", "beta"] };
    const r = institutionPlacementResolver(new Map([["quartet", inst([dispatch("alpha")], [edge])]]));
    expect((await r.place(req())).admitted).toBe(true);
  });
});
