// RED — the DISPATCH PATH calls realize() and fails closed on refusal (INV6,7,8 + F1,F2,F3,F4).
//
// These pin the RUNTIME half of the wire: when the gig names a venue, runGig MUST resolve it from
// a venues map and call resolveAndRealize BEFORE invoking the chair, thread the resulting
// Realization into the AgentInvocationContext, tear the room down at the chair lifecycle end, and
// — on any refusal — ABORT the chair fail-closed (no invoke, no spawn, nothing sealed), exactly as
// an unresolvable tool grant rejects today (claude_invoker.ts:793 / the preflight guard).
//
// The chosen wire (see docs/venue-dispatch-wiring.md): the venue slug + a `venues`
// Map<string,Venue> enter through RunDeps; runGig resolves and realizes per gig, threads the
// Realization onto ctx.realization, and calls teardown() in the chair try/finally.
//
// Why RED today: runGig never consults a room — AgentInvocationContext carries no realization
// (runtime.ts:45-82), so every ctx.realization capture is undefined and every venue-named gig
// with a refusing room runs to completion instead of aborting.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "../_support/agents.js";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type AgentInvocationContext,
  type DomainType,
  type RunDeps,
} from "../../src";
import type { Standard, Agent } from "../../src";
import type { Venue } from "../../src/chart.js";
import type { Realization } from "../../src/venue_realize.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { text: { type: "string" } } }, required_fields: ["text"],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(note);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// A one-chair standard whose sole agent grants `grants`. The venue equips/ surfaces vary per test.
function oneChair(grants: string[]): Standard {
  const scout: Agent = {
    ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["note"],
    domain: "demo", allowed_tools: grants,
  } as Agent;
  return {
    slug: "sense-only", domain: "demo", agents: [scout],
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
  };
}

const venue = (o: Partial<Venue> & { slug: string }): Venue =>
  ({ institution_slug: "quartet", equipment: { tools: ["Read", "Bash"] }, doors: { ingress: [], egress: [] },
     installs: [], credential_surface: [], lifecycle: { policy: "ephemeral" }, ...o } as unknown as Venue);

// A call-counting invoker that also captures the ctx it was handed (to read ctx.realization).
function capturingInvoke(): { invoke: AgentInvoker; calls: () => number; ctx: () => AgentInvocationContext | undefined } {
  let n = 0;
  let last: AgentInvocationContext | undefined;
  const invoke: AgentInvoker = (ctx) => { n++; last = ctx; return { text: "a note", source: "test" }; };
  return { invoke, calls: () => n, ctx: () => last };
}

// RunDeps with the venue wire fields the implementation must consume. Cast so the test compiles
// before those fields exist on RunDeps; RED because runGig ignores them today.
function withVenue(base: RunDeps, slug: string, venues: Map<string, Venue>, extra: Record<string, unknown> = {}): RunDeps {
  const d = base as unknown as Record<string, unknown>;
  return { ...d, venue: slug, venues, ...extra } as unknown as RunDeps;
}

