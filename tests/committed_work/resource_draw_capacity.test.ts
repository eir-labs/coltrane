// RED — a draw is a VECTOR over non-convertible units; over-commitment is checked PER UNIT with no
// exchange rate anywhere, and a non-transferable holding is invisible across organizations.
//
// Covers contract INV15, INV16, INV17, INV18. `checkTourCapacity` is an unbuilt seam that throws, so
// every assertion is RED on absent enforcement. The conservation laws are pinned as fast-check
// PROPERTIES over generated holdings and draw vectors — the same method the repo already uses for the
// reserve-pool no-theft law (tests/gig_reserve_pool.test.ts) — because "no unit is ever over-drawn"
// and "a non-transferable holding cannot be reached cross-org" must hold for EVERY vector, not one.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { checkTourCapacity, type Draw, type Resource } from "../../src/committed_work.js";
import { tour, booking } from "./_fixtures.js";

const UNIT = "max-seat-hours";
const OTHER = "review-hours";

/** A tour with one booking drawing exactly the given vector, accountable to `org`. */
function tourDrawing(draws: Draw[], org = "org.house") {
  return tour({ org_slug: org, bookings: [booking({ draws })] });
}

describe("per-unit over-commitment, no conversion (INV15, INV16)", () => {
  it("INV15 a tour is admitted iff NO unit is over-drawn — a conservation property", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }), // held quantity of UNIT
        fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 5 }), // draws in UNIT
        (held, quantities) => {
          const resources: Resource[] = [
            { slug: "res.seat", holder: "org.house", quantity: held, unit: UNIT, period: "p", transferable: true },
          ];
          const draws: Draw[] = quantities.map((q) => ({ resource_slug: "res.seat", unit: UNIT, quantity: q }));
          const sum = quantities.reduce((a, b) => a + b, 0);
          const result = checkTourCapacity(tourDrawing(draws), resources);
          expect(result.admitted, `sum=${sum} held=${held}`).toBe(sum <= held);
        },
      ),
    );
  });

  it("INV16 units do NOT offset each other — a draw in one unit never frees capacity in another", () => {
    // A holding rich in UNIT and empty in OTHER. A draw in OTHER must be refused (there is no held
    // OTHER to draw and NO conversion from the abundant UNIT), while a within-capacity draw in UNIT
    // is admitted. If the check summed across units or converted, the OTHER draw would pass.
    const resources: Resource[] = [
      { slug: "res.seat", holder: "org.house", quantity: 1000, unit: UNIT, period: "p", transferable: true },
    ];
    const drawInOther = checkTourCapacity(
      tourDrawing([{ resource_slug: "res.seat", unit: OTHER, quantity: 1 }]),
      resources,
    );
    expect(drawInOther.admitted, "a draw in a unit the holder does not hold must be refused").toBe(false);

    const drawInUnit = checkTourCapacity(
      tourDrawing([{ resource_slug: "res.seat", unit: UNIT, quantity: 10 }]),
      resources,
    );
    expect(drawInUnit.admitted, "a within-capacity draw in the held unit is admitted").toBe(true);
  });
});

describe("transferability across organizations (INV17, INV18)", () => {
  it("INV17 a non-transferable holding of another org cannot be drawn — a property over org pairs", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("org.house", "org.personal"), // the tour's accountable org
        fc.constantFrom("org.house", "org.personal"), // the holding's owner
        fc.boolean(), // transferable?
        (tourOrg, holderOrg, transferable) => {
          const resources: Resource[] = [
            { slug: "res.seat", holder: holderOrg, quantity: 100, unit: UNIT, period: "p", transferable },
          ];
          const result = checkTourCapacity(
            tourDrawing([{ resource_slug: "res.seat", unit: UNIT, quantity: 1 }], tourOrg),
            resources,
          );
          const crossOrgLocked = holderOrg !== tourOrg && !transferable;
          if (crossOrgLocked) {
            expect(result.admitted, `a booking accountable to ${tourOrg} drew a non-transferable ${holderOrg} holding`).toBe(false);
          }
        },
      ),
    );
  });

  it("INV18 a TRANSFERABLE holding of another org IS drawable within per-unit capacity", () => {
    // The governor's live case, mirror image: a personal, NON-transferable Max seat is unreachable by
    // a business-accountable booking (INV17), but a transferable house holding is reachable across orgs.
    const resources: Resource[] = [
      { slug: "res.seat", holder: "org.personal", quantity: 100, unit: UNIT, period: "p", transferable: true },
    ];
    const result = checkTourCapacity(
      tourDrawing([{ resource_slug: "res.seat", unit: UNIT, quantity: 1 }], "org.house"),
      resources,
    );
    expect(result.admitted, "a transferable cross-org holding within capacity is admitted").toBe(true);
  });
});
