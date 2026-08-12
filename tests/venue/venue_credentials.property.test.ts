// RED — Venue credential-surface axioms (I5, I6). Fails at import until fast-check is a
// devDependency (O1) and src/venue_realize.ts exists (O2). Green when realize() builds the child
// env as a default-deny allowlist over credential_surface and REFUSES (never strips) an undeclared
// credential. Operates on credential CLASSES: the env-var-name → class classifier is
// implementation-defined (an open question), but the breach/allowlist axioms hold over classes.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { type Venue } from "../../src/chart.js";
import { realize } from "../../src/venue_realize.js";

const CLASSES = ["vercel-token", "github-token", "aws-key", "openai-key"];
const room = (surface: string[]): Venue =>
  ({ slug: "cred-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: surface,
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

describe("venue credential surface — refuse an undeclared credential, don't strip it (I5,I6)", () => {
  it("I5 credential-breach axiom: any present class ∉ credential_surface refuses realization (breach)", () => {
    fc.assert(fc.property(fc.subarray(CLASSES, { minLength: 1 }), fc.subarray(CLASSES), (present, surface) => {
      const undeclared = present.filter((c) => !surface.includes(c));
      const r = realize(room(surface), { seats: [], ambientEnv: {}, credentialsPresent: present, gigId: "g" });
      if (undeclared.length > 0) {
        expect(r.ok).toBe(false); // breach → refuse, never a stripped-but-proceeding realization
        if (!r.ok) expect(r.refusal.code).toBe("credential-breach");
      } else {
        expect(r.ok).toBe(true);
      }
    }));
  });

  it("I6 credential-allowlist axiom: provisioned classes ⊆ credential_surface — nothing else admitted", () => {
    fc.assert(fc.property(fc.subarray(CLASSES), (surface) => {
      const r = realize(room(surface), { seats: [], ambientEnv: {}, credentialsPresent: surface, gigId: "g" });
      if (!r.ok) throw new Error(`realize refused a room whose present set equals its surface: ${JSON.stringify(r.refusal)}`);
      for (const c of r.provisioned_credentials) expect(surface.includes(c)).toBe(true);
    }));
  });

  it("I6 example: ci-deploy-room-v1 admits only vercel-token; a present github-token is a breach", () => {
    const ci = room(["vercel-token"]);
    const ok = realize(ci, { seats: [], ambientEnv: {}, credentialsPresent: ["vercel-token"], gigId: "g" });
    if (!ok.ok) throw new Error("realize refused the vercel-token-only room");
    expect(ok.provisioned_credentials).toEqual(["vercel-token"]);
    const breach = realize(ci, { seats: [], ambientEnv: {}, credentialsPresent: ["vercel-token", "github-token"], gigId: "g" });
    expect(breach.ok).toBe(false);
    if (!breach.ok) expect(breach.refusal.code).toBe("credential-breach");
  });
});
