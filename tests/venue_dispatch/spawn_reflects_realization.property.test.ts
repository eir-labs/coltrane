// RED — the SPAWN reflects the venue realization (INV1,2,3,4,5,9,10).
//
// These pin the INVOKER half of the wire: given a chair whose AgentInvocationContext carries a
// resolved room (`realization` from resolveAndRealize + the `venue` it was realized from — the
// fields the dispatch path must thread, which today do NOT exist on the ctx), the constructed
// spawn must advertise EXACTLY the intersected tool ceiling and run under an allowlist-derived
// child env — never the un-intersected grant, never the inherited full process.env.
//
// Why they are RED today: makeClaudeInvoker ignores any realization on the ctx. In the bare
// (no-provider) invoker `effectiveAllowed = ctx.agent.allowed_tools` (claude_invoker.ts:778), so
// the un-wired spawn advertises the RAW grant — advertised === grants. A subset law
// (advertised ⊆ grants) already holds there and would be a tautology; these assert the STRICT
// effect (advertised EQUALS grants ∩ equipment, and is strictly smaller when the room narrows),
// which is green only once the intersection reaches --allowedTools. The child env is captured
// through the SAME injected-run seam, which today receives no env argument at all.
//
// Scope: this asserts the constructed spawn ARGS/ENV the child would receive (the injected-run
// seam short-circuits before a real process) — NOT realize() in isolation (tests/venue/ owns
// that) and NOT real OS sandboxing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { venueEffectiveTools, type Venue } from "../../src/chart.js";
import { realize, type Realization } from "../../src/venue_realize.js";
import { makeClaudeInvoker } from "../../src/claude_invoker.js";
import { testAgent } from "../_support/agents.js";
import type { Agent } from "../../src/composition.js";
import type { AgentInvocationContext } from "../../src/runtime.js";

const base = (g: string): string => g.split("(")[0]!;
const TOOLS = ["Read", "Glob", "Grep", "Bash", "WebFetch(https://api.vercel.com/*)", "Edit", "Write"];
const toolArb = fc.subarray(TOOLS);

const room = (tools: string[], credential_surface: string[] = []): Venue =>
  ({ slug: "prop-room", institution_slug: "quartet", equipment: { tools },
     doors: { ingress: [], egress: [] }, installs: [], credential_surface,
     lifecycle: { policy: "ephemeral" } } as unknown as Venue);

// Build the ctx the WIRE must hand the invoker: the seated agent PLUS the room it runs in,
// carried as { realization, venue }. Today the invoker reads neither; that is the missing wire.
// `run` captures the constructed (args, env) without spawning a real CLI.
async function driveSpawn(
  agent: Agent,
  venue: Venue | undefined,
): Promise<{ allowedTools: string[] | undefined; childEnv: Record<string, string> | undefined; runCalled: boolean }> {
  let sawArgs: string[] = [];
  let sawEnv: Record<string, string> | undefined;
  let runCalled = false;
  const invoke = makeClaudeInvoker({
    // The wire feeds the constructed child env as the 4th arg (today it is called with 3 → undefined).
    run: (_bin, args, _bounds, env?: Record<string, string>) => {
      runCalled = true;
      sawArgs = args;
      sawEnv = env;
      return '{"text":"ok"}';
    },
  });
  const realization: Realization | undefined =
    venue === undefined ? undefined : realize(venue, { seats: [{ agent }], ambientEnv: {}, gigId: "g1" });
  const ctx = { agent, gig_input: {}, inputs: [], realization, venue } as unknown as AgentInvocationContext;
  await invoke(ctx);
  const i = sawArgs.indexOf("--allowedTools");
  const allowedTools = i === -1 ? undefined : (sawArgs[i + 1]?.split(",") ?? []);
  return { allowedTools, childEnv: sawEnv, runCalled };
}

