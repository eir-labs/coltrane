// THE SANDBOX'S TREE IS ALWAYS ABSOLUTE, AND EVERY WAY A SEAT HOLDS BASH IS SANDBOXED.
//
// Two wires survived the implementer's mutation run:
//   · A RELATIVE tree. The CLI SILENTLY IGNORES relative sandbox paths (the conductor's measurement), so a
//     relative ctx.tree_root passed through unresolved produces denies that read correctly and enforce
//     nothing. Every D2 law used an absolute tree, so nothing could see it. The invoker must resolve a
//     relative tree to an absolute one or refuse the seat — it may never EMIT a relative sandbox path.
//   · Bash NOT granted but KEPT by code_tool_access "full". The cage keeps bare Bash for such a seat
//     (claude_invoker.ts codeToolsKept), so the seat can run Bash exactly as a granted seat can, and must
//     be sandboxed exactly the same.
//
//   law                                              kind         drives                                     plant
//   a relative tree_root → absolute paths or refusal  behavioural  makeClaudeInvoker(...)(ctx) argv via the   pass ctx.tree_root through unresolved (and drop
//                                                                  run seam — src/claude_invoker.ts           bashSandboxFor's absolute check)
//   a relative room workspace → absolute or refusal   behavioural  same, with ctx.seatExec                     same, for seatExec.workspace
//   code_tool_access "full" Bash is sandboxed         behavioural  same                                       compute "seat holds Bash" from the granted
//                                                                                                              tools only, ignoring code_tool_access
import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { settingsOf, LAYOUT_FILE } from "./layout_grants_fixtures.js";

async function spawn(agent: Agent, over: Record<string, unknown>): Promise<{ args: string[] | undefined; error: string }> {
  let args: string[] | undefined;
  const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
  let error = "";
  try {
    await invoke({ agent, phase: "build", inputs: [], gig_input: { request_text: "x" }, layout: { commands: { laws: ["npx vitest run"] } }, ...over } as unknown as AgentInvocationContext);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  return { args, error };
}
type Sandbox = { enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown; excludedCommands?: unknown; filesystem?: Record<string, unknown> };
const sandboxOf = (args: string[]): Sandbox | undefined => settingsOf(args)[0]?.["sandbox"] as Sandbox | undefined;
const fsPaths = (sb: Sandbox | undefined): string[] =>
  Object.values(sb?.filesystem ?? {}).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));

const basher = (over: Record<string, unknown> = {}) =>
  testAgent({ slug: "builder", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools: ["Read", "Bash(@laws)"], ...over } as never);

describe("a relative tree never becomes a relative sandbox path", () => {
  for (const [what, over] of [
    ["a relative tree_root", { tree_root: "relative/tree-that-does-not-exist" }],
    ["a ./-relative tree_root", { tree_root: "./relative/tree" }],
    ["a relative room workspace", { seatExec: { container: "room-1", workspace: "workspace/g1" } }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`${what}: the seat spawns with ABSOLUTE sandbox paths, or is refused before the spawn`, async () => {
      const { args, error } = await spawn(basher(), over);
      if (args === undefined) {
        expect(error, "refused, but for no stated reason").toMatch(/\S/);
        return;
      }
      const paths = fsPaths(sandboxOf(args));
      expect(paths.length, "the seat spawned holding Bash with no sandbox paths at all").toBeGreaterThan(0);
      const relative = paths.filter((p) => !isAbsolute(p));
      expect(relative, `a relative sandbox path reached the spawn — the CLI ignores it, so the deny is not enforced: ${JSON.stringify(relative)}`).toEqual([]);
      expect(paths.some((p) => p.endsWith(`/${LAYOUT_FILE}`)), "non-vacuity: the layout deny is present").toBe(true);
    });
  }
});

describe("Bash kept by code_tool_access \"full\" is sandboxed exactly like granted Bash", () => {
  it("a seat with NO Bash grant but code_tool_access \"full\" spawns sandboxed, fail-closed, no hatch, with the same denies", async () => {
    const TREE = "/srv/coltrane-tree/cta";
    const granted = await spawn(basher(), { tree_root: TREE });
    const kept = await spawn(testAgent({ slug: "builder", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools: ["Read"], code_tool_access: "full" } as never), { tree_root: TREE });
    expect(kept.args, `the kept-Bash seat never reached the spawn: ${kept.error}`).toBeDefined();
    const k = sandboxOf(kept.args!);
    expect(k, "a seat that can run Bash through code_tool_access spawned with NO sandbox").toBeDefined();
    expect(k!.enabled).toBe(true);
    expect(k!.failIfUnavailable).toBe(true);
    expect(k!.allowUnsandboxedCommands).toBe(false);
    expect(k!.filesystem, "the kept-Bash sandbox differs from the granted-Bash sandbox over the same tree").toEqual(sandboxOf(granted.args!)?.filesystem);
  });
});
