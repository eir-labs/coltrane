// THE SKILL LOADER READS A VERSION HISTORY AS A HISTORY, NOT AS A COLLISION.
//
// FOUND on production by the verifier, and it is the venue defect one class over:
//
//   ledger-reconcile  9fc052da…  v1  active  org b7d732c1…  created 08-15 19:09 by eugene
//   ledger-reconcile  65e85797…  v2  active  org b7d732c1…  created 08-15 19:48 by eugene
//
// Two rows, BOTH ACTIVE, 39 minutes apart — `skill_evolve` minted v2 and never retired its
// parent. The loader's envelope selected neither `version` nor `org_id`, so it saw two rows
// for one slug and threw `duplicate skill slug "ledger-reconcile"`, naming the SLUG. A live
// skill reporting as broken because its own history was sitting beside it, and one of the
// six load errors holding the drain closed.
//
// THE RULE, and one place it deliberately differs from venues. Venues filter to `active`
// alone, because a superseded room is not a room. Skills carry three statuses and the engine
// defaults a missing one to "active", which says a DEPRECATED skill is still meant to load:
// deprecated means "do not reach for this", not "this does not exist". Dropping deprecated
// rows to fix a duplicate would silently remove skills that are in use — so RETIRED is
// ignored and deprecated stands. Among what survives, the highest version per (org, slug)
// wins, because that is what a version IS.
//
// Two rows at the SAME version is not a history. It is contradictory data, and it REFUSES
// naming both — the same refuse-don't-pick position the venue loader took, for the same
// reason: picking would be a row-order coin toss wearing a determinism costume.
import { describe, expect, it } from "vitest";
import { reconstructGenome, Q } from "../src/genome_store.js";

const skill = (over: Record<string, unknown>) => ({
  slug: "ledger-reconcile",
  version: 1,
  status: "active",
  org_id: "org-a",
  description: "reconcile the ledger",
  input_type: "artifact",
  output_type: "judgment",
  tier: 0,
  skill_md: "# reconcile",
  ...over,
});

const load = (skills: unknown[]) =>
  reconstructGenome({
    core_types: [], domain_types: [], agents: [], standards: [],
    charts: [], institutions: [], venues: [], skills,
  } as never);

describe("a skill's version history is a history, not a duplicate", () => {
  it("v1 active beside v2 active yields ONE skill, and it is v2 — the production shape", () => {
    const g = load([
      skill({ version: 1, description: "the parent" }),
      skill({ version: 2, description: "the child" }),
    ]);
    expect(g.load_errors, "a version history is not an error").toEqual([]);
    expect(g.skills.size).toBe(1);
    expect(g.skills.get("ledger-reconcile")?.description).toBe("the child");
  });

  it("two rows at the SAME version REFUSE, naming both — not a pick", () => {
    const g = load([
      skill({ version: 2, status: "active" }),
      skill({ version: 2, status: "deprecated" }),
    ]);
    expect(g.skills.has("ledger-reconcile"), "neither claimant may be adopted").toBe(false);
    const e = g.load_errors.find((x) => x.slug === "ledger-reconcile");
    expect(e, "the ambiguity is reported").toBeDefined();
    expect(e!.error).toMatch(/ambiguous skill/);
    expect(e!.error, "and says how they differ, so it can be resolved").toMatch(/active/);
    expect(e!.error).toMatch(/deprecated/);
  });

  it("RETIRED is ignored; DEPRECATED still loads — the difference from venues", () => {
    // Retired beside active: the active one stands alone, no error.
    const retired = load([
      skill({ version: 1, status: "retired" }),
      skill({ version: 2, status: "active" }),
    ]);
    expect(retired.load_errors).toEqual([]);
    expect(retired.skills.size).toBe(1);

    // A deprecated skill with no active sibling still LOADS. This is the assertion that
    // stops "filter to active" from being copied over from venues without thought: a
    // deprecated skill is one you should not reach for, not one that ceased to exist, and
    // dropping it would remove a skill that gigs may still name.
    const deprecated = load([skill({ version: 1, status: "deprecated" })]);
    expect(deprecated.load_errors).toEqual([]);
    expect(deprecated.skills.has("ledger-reconcile")).toBe(true);
  });

  it("the same slug in TWO ORGS is two skills, not a collision", () => {
    // RE-WRITTEN — the verifier proved the first version VACUOUS by Law 3. It used org-a v3
    // beside org-b v1 and asserted only `load_errors == []`. With the org dropped from the
    // key, org-a's v3 simply wins on version, org-b's row is silently discarded, no error is
    // raised, and the law stays green while the defect it names is fully present. A "no
    // error" assertion on a fixture that CANNOT COLLIDE is a description, not a law.
    //
    // The fixture now uses the SAME VERSION in both orgs, which is the only arrangement where
    // the key is observable: with a correct (org, slug) key these are two different skills and
    // there is nothing to reconcile; with a slug-only key they are one slug at one version —
    // the ambiguity case — and the clash pass fires.
    const g = load([
      skill({ org_id: "org-a", version: 1, description: "A's" }),
      skill({ org_id: "org-b", version: 1, description: "B's" }),
    ]);
    expect(
      g.load_errors,
      "two orgs holding the same slug at the same version are two skills, not a clash — a " +
      "slug-only key reports them as ambiguous, which is how this law sees the defect",
    ).toEqual([]);

    // AND THE HONEST LIMITATION, stated rather than hidden: the genome's `skills` map is keyed
    // by SLUG, so it cannot hold both at once and one of these two is what remains. The
    // scoping fixed here is the RECONCILIATION (they are not treated as a version conflict);
    // a slug-keyed genome serving two orgs at once is a larger question than this change, and
    // pretending otherwise by asserting both survive would be asserting something false.
    expect(g.skills.size, "one survives — the map is slug-keyed, which this law does not fix")
      .toBe(1);
  });

  it("THE MUTANT (verifier's law 3): the envelope must carry status, version and org_id", () => {
    // If the select reverts, the loader stops receiving the facts every rule above needs and
    // a version history becomes indistinguishable from a collision again.
    for (const field of ["status", "version", "org_id"]) {
      expect(Q.skills, `the skills envelope must select ${field}`).toContain(field);
    }
  });
});
