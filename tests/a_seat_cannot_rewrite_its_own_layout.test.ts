// NO SELF-WIDENING — A SEAT CAN NEVER WRITE THE LAYOUT THAT GRANTS IT.
//
// The layout file lives in the tree the seat edits. A seat granted `Write(@source)` in a repository
// whose source is `**` could rewrite coltrane.layout.json, and every later gig against that tree would
// be seated under the layout the seat wrote for itself. Authority that can author its own ceiling has
// no ceiling.
//
// THE FORM (named once, here and in the red-spec): a DENY. A glob such as `**` cannot be expressed
// "minus one file" in the CLI's permission syntax, so the resolver returns `denials` —
// `Write(coltrane.layout.json)` and `Edit(coltrane.layout.json)` — whenever a Write/Edit grant the seat
// holds covers the layout file, AND never returns the exact grant `Write(coltrane.layout.json)` (a
// target_paths entry naming the file is dropped). Both halves matter: the Claude invoker's NO
// OVER-DENIAL filter removes a scoped deny when an EXACT grant of the same string is present, so a
// deny beside an exact grant would be silently deleted before the spawn.
//
//   law                                          kind         drives                                      plant
//   ** source → the layout file is denied        behavioural  resolveSeatGrants — src/layout_grants.ts    remove the layout-file exclusion (denials: [])
//   bare Write → denied too                      behavioural  same                                        only deny for globs, not bare Write/Edit
//   a target naming the file is dropped          behavioural  same                                        keep Write(<target>) when the target is the
//                                                                                                         layout file
//   the spawn cannot write it (argv)             behavioural  makeClaudeInvoker(...) — src/claude_invoker  omit resolveSeatGrants().denials from the
//                                                                                                         --disallowedTools union
//   …even when targeted (argv)                   behavioural  same                                        same, or keep the exact grant so the
//                                                                                                         over-denial filter drops the deny
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants, LAYOUT_FILE, type Layout } from "./layout_grants_fixtures.js";

const WIDE: Layout = { paths: { source: ["**"] } };
const DENY_WRITE = `Write(${LAYOUT_FILE})`;
const DENY_EDIT = `Edit(${LAYOUT_FILE})`;

const writer = (allowed_tools: string[]) =>
  testAgent({ slug: "writer", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools, code_tool_access: "full" } as never);

async function spawnFlags(agent: Agent, over: Record<string, unknown>): Promise<{ spawned: boolean; allowed: string[]; disallowed: string[]; error: string }> {
  let args: string[] | undefined;
  const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
  let error = "";
  try {
    await invoke({ agent, phase: "build", inputs: [], gig_input: { request_text: "x" }, ...over } as unknown as AgentInvocationContext);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  const flag = (n: string) => { const i = (args ?? []).indexOf(n); return i >= 0 && args![i + 1] ? args![i + 1]!.split(",") : []; };
  return { spawned: args !== undefined, allowed: flag("--allowedTools"), disallowed: flag("--disallowedTools"), error };
}

describe("no self-widening — the layout file is never writable by a seat", () => {
  it("a source of ** : the resolver denies Write and Edit of the layout file beside the grant", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: writer(["Read", "Write(@source)", "Edit(@source)"]), layout: WIDE });
    expect(r.grants, "non-vacuity: the ** grant itself is held").toContain("Write(**)");
    expect(r.denials, "a ** source can rewrite the layout that granted it").toEqual(expect.arrayContaining([DENY_WRITE, DENY_EDIT]));
    expect(r.grants).not.toContain(DENY_WRITE);
  });

  it("a BARE Write literal reaches every file — the layout file is denied for it too", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: writer(["Read", "Write"]) });
    expect(r.grants, "the literal is unchanged (RED-DEF-14)").toEqual(["Read", "Write"]);
    expect(r.denials, "a bare Write can rewrite the layout file").toContain(DENY_WRITE);
  });

  it("a change whose target_paths NAME the layout file does not get a grant for it", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: writer(["Write(@source)"]), layout: WIDE, target_paths: [LAYOUT_FILE, "src/a.ts"] });
    expect(r.grants, "non-vacuity: the other target is granted").toContain("Write(src/a.ts)");
    expect(r.grants, "a target_paths entry handed the seat its own layout file").not.toContain(DENY_WRITE);
    expect(r.denials).toContain(DENY_WRITE);
  });

  it("the spawn: --disallowedTools carries the layout-file denials beside Write(**), and --allowedTools holds no exact grant that would cancel them", async () => {
    const { spawned, allowed, disallowed, error } = await spawnFlags(writer(["Read", "Write(@source)", "Edit(@source)"]), { layout: WIDE });
    expect(spawned, `the invoker never reached the spawn: ${error}`).toBe(true);
    expect(allowed, "non-vacuity: the ** source reached the spawn").toContain("Write(**)");
    expect(disallowed, "the spawn can write coltrane.layout.json").toEqual(expect.arrayContaining([DENY_WRITE, DENY_EDIT]));
    expect(allowed).not.toContain(DENY_WRITE);
    expect(allowed).not.toContain(DENY_EDIT);
  });

  it("the spawn, targeted at the layout file: still denied, still no exact grant", async () => {
    const { spawned, allowed, disallowed, error } = await spawnFlags(writer(["Write(@source)"]), {
      layout: WIDE, gig_input: { request_text: "x", target_paths: [LAYOUT_FILE, "src/a.ts"] },
    });
    expect(spawned, `the invoker never reached the spawn: ${error}`).toBe(true);
    expect(allowed).toContain("Write(src/a.ts)");
    expect(allowed, "the spawn was granted its own layout file").not.toContain(DENY_WRITE);
    expect(disallowed).toContain(DENY_WRITE);
  });
});
