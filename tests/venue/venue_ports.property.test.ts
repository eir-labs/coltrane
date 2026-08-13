// RED — THE VENUE'S WALLS: PORT allocation is part of realization (INV6 cross-gig disjointness as a
// metamorphic relation over PAIRS, or the second is refused 'port-exhausted' — never a race; INV7
// assigned ports honor the declaration). `doors` structurally cannot express a bind port, so the
// venue declares a need and the realizer ASSIGNS and tells the gig. RED because `realize` does not
// populate `ports` and `allocatePorts` is a throwing stub — an absent enforcement, not a type error.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize, allocatePorts, type RealizeOpts } from "../../src/venue_realize.js";

const roomWithPorts = (ports: Venue["ports"]): Venue =>
  ({ slug: "port-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     ports, lifecycle: { policy: "ephemeral" } } as unknown as Venue);

const opts = (over: Partial<RealizeOpts> = {}): RealizeOpts =>
  ({ seats: [], ambientEnv: {}, gigId: "g", ...over });

describe("venue walls — port allocation is part of realization (INV6,INV7)", () => {
  it("INV6 disjointness over pairs: two gigs get pairwise-disjoint port sets, OR the second refuses 'port-exhausted'", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), (count) => {
      const v = roomWithPorts({ count } as Venue["ports"]);
      const a = realize(v, opts({ gigId: "gig-A" }));
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.ports, "the realizer must assign and report the gig's ports").toBeDefined();
      // The second gig is told what A holds — allocation is disjoint from it, or an honest refusal.
      const b = realize(v, opts({ gigId: "gig-B", portsHeld: a.ports! }));
      if (!b.ok) { expect(b.refusal.code).toBe("port-exhausted"); return; }
      expect(b.ports).toBeDefined();
      const overlap = b.ports!.filter((p) => a.ports!.includes(p));
      expect(overlap, "two concurrent gigs must never share a bound port").toEqual([]);
    }));
  });

  it("INV7 assigned ports honor the declaration: |assigned| === count and assigned ⊆ range", () => {
    const byCount = realize(roomWithPorts({ count: 3 } as Venue["ports"]), opts());
    expect(byCount.ok).toBe(true);
    if (byCount.ok) {
      expect(byCount.ports, "a declared count must produce that many ports").toBeDefined();
      expect(byCount.ports!.length).toBe(3);
    }
    const byRange = realize(roomWithPorts({ range: [4000, 4002], count: 2 } as Venue["ports"]), opts());
    expect(byRange.ok).toBe(true);
    if (byRange.ok) {
      expect(byRange.ports).toBeDefined();
      for (const p of byRange.ports!) {
        expect(p).toBeGreaterThanOrEqual(4000);
        expect(p).toBeLessThanOrEqual(4002);
      }
    }
  });

  it("INV7 primitive: allocatePorts assigns disjoint-from-held ports and refuses on exhaustion", () => {
    const ok = allocatePorts({ count: 2 }, []); // two ports, nothing held
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.ports.length).toBe(2);
    const exhausted = allocatePorts({ range: [3000, 3001], count: 5 }, []); // 5 asked of a 2-wide range
    expect(exhausted.ok, "an unsatisfiable need refuses rather than overlapping").toBe(false);
  });
});
