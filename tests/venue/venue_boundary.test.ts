// RED — Single write-boundary mediation (I3 preflight/spawn agreement, I18 one narrowing point).
// Fails at import until src/venue_realize.ts exists (O2). buildInvokerArgs is the REAL spawn write
// boundary (src/claude_invoker.ts:721, allowed_tools → --allowedTools); this asserts realize hands
// it the intersected set and that the set fed to --allowedTools is exactly that intersection, never
// the agent's full grants — so a future second spawn path that skips the intersection reds here.
import { describe, it, expect } from "vitest";
import { buildInvokerArgs } from "../../src/claude_invoker.js";
import { venueEffectiveTools, type Venue } from "../../src/chart.js";
import { realize } from "../../src/venue_realize.js";
import { testAgent } from "../_support/agents.js";

const venue: Venue =
  ({ slug: "boundary-room", institution_slug: "quartet",
     equipment: { tools: ["Read", "Glob", "WebFetch(https://api.vercel.com/*)"] },
     doors: { ingress: [], egress: ["api.vercel.com"] }, installs: [], credential_surface: [],
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

describe("venue enforcement lands at the single spawn write boundary (I3,I18)", () => {
  const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read", "Glob", "Bash"] });

  it("I3 preflight/spawn agreement: realize hands the seat exactly venueEffectiveTools(agent, venue)", () => {
    const r = realize(venue, { seats: [{ agent }], ambientEnv: {}, gigId: "g" });
    if (!r.ok) throw new Error("realize refused a sound room");
    const seat = r.seats.find((s) => s.agent_slug === "p")!;
    expect(new Set(seat.effective_tools)).toEqual(new Set(venueEffectiveTools(agent, venue)));
  });

  it("I18 single-boundary mediation: --allowedTools carries the intersection, never the full grants", () => {
    const r = realize(venue, { seats: [{ agent }], ambientEnv: {}, gigId: "g" });
    if (!r.ok) throw new Error("realize refused a sound room");
    const seat = r.seats.find((s) => s.agent_slug === "p")!;
    const args = buildInvokerArgs("prompt", "/tmp/cfg.json", { allowed_tools: seat.effective_tools });
    const at = args[args.indexOf("--allowedTools") + 1]!;
    expect(at).toBe(seat.effective_tools.join(","));
    expect(at.split(",")).not.toContain("Bash"); // granted but not equipped — the room narrowed it out
    expect(at.split(",").sort()).toEqual(["Glob", "Read"]); // exactly the intersection
  });
});
