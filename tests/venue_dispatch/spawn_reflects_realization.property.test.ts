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
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { basename, dirname, delimiter } from "node:path";
import fc from "fast-check";
import { venueEffectiveTools, type Venue } from "../../src/chart.js";
import { realize, SEAT_ENV_ALLOWLIST, type Realization } from "../../src/venue_realize.js";
import { makeClaudeInvoker } from "../../src/claude_invoker.js";
import type { ToolProvider, ToolProviderRegistry } from "../../src/tool_providers.js";
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
  ambientEnv: Record<string, string> = {},
  // Supplying either map flips the invoker into resolution-ON mode (#185): bare in-house slugs are
  // renamed to the mcp__<server>__<tool> names their server advertises. Omitted → resolution OFF,
  // the legacy pass-through the INV1..INV10 laws below deliberately exercise.
  resolution?: { toolProviders?: ToolProviderRegistry; mcpServerConfigs?: Record<string, unknown> },
): Promise<{ allowedTools: string[] | undefined; disallowedTools: string[] | undefined; childEnv: Record<string, string> | undefined; runCalled: boolean }> {
  let sawArgs: string[] = [];
  let sawEnv: Record<string, string> | undefined;
  let runCalled = false;
  const invoke = makeClaudeInvoker({
    ...(resolution?.toolProviders !== undefined ? { toolProviders: resolution.toolProviders } : {}),
    ...(resolution?.mcpServerConfigs !== undefined ? { mcpServerConfigs: resolution.mcpServerConfigs } : {}),
    // The wire feeds the constructed child env as the 4th arg (today it is called with 3 → undefined).
    run: (_bin, args, _bounds, env?: Record<string, string>) => {
      runCalled = true;
      sawArgs = args;
      sawEnv = env;
      return '{"text":"ok"}';
    },
  });
  const realization: Realization | undefined =
    venue === undefined ? undefined : realize(venue, { seats: [{ agent }], ambientEnv, gigId: "g1" });
  const ctx = { agent, gig_input: {}, inputs: [], realization, venue } as unknown as AgentInvocationContext;
  await invoke(ctx);
  const i = sawArgs.indexOf("--allowedTools");
  const allowedTools = i === -1 ? undefined : (sawArgs[i + 1]?.split(",") ?? []);
  const d = sawArgs.indexOf("--disallowedTools");
  const disallowedTools = d === -1 ? undefined : (sawArgs[d + 1]?.split(",") ?? []);
  return { allowedTools, disallowedTools, childEnv: sawEnv, runCalled };
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

describe("spawn reflects venue realization — the venue ceiling BINDS by denial (LAW 4, LAW 5)", () => {
  // Siblings to INV1-INV10. Where INV1-3/9 pin the ALLOW side (advertised == grants ∩ equipment), these
  // pin the DENY side: a granted-but-room-excluded tool must appear in --disallowedTools (so the room
  // narrows by ENFORCEMENT, not only by the omission from --allowedTools that cannot bind), and nothing
  // the room DOES admit may be denied. venueEffectiveTools is imported and called directly — the same
  // shared oracle R10 refuses against — never a re-inlined intersection (INV9 discipline).

  it("LAW 4 — a tool granted but NOT equipped by the room appears in --disallowedTools (RED pre-patch)", async () => {
    // Disjoint pools guarantee the strict case, as in INV2. GRANT_ONLY are non-host-builtin in-house
    // slugs so the ONLY thing that can put them in the deny list is the venue-exclusion path — not the
    // host-builtin complement — which isolates the claim to the venue ceiling. RED before the fix: on
    // the venue path the excluded tool is merely OMITTED from --allowedTools; nothing adds it to
    // --disallowedTools, so the ceiling does not bind by enforcement.
    const SHARED = ["Read", "Grep"], GRANT_ONLY = ["type_browse", "type_extend"], EQUIP_ONLY = ["Edit", "Glob"];
    await fc.assert(fc.asyncProperty(
      fc.subarray(SHARED, { minLength: 1 }), fc.subarray(GRANT_ONLY, { minLength: 1 }), fc.subarray(EQUIP_ONLY),
      async (shared, grantOnly, equipOnly) => {
        const grants = [...shared, ...grantOnly];
        const equipment = [...shared, ...equipOnly];
        const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
        const venue = room(equipment);
        const kept = new Set(venueEffectiveTools(agent, venue)); // the oracle, called directly
        const excluded = grants.filter((g) => !kept.has(g));
        const { disallowedTools } = await driveSpawn(agent, venue);
        const deny = new Set(disallowedTools ?? []);
        for (const g of excluded) expect(deny.has(g)).toBe(true); // granted-but-unequipped → denied
      }), { numRuns: 200 });
  });

  it("LAW 5 — NO over-denial: no venue-effective tool is denied, and every one is still advertised", async () => {
    // The paired guard on LAW 4: the deny synthesis must never touch a tool the room DOES admit. For any
    // agent×venue, (venueEffectiveTools ∩ --disallowedTools) = ∅, and every effective tool is still in
    // --allowedTools. This passes trivially pre-patch (empty deny list) and is the fix's structural
    // defence that narrowing-by-denial never over-reaches. output_write's survival on the seal path is
    // covered by LAW 2 in tests/invoker_cage.test.ts.
    await fc.assert(fc.asyncProperty(toolArb, toolArb, async (grants, equip) => {
      const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: grants });
      const venue = room(equip);
      const oracle = venueEffectiveTools(agent, venue);
      if (grants.length > 0 && oracle.length === 0) return; // fail-closed case, tested elsewhere
      const { allowedTools, disallowedTools } = await driveSpawn(agent, venue);
      const deny = new Set(disallowedTools ?? []);
      const adv = new Set(allowedTools ?? []);
      for (const t of oracle) {
        expect(deny.has(t)).toBe(false); // never denied…
        expect(adv.has(t)).toBe(true);   // …and still advertised
      }
    }), { numRuns: 200 });
  });
});

