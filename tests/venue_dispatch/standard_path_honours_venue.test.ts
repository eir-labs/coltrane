// RED — the MCP STANDARD-dispatch path must honour a named venue (SITE 1 of a two-site defect).
//
// gig a77f6f7f is the measurement this law forbids: dispatching room-probe-v1 with venue
// "engine-room-v1" produced NO room, NO refusal, NO warning, and a 'complete' status whose sealed
// output was byte-identical to the venue-less control. The cause: the standard-dispatch handler read
// args['venue'] into a local and then DISCARDED it (`void venue;`, with a false comment claiming the
// queue seam forwarded it — for a LOCAL run nothing did). The chart path set deps.venue and
// deps.venueRealizer; the standard path set neither, so runGig's venue block never ran.
//
// The law: a standard dispatched with a venue must reach runGig with deps.venue set (and
// deps.venueRealizer, when one is wired) — proven observable as the resolved room on the chair's
// invocation context — OR fail closed with a named refusal. A run that COMPLETES successfully having
// silently ignored the venue must make this law FAIL. It covers BOTH callers: the wait:true
// synchronous path and the default async path.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type AgentInvocationContext, type DomainType,
} from "../../src/index.js";
import { dispatchTool, type ServerDeps } from "../../src/server.js";
import type { Standard, Agent } from "../../src";
import type { Venue } from "../../src/chart.js";
import type { Realization } from "../../src/venue_realize.js";
import type { VenueRealizer, RealizationHandle } from "../../src/venue_realizer.js";
import { testAgent } from "../_support/agents.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
};
// `note` is Signal-cored, so every payload names where it was acquired (the substance floor).
const SIGNAL = { source: "fixture://demo/note" };

// A one-chair standard whose sole agent grants Read — the room below equips Read, so the ceiling
// intersection is non-empty and policy realization succeeds.
function standard(): Standard {
  const scout = testAgent({
    slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
    allowed_tools: ["Read"],
  }) as Agent;
  return {
    slug: "room-probe-v1", domain: "demo", agents: [scout],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  };
}

// A room that equips Read AND declares an mcp server — so runGig both realizes the policy layer
// (deps.venue) AND reaches the substrate realizer (deps.venueRealizer). Built in-memory; the schema
// cross-checks are exercised elsewhere.
const engineRoom: Venue = {
  slug: "engine-room-v1", institution_slug: "quartet",
  equipment: { tools: ["Read"] }, doors: { ingress: [], egress: [] }, installs: [],
  credential_surface: [], mcp_servers: [{ slug: "engine", transport: "stdio", command: ["engine-mcp"], credential_names: [] }],
  lifecycle: { policy: "ephemeral" },
} as unknown as Venue;

// A recording realizer: runGig calls .realize() when the resolved room declares mcp_servers, so a
// call here is proof deps.venueRealizer reached the executor.
function spyRealizer(): { realizer: VenueRealizer; realizeCalls: () => Venue[] } {
  const seen: Venue[] = [];
  const handle: RealizationHandle = {
    state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [],
    teardown: () => {}, tornDown: () => true,
  };
  const realizer = {
    substrate: "test", guarantees: [], available: () => true,
    retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async (venue: unknown) => { seen.push(venue as Venue); return handle; },
  } as unknown as VenueRealizer;
  return { realizer, realizeCalls: () => seen };
}

function deps(invoke: AgentInvoker, extra: Partial<ServerDeps> = {}): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  const std = standard();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
    venues: new Map([[engineRoom.slug, engineRoom]]),
    ...extra,
  };
}

describe("SITE 1 — the standard-dispatch path honours a named venue", () => {
  it("wait:true — runGig is reached with deps.venue realized AND deps.venueRealizer invoked", async () => {
    let captured: AgentInvocationContext | undefined;
    const { realizer, realizeCalls } = spyRealizer();
    const d = deps((ctx) => { captured = ctx; return { t: "hi", ...SIGNAL }; }, { venueRealizer: realizer });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "room-probe-v1", input: {}, venue: "engine-room-v1", wait: true }, d);
    expect(r.ok, r.error).toBe(true);
    expect((r.data as { status?: string }).status).toBe("complete");
    // The resolved room on the chair ctx is the observable proof deps.venue reached runGig — a
    // 'complete' whose runGig call carried no venue (the a77f6f7f outcome) leaves this undefined.
    const realization = (captured as unknown as { realization?: Realization; venue?: Venue } | undefined)?.realization;
    expect(realization, "a completed dispatch that ignored the venue is exactly gig a77f6f7f").toBeDefined();
    expect(realization!.ok).toBe(true);
    expect((captured as unknown as { venue?: Venue }).venue?.slug).toBe("engine-room-v1");
    // deps.venueRealizer reached runGig: the room declares an mcp server, so realize() ran for it.
    expect(realizeCalls().map((v) => v.slug)).toContain("engine-room-v1");
  });

  it("async (default) — the production dispatch path threads the venue too", async () => {
    let captured: AgentInvocationContext | undefined;
    const { realizer } = spyRealizer();
    const d = deps((ctx) => { captured = ctx; return { t: "hi", ...SIGNAL }; }, { venueRealizer: realizer });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "room-probe-v1", input: {}, venue: "engine-room-v1" }, d);
    expect(r.ok, r.error).toBe(true);
    for (let i = 0; i < 400 && captured === undefined; i++) await new Promise((res) => setTimeout(res, 5));
    expect((captured as unknown as { venue?: Venue } | undefined)?.venue?.slug, "the default path must not discard the venue").toBe("engine-room-v1");
  });

  it("a dead venue name FAILS CLOSED — it never completes as the venue-less control did", async () => {
    let invoked = 0;
    const d = deps(() => { invoked++; return { t: "hi", ...SIGNAL }; }); // no venueRealizer needed — refusal precedes any chair
    const r = await dispatchTool("gig_dispatch", { standard_slug: "room-probe-v1", input: {}, venue: "ghost-room-v1", wait: true }, d);
    expect(r.ok, "a named venue the server cannot resolve must refuse, not run unconfined").toBe(false);
    expect(String(r.error)).toMatch(/venue|refused/i);
    expect(invoked, "a refused room spawns no chair and seals nothing").toBe(0);
    expect(d.outputs.all().length).toBe(0);
  });
});