describe("spawn reflects venue realization — the tool ceiling (INV1,2,3,9)", () => {
  it("INV1 — for ANY agent×venue, --allowedTools EQUALS venueEffectiveTools(agent, venue)", async () => {
    await fc.assert(fc.asyncProperty(toolArb, toolArb, async (grants, equip) => {
      const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
      const venue = room(equip);
      const oracle = venueEffectiveTools(agent, venue); // the EXISTING, tested intersection is the oracle
      // A grant set the room narrows to nothing fails closed at realize (F3/ceiling-empty), tested
      // separately; the ceiling-EQUALITY claim is over the seats the room admits.
      if (grants.length > 0 && oracle.length === 0) return;
      const { allowedTools } = await driveSpawn(agent, venue);
      const advertised = new Set(allowedTools ?? []);
      expect(advertised).toEqual(new Set(oracle));
    }), { numRuns: 200 });
  });

  it("INV2 — when equipment ⊊ grants (a granted tool is unequipped), advertised is STRICTLY smaller than the grant set", async () => {
    // Disjoint pools GUARANTEE the strict case: intersection = SHARED (non-empty), grants carry
    // GRANT_ONLY the room lacks. This is the anti-tautology axiom — un-wired advertised === grants
    // (size 4+), so strict-smaller FAILS today and is green only once the wire intersects.
    const SHARED = ["Read", "Grep"], GRANT_ONLY = ["Bash", "Write"], EQUIP_ONLY = ["Edit", "Glob"];
    await fc.assert(fc.asyncProperty(
      fc.subarray(SHARED, { minLength: 1 }), fc.subarray(GRANT_ONLY, { minLength: 1 }), fc.subarray(EQUIP_ONLY),
      async (shared, grantOnly, equipOnly) => {
        const grants = [...shared, ...grantOnly];
        const equipment = [...shared, ...equipOnly];
        const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
        const { allowedTools } = await driveSpawn(agent, room(equipment));
        const advertised = allowedTools ?? [];
        expect(advertised.length).toBeLessThan(grants.length); // strictly narrowed
        const advBases = new Set(advertised.map(base));
        for (const g of grantOnly) expect(advBases.has(base(g))).toBe(false); // granted-but-unequipped never advertised
        expect(new Set(advBases)).toEqual(new Set(shared.map(base)));
      }), { numRuns: 200 });
  });

  it("INV3 — a tool in grants but NOT in equipment NEVER appears in --allowedTools", async () => {
    await fc.assert(fc.asyncProperty(toolArb, toolArb, async (grants, equip) => {
      const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
      const oracle = venueEffectiveTools(agent, room(equip));
      if (grants.length > 0 && oracle.length === 0) return; // fail-closed case, not this claim
      const { allowedTools } = await driveSpawn(agent, room(equip));
      const advertised = new Set((allowedTools ?? []).map(base));
      const equipBases = new Set(equip.map(base));
      const difference = grants.map(base).filter((g) => !equipBases.has(g)); // grants ∖ equipment
      for (const d of difference) expect(advertised.has(d)).toBe(false);
    }), { numRuns: 200 });
  });

  it("INV9 — the advertised set is the SHARED venueEffectiveTools oracle R10 uses, not a re-inlined intersection", async () => {
    // Differential/oracle-equivalence on a concrete pair: the spawn must equal what the imported,
    // already-tested function computes — the same function composeChart R10 refuses against — so
    // runtime enforcement and the compose-time refusal cannot drift to different intersections.
    const agent = testAgent({ slug: "editor", primitives: ["CREATE"], allowed_tools: ["Read", "Bash", "Write", "Edit"] });
    const venue = room(["Read", "Write"]); // equips 2 of the 4 grants
    const { allowedTools } = await driveSpawn(agent, venue);
    expect(new Set(allowedTools ?? [])).toEqual(new Set(venueEffectiveTools(agent, venue)));
    expect(new Set(allowedTools ?? [])).toEqual(new Set(["Read", "Write"]));
  });

  it("INV10 (regression guard) — a venue-LESS dispatch advertises the agent's raw grants, unregressed", async () => {
    // The paired green-must-stay-green guard: the wire narrows ONLY when a room is named. A wire
    // that over-narrows (or scopes env) with no venue present would turn this RED — that is the
    // regression it exists to catch.
    const agent = testAgent({ slug: "free", primitives: ["SENSE"], allowed_tools: ["Read", "Bash"] });
    const { allowedTools } = await driveSpawn(agent, undefined);
    expect(new Set(allowedTools ?? [])).toEqual(new Set(["Read", "Bash"]));
  });
});

describe("spawn reflects venue realization — the child env allowlist (INV4,5)", () => {
  const INJECTED = ["COLTRANE_TEST_OPENAI_KEY", "COLTRANE_TEST_AWS_SECRET", "COLTRANE_TEST_UNDECLARED_TOKEN"];
  beforeEach(() => { for (const k of INJECTED) process.env[k] = "leak-me"; });
  afterEach(() => { for (const k of INJECTED) delete process.env[k]; });

  it("INV5 — an undeclared ambient secret is ABSENT from the constructed child env", async () => {
    // A venue whose surface declares SOME class but not the injected token: the token is undeclared
    // and must not reach the child. RED today — no env is constructed/passed to the seam at all, so
    // the child would inherit the full process.env including the injected secret.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const venue = room(["Read"], ["vercel-token"]); // surface is non-empty but excludes the injected secret
    const { childEnv } = await driveSpawn(agent, venue);
    expect(childEnv).toBeDefined(); // an explicit allowlist object, not undefined (== full inherit)
    expect(childEnv!["COLTRANE_TEST_UNDECLARED_TOKEN"]).toBeUndefined();
  });

  it("INV4 — an EMPTY credential_surface admits ZERO ambient credentials into the child env", async () => {
    // Deny-by-default: an empty surface is a subset floor — no ambient credential-shaped var may
    // appear in the constructed child env. RED today (full process.env inherited).
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const { childEnv } = await driveSpawn(agent, room(["Read"], []));
    expect(childEnv).toBeDefined();
    for (const k of INJECTED) expect(childEnv![k]).toBeUndefined();
  });
});
