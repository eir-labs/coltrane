// THE LAST INCH — BOTH INVOKERS GRANT THROUGH THE LAYOUT.
//
// resolveSeatGrants can be perfect and change nothing: the Claude invoker builds `--allowedTools` from
// `ctx.agent.allowed_tools` (src/claude_invoker.ts, the grant block after `resolutionEnabled` and the venue
// confinement block), and the completions invoker builds its offered set from `chairGrants`
// (src/completions_invoker.ts). A resolver neither calls is a function with passing unit laws and no
// callers — the defect this repo's CLAUDE.md names first. So these laws drive each invoker's REAL grant
// assembly through the seams the existing suite already observes them by:
//   · Claude: the injected `run` seam, which receives the exact argv the CLI would be spawned with
//     (same instrument as tests/spec_scoped_deny_beside_scoped_grant.test.ts).
//   · Completions: the model request's `tools` and its typed refusals, before any network call
//     (same instrument as tests/spec_completions_invoker.test.ts LAW 2).
// The layout reaches the invocation as ctx.layout (threaded by runGig from RunDeps.layout); the
// change-request's target_paths reach it where the payload already does — ctx.gig_input.target_paths.
//
//   law                                                   kind         drives                                           plant
//   Claude: --allowedTools is the resolved, narrowed set  behavioural  makeClaudeInvoker(...) — src/claude_invoker.ts   build effectiveAllowed from ctx.agent.allowed_tools
//                                                                                                                     instead of resolveSeatGrants(...).grants
//   Claude: no role token reaches either flag (venue)     behavioural  same (the venueExcluded / disallow computation)  compute venueExcluded from agent.allowed_tools
//                                                                                                                     (raw tokens) instead of the expanded grants
//   Claude: a missing role refuses before the spawn       behavioural  same                                             ignore resolveSeatGrants().refusals in the invoker
//   Completions: a Write narrowed away is not offered     behavioural  makeCompletionsInvoker(...) — src/completions_  compute chairGrants from ctx.agent.allowed_tools
//                                                                      invoker.ts                                       instead of resolveSeatGrants(...).grants
//   Completions: ANY scoped grant refuses (5 shapes)      behavioural  same                                             refuse only scoped Write/Edit (let mapGrant strip
//                                                                                                                     the scope from Read/Bash and offer them bare)
//   Completions: a missing role refuses, no model call    behavioural  same                                             ignore resolveSeatGrants().refusals in the invoker
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, createRegistry, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { loadCompletions, fakeCompletions, saysJson, recordingTools } from "./spec_completions_fixtures.js";
import { room, type Layout } from "./layout_grants_fixtures.js";

const LAYOUT: Layout = {
  paths: { source: ["src/**", "lib/**"], tests: ["tests/**"] },
  commands: { laws: ["npx vitest run"] },
};
const TARGETS = ["src/a.ts", "docs/x.md"];

const implementer = testAgent({
  slug: "implementer", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)", "Bash(@laws)"],
  code_tool_access: "full",
} as never);

function ctx(agent: Agent, over: Record<string, unknown> = {}): AgentInvocationContext {
  return { agent, phase: "build", inputs: [], gig_input: { request_text: "fix a", target_paths: TARGETS }, layout: LAYOUT, ...over } as unknown as AgentInvocationContext;
}