describe("spawn reflects venue realization — the venue path RESOLVES advertised names (#204)", () => {
  // Resolution ON: an in-house engine tool granted by BARE slug is bridged through the engine's own
  // MCP server, so the spawn must advertise it as `mcp__coltrane__<tool>` — the name the server
  // actually exposes. The two in-house tools below both resolve to the `coltrane` engine server.
  const inHouse = (tool: string): ToolProvider => ({ tool, kind: "in_house", server: "coltrane" });
  const PROVIDERS: ToolProviderRegistry = new Map<string, ToolProvider>([
    ["type_browse", inHouse("type_browse")],
    ["type_extend", inHouse("type_extend")],
  ]);
  // The engine server's --mcp-config entry must be PRESENT under its slug, else resolveToolGrants
  // keeps the bare name (the "no engine-server config → no regression" branch, tool_providers.ts:108).
  const MCP_CONFIGS: Record<string, unknown> = { coltrane: { command: "node", args: ["server_entry.js"] } };
  const withResolution = { toolProviders: PROVIDERS, mcpServerConfigs: MCP_CONFIGS };

  it("advertises the RESOLVED name for a bare in-house slug the venue equips (fails pre-patch)", async () => {
    // The exact defect gig 11744aa5 sealed. Agent grants bare `type_browse`; the room equips it.
    // Pre-patch (claude_invoker.ts venue branch) does `effectiveAllowed = venueEffectiveTools(...)`,
    // OVERWRITING the resolved names with the raw grant strings — so --allowedTools carries bare
    // `type_browse` and the resolved `mcp__coltrane__type_browse` is ABSENT, the server advertises
    // only the namespaced name, and the call is DENIED ('Claude requested permissions to use
    // mcp__coltrane__type_browse, but you haven't granted it yet.'). Post-patch narrows THEN resolves.
    const agent = testAgent({ slug: "prober", primitives: ["SENSE"], allowed_tools: ["type_browse"] });
    const venue = room(["type_browse"]);
    const { allowedTools } = await driveSpawn(agent, venue, {}, withResolution);
    const advertised = new Set(allowedTools ?? []);
    expect(advertised.has("mcp__coltrane__type_browse")).toBe(true); // the name the server advertises
    expect(advertised.has("type_browse")).toBe(false); // the bare slug the server never matches
  });

  it("the ceiling did NOT widen — a granted-but-UNEQUIPPED tool is absent in BOTH bare and mcp__ form", async () => {
    // The narrow-then-rename guard. Agent grants two in-house tools; the room equips only one. If a
    // future edit ever RENAMED-THEN-WIDENED (resolved the full grant set instead of the narrowed one),
    // the unequipped `type_extend` would reappear as `mcp__coltrane__type_extend`. Asserting BOTH forms
    // absent — with resolution ON, so the mcp__ form is the one a widen regression would actually emit —
    // fails loudly on that regression while passing on the correct narrow-then-rename path.
    const agent = testAgent({ slug: "prober", primitives: ["SENSE"], allowed_tools: ["type_browse", "type_extend"] });
    const venue = room(["type_browse"]); // equips type_browse, NOT type_extend
    const { allowedTools } = await driveSpawn(agent, venue, {}, withResolution);
    const advertised = new Set(allowedTools ?? []);
    expect(advertised.has("mcp__coltrane__type_browse")).toBe(true); // the equipped tool survives, resolved
    expect(advertised.has("type_extend")).toBe(false); // unequipped: never in bare form
    expect(advertised.has("mcp__coltrane__type_extend")).toBe(false); // and never renamed-then-widened in
  });
});

