// RED — Venue ceiling axioms (I1, I2, I4, F1). Fails at import today: fast-check is not a
// devDependency yet (O1) and src/venue_realize.ts does not exist (O2). A later implementation
// gig makes it green by shipping realize() that intersects each seat's grants with the room's
// equipment via the EXISTING venueEffectiveTools, and feeds only that set to the spawn.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { venueEffectiveTools, type Venue } from "../../src/chart.js";
import { realize } from "../../src/venue_realize.js";
import { testAgent } from "../_support/agents.js";

const base = (g: string): string => g.split("(")[0]!;
const TOOLS = ["Read", "Glob", "Grep", "Bash", "WebFetch(https://api.vercel.com/*)", "Edit", "Write"];
const toolArb = fc.subarray(TOOLS);

const room = (tools: string[]): Venue =>
  ({ slug: "prop-room", institution_slug: "quartet", equipment: { tools },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

describe("venue ceiling — applied to the realized spawn, not merely computed (I1,I2,I4,F1)", () => {
  it("I1 ceiling axiom: effective === grants ∩ equipment; nothing in E∖G nor outside E is advertised", () => {
    fc.assert(fc.property(toolArb, toolArb, (grants, equip) => {
      const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
      const venue = room(equip);
      const r = realize(venue, { seats: [{ agent }], ambientEnv: {}, gigId: "g1" });
      if (!r.ok) { expect(venueEffectiveTools(agent, venue)).toHaveLength(0); return; }
      const seat = r.seats.find((s) => s.agent_slug === "p")!;
      const oracle = venueEffectiveTools(agent, venue); // the existing, tested intersection is the oracle
      expect(new Set(seat.effective_tools)).toEqual(new Set(oracle));
      const roomBases = new Set(equip.map(base));
      const grantBases = new Set(grants.map(base));
      for (const t of seat.effective_tools) {
        expect(roomBases.has(base(t))).toBe(true); // nothing outside E
        expect(grantBases.has(base(t))).toBe(true); // nothing in E∖G
      }
    }));
  });

  it("I2 monotone narrowing: effective ⊆ grants — a room can only narrow a player", () => {
    fc.assert(fc.property(toolArb, toolArb, (grants, equip) => {
      const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
      const r = realize(room(equip), { seats: [{ agent }], ambientEnv: {}, gigId: "g" });
      if (!r.ok) return; // empty intersection is F1, tested below; narrowing is the non-empty case
      const grantBases = new Set(grants.map(base));
      for (const t of r.seats[0]!.effective_tools) expect(grantBases.has(base(t))).toBe(true);
    }));
  });

  it("I4 empty-equipment ⇒ empty spawn: a seat granting nothing realizes with zero advertised tools", () => {
    const agent = testAgent({ slug: "ingest", primitives: ["SENSE"], allowed_tools: [] });
    const r = realize(room([]), { seats: [{ agent }], ambientEnv: {}, gigId: "g" });
    if (!r.ok) throw new Error(`realize refused the bare ingest seat: ${JSON.stringify(r.refusal)}`);
    expect(r.seats[0]!.effective_tools).toEqual([]);
  });

  it("F1 ceiling-empty: a granted agent whose grants ∩ equipment is empty refuses fail-closed", () => {
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Bash"] });
    const r = realize(room(["Read"]), { seats: [{ agent }], ambientEnv: {}, gigId: "g" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("ceiling-empty");
  });
});