async function spawnFlags(c: AgentInvocationContext): Promise<{ spawned: boolean; allowed: string[]; disallowed: string[]; error: string }> {
  let args: string[] | undefined;
  const invoke = makeClaudeInvoker({
    toolProviders: new Map(),
    mcpServerConfigs: {},
    run: (_bin, a) => {
      args = a;
      return "{}";
    },
  });
  let error = "";
  try {
    await invoke(c);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  const flag = (name: string) => {
    const i = (args ?? []).indexOf(name);
    return i >= 0 && args![i + 1] ? args![i + 1]!.split(",") : [];
  };
  return { spawned: args !== undefined, allowed: flag("--allowedTools"), disallowed: flag("--disallowedTools"), error };
}

describe("the Claude invoker grants through resolveSeatGrants", () => {
  it("--allowedTools carries the role tokens EXPANDED by ctx.layout and NARROWED by gig_input.target_paths", async () => {
    const { spawned, allowed, error } = await spawnFlags(ctx(implementer));
    expect(spawned, `the invoker never reached the spawn: ${error}`).toBe(true);
    expect(allowed, "the source role was not expanded and narrowed to the covered target").toContain("Write(src/a.ts)");
    expect(allowed).toContain("Edit(src/a.ts)");
    expect(allowed, "the laws command did not reach the spawn").toContain("Bash(npx vitest run:*)");
    expect(allowed).toContain("Read");
    expect(allowed.filter((g) => g.includes("@")), "a role token reached --allowedTools unexpanded").toEqual([]);
    expect(allowed, "the whole source glob reached a one-file change's spawn").not.toContain("Write(src/**)");
    expect(allowed, "a glob no target falls under reached the spawn").not.toContain("Write(lib/**)");
    expect(allowed, "a target outside source reached the spawn").not.toContain("Write(docs/x.md)");
  });

  it("in a room that does not equip Bash, no role token reaches EITHER flag and the laws command is not allowed", async () => {
    const venue = room(["Read", "Write", "Edit"]);
    const { spawned, allowed, disallowed, error } = await spawnFlags(ctx(implementer, { venue, realization: { seats: [] } }));
    expect(spawned, `the invoker never reached the spawn: ${error}`).toBe(true);
    expect(allowed).toContain("Write(src/a.ts)");
    expect(allowed.some((g) => g.startsWith("Bash")), "the room excluded Bash and the seat still holds it").toBe(false);
    expect([...allowed, ...disallowed].filter((g) => g.includes("@")), "a raw role token reached the spawn's flags").toEqual([]);
  });

  it("a role the layout does not declare refuses the chair naming it — nothing is spawned", async () => {
    const migrator = testAgent({ slug: "migrator", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools: ["Read", "Write(@migrations)"] });
    const { spawned, allowed, error } = await spawnFlags(ctx(migrator));
    expect(spawned, `a seat was spawned holding an unanswerable role token (allowed: ${allowed.join(",")})`).toBe(false);
    expect(error, "the refusal does not name the missing role").toMatch(/migrations/);
  });

  it("NO layout on the invocation: a role token refuses the chair naming the role — never a ** default", async () => {
    const { spawned, allowed, error } = await spawnFlags(ctx(implementer, { layout: undefined }));
    expect(spawned, `a seat was spawned with role tokens and no layout (allowed: ${allowed.join(",")})`).toBe(false);
    expect(error).toMatch(/source/);
  });
});

describe("the completions invoker grants through resolveSeatGrants — and fails closed on ANY scoped grant", () => {
  // The completions invoker offers the model `listed ∩ allow`, where allow is its chair grants mapped to
  // tool names — and mapGrant keeps only a grant's BASE: `Write(src/a.ts)` would be offered as `Write`,
  // the whole tree. The scope cannot survive this invoker, so (the founder's ruling) a chair whose
  // EFFECTIVE grants hold any path-scoped Write/Edit, literal or expanded, is refused before any model
  // call, naming the grant. A bare unscoped Write is untouched here (it is refused as a host builtin, as
  // today). A chair whose scoped writes all resolve away runs, and is not offered Write.
  // The source lists every tool the agent could name, so nothing is refused for being unprovided.
  const TOOL_DEFS = [
    { name: "mcp__s__read", inputSchema: { type: "object" } },
    { name: "mcp__coltrane__Write", inputSchema: { type: "object" } },
    { name: "mcp__coltrane__Edit", inputSchema: { type: "object" } },
    { name: "mcp__coltrane__Read", inputSchema: { type: "object" } },
    { name: "mcp__coltrane__Bash", inputSchema: { type: "object" } },
  ];
  const registry = createRegistry();
  registry.registerType({ slug: "built-thing", extends: "Artifact", domain: "demo", schema: { properties: {} }, required_fields: [] } as never);
  const opts = (fetchFn: typeof fetch) => ({
    baseUrl: "https://endpoint.test/v1", apiKey: "k", registry,
    tierMap: { standard: "served-std", economy: "served-x", premium: "served-p" }, fetchFn,
    tools: recordingTools(TOOL_DEFS).source,
  });
  const reader = (allowed_tools: string[]) =>
    testAgent({ slug: "reader", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", model_tier: "economy", allowed_tools } as never);
  const offered = (calls: { body: Record<string, unknown> }[]): string => JSON.stringify(calls[0]?.body["tools"] ?? []);

  it("control — a chair holding only UNSCOPED grants still runs under a layout and target_paths, offered its MCP tools", async () => {
    const C = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({})]);
    const res = (await C.makeCompletionsInvoker(opts(fn))(ctx(reader(["mcp__s__read"])))) as Record<string, unknown>;
    expect(calls.length, `a chair with no scoped write was refused: ${JSON.stringify(res)}`).toBeGreaterThan(0);
    expect(offered(calls)).toMatch(/read/);
  });

  it("a target_paths set the source glob never covers: Write(@source) resolves to nothing — the chair runs, and is NOT offered Write", async () => {
    const C = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({})]);
    const res = (await C.makeCompletionsInvoker(opts(fn))(ctx(reader(["mcp__s__read", "Write(@source)"]), { gig_input: { target_paths: ["docs/x.md"] } }))) as Record<string, unknown>;
    expect(calls.length, `the chair made no model call: ${JSON.stringify(res)}`).toBeGreaterThan(0);
    expect(offered(calls), "the completions invoker offered the model a Write the change's target_paths never reached").not.toMatch(/Write/);
    expect(offered(calls), "non-vacuity: the MCP read tool is still offered").toMatch(/read/);
  });

  // ROUND 3 (the founder's fail-closed ruling, generalised by the conductor): mapGrant strips the scope
  // from EVERY grant — `Bash(npm test:*)` would be offered as the whole of Bash, `Read(src/**)` as the
  // whole of Read. So a chair whose effective grants hold ANY scoped grant is refused, naming it, before
  // any model call. The source lists a Write, Edit, Read and Bash tool, so nothing below is refused for
  // being unprovided: only the scope refusal can stop the call.
  const SCOPED: Array<[string, string[], Record<string, unknown>, string]> = [
    ["an EXPANDED scoped Write (Write(@source) → Write(src/a.ts))", ["mcp__s__read", "Write(@source)"], { gig_input: { target_paths: ["src/a.ts"] } }, "Write(src/a.ts)"],
    ["a LITERAL scoped Edit (Edit(src/**))", ["mcp__s__read", "Edit(src/**)"], { layout: undefined, gig_input: { request_text: "x" } }, "Edit(src/**)"],
    ["a LITERAL scoped Read (Read(src/**))", ["mcp__s__read", "Read(src/**)"], { layout: undefined, gig_input: { request_text: "x" } }, "Read(src/**)"],
    ["a LITERAL scoped Bash (Bash(npm test:*))", ["mcp__s__read", "Bash(npm test:*)"], { layout: undefined, gig_input: { request_text: "x" } }, "Bash(npm test:*)"],
    ["an EXPANDED scoped Bash (Bash(@laws) → Bash(npx vitest run:*))", ["mcp__s__read", "Bash(@laws)"], {}, "Bash(npx vitest run:*)"],
  ];
  for (const [what, grants, over, named] of SCOPED) {
    it(`${what} refuses the chair naming the grant, before any model call`, async () => {
      const C = await loadCompletions();
      const { fn, calls } = fakeCompletions([saysJson({})]);
      const res = (await C.makeCompletionsInvoker(opts(fn))(ctx(reader(grants), over))) as Record<string, unknown>;
      expect(calls, `${named} reached the model as an unscoped tool`).toHaveLength(0);
      expect(res["ok"]).toBe(false);
      expect(String(res["message"]), "the refusal does not name the scoped grant").toContain(named);
    });
  }

  it("a role the layout does not declare is refused naming it, before any model call", async () => {
    const C = await loadCompletions();
    const { fn, calls } = fakeCompletions([saysJson({})]);
    const res = (await C.makeCompletionsInvoker(opts(fn))(ctx(reader(["mcp__s__read", "Write(@migrations)"])))) as Record<string, unknown>;
    expect(calls, "a model call was made for a chair holding an unanswerable role token").toHaveLength(0);
    expect(res["ok"]).toBe(false);
    expect(String(res["message"]), "the refusal does not name the missing role").toMatch(/migrations/);
  });
});