describe("dispatch calls realize + threads the realization (INV6,7,8)", () => {
  it("INV8 — a venue-named gig CALLS resolveAndRealize and threads the Realization onto the ctx", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const v = venue({ slug: "studio", equipment: { tools: ["Read", "Bash"] } });
    const res = await runGig(oneChair(["Read"]), {}, withVenue({ outputs, ledger, invoke: cap.invoke }, "studio", new Map([["studio", v]])));
    expect(res.status).toBe("complete");
    const realization = (cap.ctx() as unknown as { realization?: Realization } | undefined)?.realization;
    expect(realization, "the chair ctx must carry the realized room").toBeDefined();
    expect(realization!.ok).toBe(true);
    // realize stamps `venue:<slug>:gig:<gigId>:<counter>` — proof the wire ran the real function.
    expect(realization!.isolation_handle).toMatch(/^venue:studio:gig:.*:\d+$/);
  });

  it("INV6 — two gigs through the wired path carry DISTINCT isolation handles", async () => {
    const v = venue({ slug: "studio" });
    const venues = new Map([["studio", v]]);
    const a = setup(), capA = capturingInvoke();
    await runGig(oneChair(["Read"]), {}, withVenue({ outputs: a.outputs, ledger: a.ledger, invoke: capA.invoke }, "studio", venues));
    const b = setup(), capB = capturingInvoke();
    await runGig(oneChair(["Read"]), {}, withVenue({ outputs: b.outputs, ledger: b.ledger, invoke: capB.invoke }, "studio", venues));
    const hA = (capA.ctx() as unknown as { realization?: Realization }).realization?.isolation_handle;
    const hB = (capB.ctx() as unknown as { realization?: Realization }).realization?.isolation_handle;
    expect(hA).toBeDefined();
    expect(hB).toBeDefined();
    expect(hA).not.toBe(hB);
  });

  it("INV7 — teardown() is invoked at the chair lifecycle end (the room is torn down after the gig)", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const v = venue({ slug: "studio" });
    await runGig(oneChair(["Read"]), {}, withVenue({ outputs, ledger, invoke: cap.invoke }, "studio", new Map([["studio", v]])));
    const realization = (cap.ctx() as unknown as { realization?: Realization }).realization;
    expect(realization, "ctx must carry the realized room").toBeDefined();
    // tornDown() flips to true only once the runtime called teardown() at chair end — the observable
    // proof of the lifecycle wire, not a re-test of realize's idempotence (tests/venue owns that).
    expect(realization!.tornDown()).toBe(true);
  });
});

describe("dispatch fails closed on any realize refusal — no invoke, nothing sealed (F1,F2,F3,F4)", () => {
  it("F1 — an UNKNOWN venue slug (a dead name) aborts the gig; invoke runs ZERO times", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    // The map does NOT hold "ghost" → resolveAndRealize returns unknown-venue.
    await expect(
      runGig(oneChair(["Read"]), {}, withVenue({ outputs, ledger, invoke: cap.invoke }, "ghost", new Map())),
    ).rejects.toThrow();
    expect(cap.calls(), "a dead venue name must spawn no chair").toBe(0);
    expect(outputs.all().length).toBe(0);
    expect(ledger.count()).toBe(0);
  });

  it("F2 — a credential BREACH (undeclared class present) aborts the gig; invoke runs ZERO times", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const v = venue({ slug: "studio", credential_surface: ["vercel-token"] });
    await expect(
      runGig(oneChair(["Read"]), {}, withVenue(
        { outputs, ledger, invoke: cap.invoke }, "studio", new Map([["studio", v]]),
        { credentialsPresent: ["aws-root-key"] }, // present, undeclared by the surface → breach
      )),
    ).rejects.toThrow();
    expect(cap.calls()).toBe(0);
    expect(outputs.all().length).toBe(0);
  });

  it("F3 — a ceiling-EMPTY seat (grants all outside equipment) aborts the gig; invoke runs ZERO times", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    // Agent grants Bash only; the room equips Read only → grants ∩ equipment is empty → ceiling-empty.
    const v = venue({ slug: "studio", equipment: { tools: ["Read"] } });
    await expect(
      runGig(oneChair(["Bash"]), {}, withVenue({ outputs, ledger, invoke: cap.invoke }, "studio", new Map([["studio", v]]))),
    ).rejects.toThrow();
    expect(cap.calls()).toBe(0);
    expect(outputs.all().length).toBe(0);
  });

  it("F4 — ANY refusal code (a wildcard door) aborts the gig; the un-intersected grants are NEVER a fallback", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const v = venue({ slug: "studio", doors: { ingress: [], egress: ["*"] } }); // wildcard-door refusal
    await expect(
      runGig(oneChair(["Read"]), {}, withVenue({ outputs, ledger, invoke: cap.invoke }, "studio", new Map([["studio", v]]))),
    ).rejects.toThrow();
    expect(cap.calls(), "a refused room must never fall back to spawning with the raw grants").toBe(0);
    expect(outputs.all().length).toBe(0);
  });
});
