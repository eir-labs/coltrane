// RED-first — the engine exposes a PLACEMENT seam; a deployment supplies the resolver.
//
// WHY THIS SHAPE, and it is not my call: the deployment-seam orientation (2026-08-21) states it. "Coltrane
// (OSS) exposes the chair-placement seam; the deployment plugs into it… the same shape as the
// venue-realizer seam: an interface the engine defines and enforces, an implementation the deployment
// supplies." So the resolution logic — who may sit here, with what history — does NOT belong in
// composeStandard. The engine defines the question and the moment; someone else answers it.
//
// WHAT IT UNBLOCKS. Three things are loaded into the genome today and consumed by nothing, because
// there is no moment at which anything is asked:
//   · an institutional chair's `supplies` (the quartet's house-style is written and never read)
//   · `technique_evidence` — "why this player in this chair", 0 readers
//   · `contract_caps` — the chair-authorisation narrowing rule, 0 readers
// All three are answers waiting for a question. This is the question.
//
// THE SEAM IS OPTIONAL AND FAILS OPEN BY ABSENCE, CLOSED BY REFUSAL. A deployment that supplies no
// placement resolver runs exactly as today — every existing standard and gig is untouched. A
// deployment that DOES supply one can refuse a seating, and a refusal must stop the chair rather than
// be logged and ignored, or the seam is decoration.
import { describe, it, expect } from "vitest";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type DomainType, type Agent, type Standard,
} from "../src";
import type { PlacementResolver, PlacementRequest } from "../src/placement.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const hit: DomainType = {
  slug: "lineage-hit", extends: "Signal", domain: "eirtests",
  schema: { properties: { source: { type: "string" } } }, required_fields: ["source"],
};
const scout: Agent = {
  ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [],
  output_types: ["lineage-hit"], domain: "eirtests",
} as unknown as Agent;

const standard = (): Standard => ({
  slug: "sweep", domain: "eirtests", agents: [scout],
  phases: [{ name: "sense", chairs: [
    { role: "sense", agent_slug: "scout", depends_on: [], input_contract: [],
      output_contract: ["lineage-hit"], required_skills: [] } as unknown as Standard["phases"][number]["chairs"][number],
  ] }],
} as unknown as Standard);

const invoke: AgentInvoker = async () => ({ source: "https://example.com" });

function deps(extra: Record<string, unknown> = {}) {
  const registry = createRegistry();
  registry.registerType(hit);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, ...extra };
}

describe("the engine exposes a placement seam", () => {
  it("P1 — NO resolver: the gig runs exactly as today", async () => {
    // The seam must be invisible when unsupplied. Every existing standard depends on this.
    const res = await runGig(standard(), {}, deps() as never);
    expect(res.outputs.length).toBeGreaterThan(0);
  });

  it("P2 — the resolver is ASKED, and is told who is being placed where", async () => {
    const seen: PlacementRequest[] = [];
    const resolver: PlacementResolver = {
      place: async (req) => { seen.push(req); return { admitted: true }; },
    };
    await runGig(standard(), {}, deps({ placementResolver: resolver }) as never);
    expect(seen.length, "the seam was never asked").toBe(1);
    expect(seen[0]!.agent_slug).toBe("scout");
    expect(seen[0]!.role).toBe("sense");
    expect(seen[0]!.standard_slug).toBe("sweep");
  });

  it("P3 — a REFUSED placement stops the chair, naming the reason", async () => {
    // A refusal that is logged and ignored makes the seam decoration. It must fail the phase, and the
    // error must carry the resolver's reason so an operator learns why the seating was refused —
    // not merely that something went wrong.
    const resolver: PlacementResolver = {
      place: async () => ({ admitted: false, reason: "no assignment seats scout in this chair" }),
    };
    await expect(
      runGig(standard(), {}, deps({ placementResolver: resolver }) as never),
    ).rejects.toThrow(/no assignment seats scout/);
  });

  it("P4 — HYDRATION carried back by the resolver reaches the invocation", async () => {
    // The other half of placement: the deployment's "carry the chain into the chair". Whatever the deployment
    // returns must reach the agent, or the seam validates without hydrating and half the point is
    // missing.
    let seen: unknown;
    const resolver: PlacementResolver = {
      place: async () => ({ admitted: true, hydration: { "house-style": "complete sentences" } }),
    };
    const spy: AgentInvoker = async (c) => {
      seen = (c as unknown as Record<string, unknown>)["hydration"];
      return { source: "https://example.com" };
    };
    await runGig(standard(), {}, deps({ placementResolver: resolver, invoke: spy }) as never);
    expect(seen).toEqual({ "house-style": "complete sentences" });
  });

  // ── NON-VACUITY ───────────────────────────────────────────────────────────────────────────────
  it("P5 — an ADMITTING resolver does not change the run's outcome", async () => {
    // Without this, an implementation that refused everything would pass P3 and break every gig.
    const resolver: PlacementResolver = { place: async () => ({ admitted: true }) };
    const res = await runGig(standard(), {}, deps({ placementResolver: resolver }) as never);
    expect(res.outputs.length).toBeGreaterThan(0);
  });

  it("P6 — a resolver that THROWS refuses the seating, it does not silently admit", async () => {
    // Absent must mean DECLINE. A resolver that errors has not said yes, and treating an exception as
    // admission would make an outage look like an open door.
    const resolver: PlacementResolver = {
      place: async () => { throw new Error("resolver unreachable"); },
    };
    await expect(
      runGig(standard(), {}, deps({ placementResolver: resolver }) as never),
    ).rejects.toThrow(/resolver unreachable|placement/i);
  });
});