describe("spawn reflects venue realization — the seat env admits USER (macOS keychain auth)", () => {
  it("SEAT_ENV_ALLOWLIST admits USER from the ambient env, credential-shaped vars stay absent, grows by exactly one key", () => {
    // Defect 2. macOS Claude auth is keychain-backed and the lookup needs USER; under {PATH,HOME}
    // `claude -p` exits 1 'Not logged in', under {PATH,HOME,USER} it exits 0 (gig 4506b567). USER is a
    // USERNAME not a credential, so admitting it does not weaken deny-by-default. Pre-patch the
    // allowlist is ['PATH','HOME'], so seat.env.USER is undefined and this FAILS.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const ambientEnv: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin",
      HOME: process.env["HOME"] ?? "/tmp",
      USER: "seat-runner",
      COLTRANE_TEST_KEYCHAIN_TOKEN: "leak-me", // credential-shaped decoy: must NOT be admitted
    };
    const r = realize(room(["Read"]), { seats: [{ agent }], ambientEnv, gigId: "g-user" });
    if (!r.ok) throw new Error("realize refused a sound room");
    const seat = r.seats.find((s) => s.agent_slug === "p")!;
    expect(seat.env["USER"]).toBe("seat-runner"); // admitted from the ambient env
    expect(seat.env["COLTRANE_TEST_KEYCHAIN_TOKEN"]).toBeUndefined(); // credential-shaped → still denied
    // The allowlist grew by EXACTLY one non-secret key over the prior ['PATH','HOME'].
    expect([...SEAT_ENV_ALLOWLIST].sort()).toEqual(["HOME", "PATH", "USER"]);
  });
});

describe("spawn reflects venue realization — the seat env EXECUTES (INV-EXEC)", () => {
  it("INV-EXEC — the constructed seat env can actually RUN a binary (no spawn ENOENT)", () => {
    // The law the empty-env posture could never satisfy. Take the env the invoker hands the spawn —
    // SeatRealization.env, built by realize() from the ambient env — and RUN a real OS process
    // through it. Before the allowlist fix seat.env is `{}`: no PATH, so the OS cannot locate the
    // binary and spawnSync fails with ENOENT — the EXACT failure measured on gig 87cffa2c. Asserting
    // the env merely CONTAINS a PATH key would be the same could-not-fail shape the old INV4/INV5
    // were; this executes, because "the env looks right" is precisely what a dead seat's env also
    // looked like. The binary is spawned by BARE NAME so lookup goes through seat.env's PATH (an
    // absolute path would resolve without PATH and make the law a tautology); the ambient PATH is
    // seeded with the node binary's own directory so it resolves once PATH survives the allowlist.
    const nodeBin = basename(process.execPath); // bare name → resolved via the seat env's PATH
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const ambientEnv: Record<string, string> = {
      PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: process.env["HOME"] ?? "/tmp",
      COLTRANE_TEST_EXEC_SECRET: "leak-me", // a credential-shaped decoy that must not survive
    };
    const r = realize(room(["Read"]), { seats: [{ agent }], ambientEnv, gigId: "g-exec" });
    if (!r.ok) throw new Error("realize refused a sound room");
    const seat = r.seats.find((s) => s.agent_slug === "p")!;
    const res = spawnSync(nodeBin, ["-e", ""], { env: seat.env });
    // Found through the seat env's PATH (not ENOENT) and ran to a clean exit.
    expect((res.error as NodeJS.ErrnoException | undefined)?.code).not.toBe("ENOENT");
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    // Deny-by-default survives the widening that made the seat spawnable: the decoy never reached it.
    expect(seat.env["COLTRANE_TEST_EXEC_SECRET"]).toBeUndefined();
  });
});

