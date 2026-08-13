// RED — the VARIANCE (the missing numerator) read from the booking → gig → settlement chain, plus
// the visibilities and the two set-difference reports.
//
// Covers contract INV24, INV25, INV26, INV27, INV28, INV29, INV32 (variance side) and INV34. Every
// reader here (computeVariance, unpromisedGigs, undispatchedBookings, northstarsWithNoBooking,
// bookingsServingNoNorthstar) is an unbuilt seam that throws, so each assertion is RED on absent
// enforcement. The variance is asserted to be READ FROM the chain: mutating a ledger row's usage must
// move the computed variance, which a hand-assembled number could not.
import { describe, it, expect } from "vitest";
import {
  computeVariance,
  unpromisedGigs,
  undispatchedBookings,
  northstarsWithNoBooking,
  bookingsServingNoNorthstar,
} from "../../src/committed_work.js";
import { booking, tour, gigRow } from "./_fixtures.js";

describe("promised-versus-delivered variance, read from the chain (INV24, INV25, INV32, INV34)", () => {
  it("INV24/INV34 variance = committed − settled, summed over the booking's settled gigs", () => {
    const funded = booking({ amount: 1000, settled_gig_ids: ["gig.a", "gig.b"] });
    const ledger = [gigRow("gig.a", 300), gigRow("gig.b", 250), gigRow("gig.unrelated", 999)];
    const v = computeVariance(funded, ledger);
    expect(v.settled, "settled is summed over ONLY the booking's own gigs").toBe(550);
    expect(v.committed).toBe(1000);
    expect(v.variance, "committed 1000 − settled 550").toBe(450);
  });

  it("INV24 the numerator is READ from the ledger, not assembled — mutating usage moves the variance", () => {
    const funded = booking({ amount: 1000, settled_gig_ids: ["gig.a"] });
    const before = computeVariance(funded, [gigRow("gig.a", 300)]);
    const after = computeVariance(funded, [gigRow("gig.a", 800)]);
    expect(before.variance).not.toBe(after.variance);
    expect(after.settled, "the reader reflects the ledger row it actually read").toBe(800);
  });

  it("INV32 an amountless booking has NO numerator — variance is null, not a throw and not zero", () => {
    const { amount: _drop, ...noAmount } = booking({ amount: 1000, settled_gig_ids: ["gig.a"] });
    const v = computeVariance(noAmount, [gigRow("gig.a", 300)]);
    expect(v.has_numerator).toBe(false);
    expect(v.committed).toBeNull();
    expect(v.variance, "no amount means no variance numerator — an honest null").toBeNull();
  });

  it("INV25 the booking→gig join is an IN-REPO id list — a settled id carries no URL/external ref", () => {
    const funded = booking({ amount: 1000, settled_gig_ids: ["gig.a"] });
    for (const id of funded.settled_gig_ids ?? []) {
      expect(/https?:\/\/|:\/\//.test(id), "a settled gig id must be a bare in-repo id").toBe(false);
    }
    // and the reader only sums rows it can resolve in the supplied ledger (no off-repo lookup)
    const v = computeVariance(funded, [gigRow("gig.a", 400)]);
    expect(v.settled_gig_ids).toEqual(["gig.a"]);
  });
});

describe("unpromised work and undispatched bookings are VISIBLE (INV26, INV27)", () => {
  it("INV26 a gig no booking settled against is surfaced (unpromised work — allowed, not silent)", () => {
    const bookings = [booking({ settled_gig_ids: ["gig.a"] })];
    const orphans = unpromisedGigs(["gig.a", "gig.orphan"], bookings);
    expect(orphans).toContain("gig.orphan");
    expect(orphans).not.toContain("gig.a");
  });

  it("INV27 a booking that settled against no gig is surfaced (unfulfilled — not silently dropped)", () => {
    const dispatched = booking({ slug: "bk.done", settled_gig_ids: ["gig.a"] });
    const idle = booking({ slug: "bk.idle", settled_gig_ids: [] });
    const undone = undispatchedBookings([dispatched, idle]);
    expect(undone.map((b) => b.slug)).toContain("bk.idle");
    expect(undone.map((b) => b.slug)).not.toContain("bk.done");
  });
});

describe("the two reports — set differences over data the objects already carry (INV28, INV29)", () => {
  it("INV28 north stars with NO booking are queryable (directions nobody is funding)", () => {
    const t = tour({
      northstar_slugs: ["ns.funded", "ns.unfunded"],
      bookings: [booking({ served_northstars: ["ns.funded"] })],
    });
    expect(northstarsWithNoBooking(t)).toEqual(["ns.unfunded"]);
  });

  it("INV29 bookings serving NO north star are queryable (spend with no stated direction)", () => {
    const t = tour({
      bookings: [
        booking({ slug: "bk.directed", served_northstars: ["ns.funded"] }),
        booking({ slug: "bk.undirected", served_northstars: [] }),
      ],
    });
    const undirected = bookingsServingNoNorthstar(t);
    expect(undirected.map((b) => b.slug)).toEqual(["bk.undirected"]);
  });
});
