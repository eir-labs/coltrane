// RED — Venue doors axioms (I7 egress, I8 empty-egress, I9 ingress). Fails at import until
// fast-check is a devDependency (O1) and src/venue_realize.ts exists (O2). Green when realize()
// binds egress/ingress as deny-by-default host allowlists whose OBSERVABLE outcome (canReach /
// canAccept) matches the doors exactly — the invariant is asserted, the mechanism is not.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize } from "../../src/venue_realize.js";

const HOSTS = ["api.vercel.com", "mail.example.com", "evil.example.com", "registry.npmjs.org"];
const room = (doors: { ingress: string[]; egress: string[] }): Venue =>
  ({ slug: "doors-room", institution_slug: "quartet", equipment: { tools: [] }, doors,
     installs: [], credential_surface: [], lifecycle: { policy: "ephemeral" } } as unknown as Venue);
const realized = (doors: { ingress: string[]; egress: string[] }) => {
  const r = realize(room(doors), { seats: [], ambientEnv: {}, gigId: "g" });
  if (!r.ok) throw new Error(`realize refused a sound doors room: ${JSON.stringify(r.refusal)}`);
  return r;
};

describe("venue doors — deny-by-default egress and ingress allowlists (I7,I8,I9)", () => {
  it("I7 egress-allowlist axiom: canReach(host) iff host ∈ doors.egress", () => {
    fc.assert(fc.property(fc.subarray(HOSTS), fc.constantFrom(...HOSTS), (egress, host) => {
      expect(realized({ ingress: [], egress }).canReach(host)).toBe(egress.includes(host));
    }));
  });

  it("I8 empty-egress ⇒ sealed: doors.egress=[] means no destination is reachable", () => {
    const r = realized({ ingress: [], egress: [] }); // empty-room-v1's egress:[] intent
    for (const h of HOSTS) expect(r.canReach(h)).toBe(false);
  });

  it("I9 ingress-allowlist: canAccept(origin) iff origin ∈ doors.ingress", () => {
    fc.assert(fc.property(fc.subarray(HOSTS), fc.constantFrom(...HOSTS), (ingress, origin) => {
      expect(realized({ ingress, egress: [] }).canAccept(origin)).toBe(ingress.includes(origin));
    }));
  });
});