describe("spawn reflects venue realization — the child env allowlist (INV4,5)", () => {
  // The credential-shaped vars carried IN THE AMBIENT ENV the room is realized against — the filter
  // must drop every one of them while keeping the allowlisted PATH/HOME.
  const CREDS = ["COLTRANE_TEST_OPENAI_KEY", "COLTRANE_TEST_AWS_SECRET", "COLTRANE_TEST_UNDECLARED_TOKEN"];
  const ambient = (): Record<string, string> => ({
    PATH: process.env["PATH"] ?? "/usr/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    ...Object.fromEntries(CREDS.map((k) => [k, "leak-me"])),
  });

  // WHY these no longer assert emptiness. The old INV4/INV5 realized against `ambientEnv: {}` and
  // asserted the child env EXCLUDED credentials. An allowlist filter over `{}` yields `{}` no matter
  // what the filter is, so the exclusion held VACUOUSLY — a law that could not fail — while the seat
  // carried no PATH and could not spawn at all (`spawn claude ENOENT`, gig 87cffa2c). Realizing
  // against a NON-EMPTY ambient env carrying credential-shaped vars makes the filter do real work:
  // it must both KEEP the allowlisted PATH/HOME (so the seat can execute) AND DROP the credentials
  // (deny-by-default). Emptiness satisfied the absence assertion by carrying nothing; the allowlist
  // satisfies it by carrying only what a process needs to run.

  it("INV5 — an undeclared ambient secret is ABSENT from the child env, while PATH/HOME survive", async () => {
    // A venue whose surface declares SOME class but not the injected token: the token is undeclared
    // and must not reach the child, yet the allowlisted PATH/HOME must — or the seat cannot spawn.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const venue = room(["Read"], ["vercel-token"]); // surface is non-empty but excludes the injected secret
    const env = ambient();
    const { childEnv } = await driveSpawn(agent, venue, env);
    expect(childEnv).toBeDefined(); // an explicit allowlist object, not undefined (== full inherit)
    expect(childEnv!["COLTRANE_TEST_UNDECLARED_TOKEN"]).toBeUndefined(); // undeclared → filtered out
    expect(childEnv!["PATH"]).toBe(env.PATH); // allowlisted → carried, so the seat can execute
    expect(childEnv!["HOME"]).toBe(env.HOME);
  });

  it("INV4 — an EMPTY credential_surface admits ZERO ambient credentials, PATH/HOME still present", async () => {
    // Deny-by-default: an empty surface is a subset floor — no ambient credential-shaped var may
    // appear in the child env — but the allowlisted execute-minimum is not a credential and stays.
    const agent = testAgent({ slug: "p", primitives: ["SENSE"], allowed_tools: ["Read"] });
    const env = ambient();
    const { childEnv } = await driveSpawn(agent, room(["Read"], []), env);
    expect(childEnv).toBeDefined();
    for (const k of CREDS) expect(childEnv![k]).toBeUndefined(); // none survive the allowlist
    expect(childEnv!["PATH"]).toBe(env.PATH); // still spawnable
    expect(childEnv!["HOME"]).toBe(env.HOME);
  });
});
