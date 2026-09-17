// RED — WI-11: the genome names its org, by UUID.
//
// THE LIVE INCIDENT. `governance-desk` and `verifier-desk` are ABSENT from the loaded genome —
// not degraded, gone — so the room where governance acts are equipped, and the verifier's own
// room, can equip nobody. Measured in the store, four ACTIVE rows across two orgs:
//
//   governance-desk  @eir-labs-inc   v1 active   seed
//   governance-desk  @eugene-studio  v1 active   by eugene, later
//   verifier-desk    @eugene-studio  v1 active   migration
//   verifier-desk    @eir-labs-inc   v1 active   by eugene, later
//
// In each pair the hand-stamped row is the LATER one: a second org was given the same desk
// deliberately. So retiring a row deletes a room someone opened on purpose, and a uniqueness
// constraint on a venue name forbids multi-tenancy already exercised twice by hand. Both of those
// "fixes" turn a live defect into a permanent limitation.
//
// THE CAUSE, and the engine says it in its own comment (genome_store.ts): the venue map is keyed
// by SLUG ALONE, and "there is no caller and no org context at this layer, so choosing between
// them would be a coin toss wearing a determinism costume." The refusal is CORRECT. A correct
// refusal is not a working system.
//
// AND IT IS THE PIN LAW'S OWN INCIDENT, a fifth surface: an equipment act once landed in the wrong
// org because the org was ambient. The ruling was that every act names its org and ambient context
// is a refusal condition. Keying venues by slug alone IS ambient org resolution — the law existed
// and was never carried into this layer.
//
// A NOTE ON LAW SHAPE, which is this desk's own lesson handed back: do NOT assert the ambiguity
// error is absent. An absent error passes for every reason, including the room never being asked
// for — the same substitution a reachability law made with `not.toContain("unknown command")`.
// These laws assert the rooms RESOLVE, with the right org's equipment: a positive only the working
// path can produce.
import { describe, it, expect } from "vitest";
import { reconstructGenome, rpcGenomeStore } from "../src/genome_store.js";

const ORG_A = "11111111-1111-4111-8111-111111111111"; // eir-labs-inc, in the fixture
const ORG_B = "22222222-2222-4222-8222-222222222222"; // eugene-studio

function venueRow(slug: string, org_id: string, tools: string[]) {
  return {
    slug,
    version: 1,
    status: "active",
    org_id,
    // The real venue shape (venues/ci-deploy-room-v1.json) — a fixture that does not validate
    // makes a law red for the wrong reason, which proves nothing.
    definition: {
      slug,
      institution_slug: "quartet",
      equipment: { tools },
      doors: { ingress: [], egress: [] },
      credential_surface: [],
      lifecycle: { policy: "standing", rebuild_cadence: "weekly" },
    },
  };
}

/** The live shape: one desk claimed by two orgs, each with its own equipment. */
const ROWS = {
  core_types: [],
  domain_types: [],
  agents: [],
  standards: [],
  skills: [],
  charts: [],
  venues: [
    venueRow("verifier-desk", ORG_A, ["Read", "Grep"]),
    venueRow("verifier-desk", ORG_B, ["Read", "Bash"]),
    venueRow("governance-desk", ORG_A, ["Read", "output_write"]),
    venueRow("governance-desk", ORG_B, ["Read"]),
  ],
};

