// RED — Venue install-digest axiom (I10). Fails at import until fast-check is a devDependency
// (O1) and src/venue_realize.ts exists (O2). Green when realize() verifies each present install
// against its sha256 pin and refuses entry on mismatch or absence — the digest is the room's
// identity (Docker pull-by-digest prior art).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize } from "../../src/venue_realize.js";

const hex64 = fc.hexaString({ minLength: 64, maxLength: 64 });
const room = (installs: string[]): Venue =>
  ({ slug: "install-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs, credential_surface: [],
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

describe("venue installs — verified against the digest pin or entry refused (I10)", () => {
  it("I10 install-digest axiom: realize refuses iff the present digest ≠ the pin", () => {
    fc.assert(fc.property(hex64, hex64, (pinHex, actualHex) => {
      const pin = `sha256:${pinHex}`;
      const r = realize(room([pin]), {
        seats: [], ambientEnv: {}, installsPresent: [{ ref: "img", digest: `sha256:${actualHex}` }], gigId: "g",
      });
      if (pinHex === actualHex) {
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.refusal.code).toBe("install-digest-mismatch");
      }
    }));
  });

  it("I10 absent install refuses: a pinned install with nothing present is a mismatch, not a pass", () => {
    const pin = `sha256:${"a".repeat(64)}`;
    const r = realize(room([pin]), { seats: [], ambientEnv: {}, installsPresent: [], gigId: "g" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("install-digest-mismatch");
  });
});
