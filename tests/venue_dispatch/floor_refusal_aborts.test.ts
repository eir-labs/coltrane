// RED — THE VENUE'S WALLS at the DISPATCH boundary (INV15 realization-once & abort-closed). When a
// gig names a venue whose declared isolation floor the host's declared profile cannot meet, runGig
// MUST abort fail-closed at resolveAndRealize — no chair spawned, nothing sealed, no ledger row —
// exactly as it already aborts on every existing refusal. RED because `realize` ignores the floor
// and the runtime does not yet thread a `hostProfile`, so the gig runs to completion instead.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "../_support/agents.js";
import {
  runGig, createRegistry, createOutputStore, MemoryLedger,
  type AgentInvoker, type AgentInvocationContext, type DomainType, type RunDeps,
} from "../../src";
import type { Standard, Agent } from "../../src";
import type { Venue } from "../../src/chart.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { properties: { text: { type: "string" } } }, required_fields: ["text"],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(note);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

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
  ({ institution_slug: "quartet", equipment: { tools: ["Read"] }, doors: { ingress: [], egress: [] },
     installs: [], credential_surface: [], lifecycle: { policy: "ephemeral" }, ...o } as unknown as Venue);

function capturingInvoke(): { invoke: AgentInvoker; calls: () => number; ctx: () => AgentInvocationContext | undefined } {
  let n = 0; let last: AgentInvocationContext | undefined;
  const invoke: AgentInvoker = (ctx) => { n++; last = ctx; return { text: "a note", source: "test" }; };
  return { invoke, calls: () => n, ctx: () => last };
}

// The venue wire fields (+ the DECLARED host profile the realizer verifies the floor against) enter
// through RunDeps; cast so the test compiles before those fields exist on RunDeps.
function withVenue(base: RunDeps, slug: string, venues: Map<string, Venue>, extra: Record<string, unknown> = {}): RunDeps {
  return { ...(base as unknown as Record<string, unknown>), venue: slug, venues, ...extra } as unknown as RunDeps;
}

const MACOS_DIR = { id: "macos-dir", capabilities: ["filesystem-boundary"], strategies: ["worktree"] };

describe("dispatch fails closed when the host cannot meet the venue's isolation floor (INV15)", () => {
  it("INV15 a hard-floor venue on a macOS-dir host aborts the gig; invoke runs ZERO times, nothing sealed", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    // The room demands a network namespace; the declared host offers only a private directory.
    const v = venue({ slug: "walled", workspace: { isolation_floor: ["network-namespace"] } as Venue["workspace"] });
    await expect(
      runGig(oneChair(["Read"]), {}, withVenue(
        { outputs, ledger, invoke: cap.invoke }, "walled", new Map([["walled", v]]),
        { hostProfile: MACOS_DIR },
      )),
    ).rejects.toThrow();
    expect(cap.calls(), "a floor the host cannot meet must spawn no chair").toBe(0);
    expect(outputs.all().length).toBe(0);
    expect(ledger.count()).toBe(0);
  });

  it("INV15 realization-once: the SAME venue on a capable host realizes and the chair runs exactly once", async () => {
    const { outputs, ledger } = setup();
    const cap = capturingInvoke();
    const v = venue({ slug: "walled", workspace: { isolation_floor: ["network-namespace"] } as Venue["workspace"] });
    const FLY = { id: "fly-microvm", capabilities: ["filesystem-boundary", "network-namespace", "pid-namespace", "distinct-credential-surface"], strategies: ["worktree", "sandboxed-process", "container"] };
    const res = await runGig(oneChair(["Read"]), {}, withVenue(
      { outputs, ledger, invoke: cap.invoke }, "walled", new Map([["walled", v]]), { hostProfile: FLY },
    ));
    expect(res.status).toBe("complete");
    expect(cap.calls()).toBe(1); // resolveAndRealize ran once before the single chair, which ran once
  });
});
