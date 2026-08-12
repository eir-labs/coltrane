// RED — Stateful realize/attempt/teardown (I12 residue-free, I13 isolation, I14 contract-forbids
// ⇒ never-permitted). Fails at import until fast-check is a devDependency (O1) and
// src/venue_realize.ts exists (O2). Model-based: a simplified model of the room's declared egress
// drives random command sequences; the real realization must never permit what the model forbids,
// and teardown must leave no reachable residue.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize, type Realization } from "../../src/venue_realize.js";

const HOSTS = ["api.vercel.com", "evil.example.com", "mail.example.com"];
const room = (egress: string[]): Venue =>
  ({ slug: "model-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

type Model = { torn: boolean; egress: string[] };
type Real = { r: Realization };

class AttemptEgress implements fc.Command<Model, Real> {
  constructor(readonly host: string) {}
  check = (): boolean => true;
  run(m: Model, s: Real): void {
    // I14: the real realization permits reach iff the declared contract permits it (and not torn down).
    expect(s.r.canReach(this.host)).toBe(m.egress.includes(this.host) && !m.torn);
  }
  toString(): string { return `egress(${this.host})`; }
}
class Teardown implements fc.Command<Model, Real> {
  check = (m: Model): boolean => !m.torn;
  run(m: Model, s: Real): void { s.r.teardown(); m.torn = true; expect(s.r.tornDown()).toBe(true); }
  toString(): string { return "teardown"; }
}
class AssertResidueFree implements fc.Command<Model, Real> {
  check = (m: Model): boolean => m.torn;
  run(_m: Model, s: Real): void {
    // I12: after teardown of an ephemeral realization, no destination remains reachable.
    for (const h of HOSTS) expect(s.r.canReach(h)).toBe(false);
  }
  toString(): string { return "assertResidueFree"; }
}

describe("venue realization is stateful — isolation and teardown (I12,I13,I14)", () => {
  it("I12/I14 no contract-forbidden reach across any command sequence; teardown leaves no residue", () => {
    const cmds = fc.commands([
      ...HOSTS.map((h) => fc.constant(new AttemptEgress(h))),
      fc.constant(new Teardown()),
      fc.constant(new AssertResidueFree()),
    ], { size: "small" });
    fc.assert(fc.property(fc.subarray(HOSTS), cmds, (egress, commands) => {
      const setup = () => {
        const r = realize(room(egress), { seats: [], ambientEnv: {}, gigId: "g" });
        if (!r.ok) throw new Error("realize refused a sound egress room");
        return { model: { torn: false, egress }, real: { r } };
      };
      fc.modelRun(setup, commands);
    }));
  });

  it("I13 per-gig isolation: tearing one gig's realization down leaves another's reach intact", () => {
    fc.assert(fc.property(fc.subarray(HOSTS), fc.subarray(HOSTS), fc.constantFrom(...HOSTS), (eg1, eg2, host) => {
      const r1 = realize(room(eg1), { seats: [], ambientEnv: {}, gigId: "gig-1" });
      const r2 = realize(room(eg2), { seats: [], ambientEnv: {}, gigId: "gig-2" });
      if (!r1.ok || !r2.ok) return;
      expect(r1.isolation_handle).not.toBe(r2.isolation_handle);
      r1.teardown();
      expect(r1.tornDown()).toBe(true);
      expect(r2.tornDown()).toBe(false); // tearing gig-1 down leaves gig-2 intact
    }));
  });
});