describe("WI-11 — a venue is (org_id, slug), never a slug alone", () => {
  it("with the acting org named, BOTH desks resolve — with that org's equipment", () => {
    // The positive the incident demands. Not "no error": the rooms are THERE and they are the
    // right ones, which only the working path can produce.
    const g = reconstructGenome(ROWS as never, { acting_org_id: ORG_A });
    expect([...g.venues.keys()].sort(), "the rooms are still missing from the genome").toEqual([
      "governance-desk",
      "verifier-desk",
    ]);
    expect(g.venues.get("verifier-desk")?.equipment.tools, "the wrong org's desk was loaded").toEqual([
      "Read",
      "Grep",
    ]);
    expect(g.venues.get("governance-desk")?.equipment.tools).toEqual(["Read", "output_write"]);
  });

  it("the OTHER org gets its own rooms from the same rows — two orgs, two desks, no conflict", () => {
    const g = reconstructGenome(ROWS as never, { acting_org_id: ORG_B });
    expect(g.venues.get("verifier-desk")?.equipment.tools).toEqual(["Read", "Bash"]);
    expect(g.venues.get("governance-desk")?.equipment.tools).toEqual(["Read"]);
  });

  it("another org's room is NOT an ambiguity — it is simply not this genome's room", () => {
    const g = reconstructGenome(ROWS as never, { acting_org_id: ORG_A });
    const ambiguous = g.load_errors.filter((e) => /ambiguous venue/.test(e.error));
    expect(ambiguous, "a cross-org name collision was still reported as ambiguity").toEqual([]);
  });

  it("two ACTIVE rows in the SAME org is still a refusal — the guard is narrowed, not removed", () => {
    const rows = {
      ...ROWS,
      venues: [venueRow("verifier-desk", ORG_A, ["Read"]), venueRow("verifier-desk", ORG_A, ["Bash"])],
    };
    const g = reconstructGenome(rows as never, { acting_org_id: ORG_A });
    expect(g.venues.has("verifier-desk"), "the engine picked one of two same-org rows by row order").toBe(
      false,
    );
    expect(g.load_errors.some((e) => /ambiguous venue/.test(e.error))).toBe(true);
  });

  it("WITHOUT an acting org, a cross-org collision still refuses — absent means DECLINE", () => {
    // The whole point of the PIN LAW: ambient or defaulted org context is a refusal condition.
    // Loading without naming an org must not quietly pick the first row.
    const g = reconstructGenome(ROWS as never);
    expect(g.venues.has("verifier-desk"), "an unpinned load resolved a contested room anyway").toBe(false);
    expect(g.load_errors.some((e) => /ambiguous venue/.test(e.error))).toBe(true);
  });

  it("the acting org is a UUID, and a slug is not accepted in its place", () => {
    // ISOLATED ON PURPOSE. Run against ROWS, this law passed for the wrong reason — the contested
    // name refused as an AMBIGUITY whether or not the pin was ever checked, so a sabotage that
    // accepted slugs left it green. One uncontested row removes that cover: nothing here can
    // refuse except the pin itself failing to be an org identity.
    const rows = { ...ROWS, venues: [venueRow("solo-desk", ORG_A, ["Read"])] };
    expect(
      reconstructGenome(rows as never, { acting_org_id: ORG_A }).venues.has("solo-desk"),
      "the guard on this law: an uncontested room must load for the right org",
    ).toBe(true);
    expect(
      reconstructGenome(rows as never, { acting_org_id: "eir-labs-inc" } as never).venues.has("solo-desk"),
      "a slug was accepted as an org identity — slugs are exactly what collides across orgs",
    ).toBe(false);
  });
});

describe("the token's answer names the org — the drain pins itself", () => {
  // The store half (coltrane-ui #232) adds `org_id` to the genome RPC's answer, because
  // `coltrane_mcp_genome` has always scoped every collection to the token's org and simply never
  // SAID so. `coltrane_agent_token.org_id` is `uuid NOT NULL`, one row per key_id — so a ctk_
  // resolves to exactly one organization BY CONSTRUCTION. Nothing selects, so nothing can choose
  // wrong: not "the function is careful" but "there is nothing to be careful about."
  //
  // That closes the last open question without a third repo: the drain does not need to learn its
  // org from the claim (which carries only `acting_for`, an agent slug) or from its own env — the
  // genome answer it is already reading names the org, from the authoritative source.
  const ORG = "33333333-3333-4333-8333-333333333333";

  function stubFetch(answer: Record<string, unknown>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(answer),
    })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("pins the load with the org_id the RPC returned, so a contested name still resolves", async () => {
    const restore = stubFetch({
      core_types: [], domain_types: [], agents: [], standards: [], skills: [], charts: [],
      org_id: ORG,
      // Both orgs' rows present in the answer is the worst case; the pin must still pick correctly.
      venues: [venueRow("verifier-desk", ORG, ["Read", "Grep"]), venueRow("verifier-desk", ORG_B, ["Bash"])],
    });
    try {
      const store = rpcGenomeStore({ baseUrl: "https://s.test", anonKey: "a", agentToken: "ctk_x" });
      const g = await store.load();
      // The positive: resolved, and resolved to the RIGHT room. A count alone cannot tell
      // "resolved to one" from "resolved to the other org's".
      expect(g.venues.get("verifier-desk")?.equipment.tools, "the drain loaded the wrong org's desk")
        .toEqual(["Read", "Grep"]);
    } finally {
      restore();
    }
  });

  it("an answer with no org_id stays unpinned — the engine does not invent one", async () => {
    const restore = stubFetch({
      core_types: [], domain_types: [], agents: [], standards: [], skills: [], charts: [],
      venues: [venueRow("verifier-desk", ORG, ["Read"]), venueRow("verifier-desk", ORG_B, ["Bash"])],
    });
    try {
      const g = await rpcGenomeStore({ baseUrl: "https://s.test", anonKey: "a", agentToken: "ctk_x" }).load();
      expect(g.venues.has("verifier-desk"), "an unnamed org was defaulted rather than declined").toBe(false);
    } finally {
      restore();
    }
  });
});
