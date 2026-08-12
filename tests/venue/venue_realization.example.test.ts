// RED — Specific shipped-instance facts (I11 accountability carry, I15 standing cadence,
// I16 wildcard door, I17 dead venue). Fails at import until src/venue_realize.ts exists (O2);
// I16 additionally asserts the existing VenueSchema guard still holds (defense in depth).
import { describe, it, expect } from "vitest";
import { VenueSchema } from "../../src/genome_schema.js";
import { type Venue } from "../../src/chart.js";
import { realize, resolveAndRealize } from "../../src/venue_realize.js";

const base = (over: Partial<Venue>): Venue =>
  ({ slug: "ex-room", institution_slug: "quartet", equipment: { tools: [] },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" }, ...over } as unknown as Venue);

describe("venue realization — specific obligations and failure modes (I11,I15,I16,I17)", () => {
  it("I11 accountability carry: realization.responsible_chair === contract.responsible_chair, verbatim", () => {
    const v = base({ responsible_chair: "quartet.chair.responsible-officer" });
    const r = realize(v, { seats: [], ambientEnv: {}, gigId: "g" });
    if (!r.ok) throw new Error("realize refused a sound room");
    expect(r.responsible_chair).toBe("quartet.chair.responsible-officer");
  });

  it("I15 standing cadence: standing-without-cadence refuses; standing-with-cadence carries it", () => {
    const snowflake = base({ lifecycle: { policy: "standing" } as Venue["lifecycle"] });
    const bad = realize(snowflake, { seats: [], ambientEnv: {}, gigId: "g" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal.code).toBe("standing-without-cadence");
    const standing = base({ lifecycle: { policy: "standing", rebuild_cadence: "P1D" } as Venue["lifecycle"] });
    const ok = realize(standing, { seats: [], ambientEnv: {}, gigId: "g" });
    if (!ok.ok) throw new Error("realize refused a standing room that owns a cadence");
    expect(ok.lifecycle.rebuild_cadence).toBe("P1D");
  });

  it("I16 no wildcard boundary: the schema refuses '*', and the realize layer refuses it too", () => {
    expect(VenueSchema.safeParse({ slug: "w", institution_slug: "quartet", doors: { egress: ["*"] } }).success).toBe(false);
    const smuggled = base({ doors: { ingress: [], egress: ["*"] } });
    const r = realize(smuggled, { seats: [], ambientEnv: {}, gigId: "g" });
    expect(r.ok).toBe(false); // a Venue built in memory without re-parsing must not smuggle a wildcard
    if (!r.ok) expect(r.refusal.code).toBe("wildcard-door");
  });

  it("I17 dead-venue fail-closed: an unknown venue slug refuses, never a default open room", () => {
    const r = resolveAndRealize("no-such-room", { venues: new Map(), seats: [], ambientEnv: {}, gigId: "g" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("unknown-venue");
  });
});
