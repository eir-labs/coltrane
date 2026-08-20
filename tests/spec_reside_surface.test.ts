// RED — the boundary laws: reside's gig path IS work's, the venue is the sole hands contract, the
// channel is a distinct voice, refusals fail closed before any side effect, and the verb mirrors
// work's env/exit contract.
//
// Closes defect (4) — "two front doors that agree on what a gig means" becomes a LAW by referential
// identity (a second implementation fails by existing), matching how venueMayClaim already refuses
// drift (src/worker.ts:323-341).
//
// Covers I12 (reside's gig path === workOnce), I17 (venue_slug is the SOLE hands surface — no second
// list; an undeclared credential class is refused), I18 (channel_id and venue_slug are distinct — a
// channel credential is not a venue credential class), I19 (typed refusal BEFORE any row is written),
// I20 (env + exit-code parity with work).
//
// workOnce is the REAL existing symbol (src/worker.ts). residencyGigPath and the rest live in the
// not-yet-authored src/residency.ts, so loadResidency() rejects — the RED signal.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { workOnce } from "../src/worker.js";
import { loadResidency, type ResidencyModule, type ResidencyRecord } from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

describe("reside's gig path IS work's gig path (I12)", () => {
  it("I12 residencyGigPath is the exact workOnce symbol — a second implementation fails by existing", () => {
    // Referential identity, not a schema match: the two front doors cannot diverge on what a gig
    // means because there is only ONE function behind both.
    expect(R.residencyGigPath, "reside re-implemented the gig path instead of reusing workOnce").toBe(
      workOnce,
    );
  });
});

describe("the venue is the sole hands contract (I17)", () => {
  it("I17 the residency row carries venue_slug and NO separate hands/tools list", () => {
    expect(R.RESIDENCY_ROW_FIELDS).toContain("venue_slug");
    // A second hands list is a second contract free to disagree with the first — unrepresentable.
    for (const forbidden of ["hands", "tools", "tool_list", "tool_ceiling", "credential_surface"]) {
      expect(R.RESIDENCY_ROW_FIELDS, `the row carries a second hands list "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it("I17 a credential class the venue does not declare is refused a breach", () => {
    const venue = { credential_surface: ["slack_app", "github"] };
    const ok = R.admitVenueCredential(venue, "github");
    expect(ok.ok).toBe(true);
    const breach = R.admitVenueCredential(venue, "aws_root");
    expect(breach.ok, "a credential outside the venue's surface was admitted").toBe(false);
    if (!breach.ok) expect(breach.reason).toBe("credential_breach");
  });
});

describe("the channel (voice) is distinct from the venue (hands) (I18)", () => {
  it("I18 channel_id and venue_slug are separate row fields, never one folded into the other", () => {
    expect(R.RESIDENCY_ROW_FIELDS).toContain("channel_id");
    expect(R.RESIDENCY_ROW_FIELDS).toContain("venue_slug");
    expect(R.RESIDENCY_ROW_FIELDS.indexOf("channel_id")).not.toBe(
      R.RESIDENCY_ROW_FIELDS.indexOf("venue_slug"),
    );
  });

  it("I18 a channel token is not admissible as a venue credential class", () => {
    // The venue declares its hands; the channel transport is a distinct axis. Presenting the channel
    // credential as a venue credential class is a breach unless the venue explicitly declared it.
    const venue = { credential_surface: ["slack_app"] };
    const asVenueCred = R.admitVenueCredential(venue, "channel_token");
    expect(asVenueCred.ok, "a channel token was accepted as a venue credential class").toBe(false);
  });
});

describe("boot fails closed with typed refusals BEFORE any side effect (I19)", () => {
  const spec = { agent_slug: "agent.viola", org: "org.house", venue_slug: "venue.studio", channel_id: "chan.parlor" };

  function deps(over: Partial<{ agent: boolean; venue: boolean; cortex: boolean }> = {}) {
    const rows: ResidencyRecord[] = [];
    return {
      rows,
      d: {
        resolveAgent: (_s: string) => (over.agent === false ? null : { slug: "agent.viola" }),
        resolveVenue: (_s: string) =>
          over.venue === false ? null : { slug: "venue.studio", credential_surface: [] },
        cortexPresent: () => over.cortex !== false,
        seatRow: (rec: ResidencyRecord) => {
          rows.push(rec);
        },
      },
    };
  }

  it("I19 an unresolvable agent → {ok:false, refusal:'no_such_agent'} and NO row written", () => {
    const { rows, d } = deps({ agent: false });
    const r = R.bootResidency(spec, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("no_such_agent");
    expect(rows.length, "a row was seated despite a refused boot").toBe(0);
  });

  it("I19 an unresolvable venue → {ok:false, refusal:'no_such_venue'} and NO row written", () => {
    const { rows, d } = deps({ venue: false });
    const r = R.bootResidency(spec, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("no_such_venue");
    expect(rows.length).toBe(0);
  });

  it("I19 an absent cortex (room image, not floor) → {ok:false, refusal:'no_cortex'} and NO row written", () => {
    const { rows, d } = deps({ cortex: false });
    const r = R.bootResidency(spec, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toBe("no_cortex");
    expect(rows.length).toBe(0);
  });
});

describe("the verb mirrors work's env and exit contract (I20)", () => {
  // CAVEAT (contract-noted): this asserts against the reside verb wiring, which does not exist yet;
  // it is expected RED and pins the parity the moment the verb is wired.
  it("I20 reside with no store env returns the same usage-refusal code work uses for missing env", async () => {
    const io = { out: vi.fn(), err: vi.fn(), env: {} as Record<string, string> };
    const code = await R.runReside([], io);
    // Missing COLTRANE_STORE_URL/ANON is a usage refusal (exit 2), the same door work uses.
    expect(code).toBe(2);
  });
});
