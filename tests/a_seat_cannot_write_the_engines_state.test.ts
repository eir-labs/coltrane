// NO GRANT REACHES THE ENGINE'S OWN STATE — `.coltrane/` is denied exactly like the layout file.
//
// The conductor's ruling (26 Sep, round 4). The engine writes `<tree>/.coltrane/` while a seat runs (the
// gig ledger, repo locks, checkpoints, gig logs), so the diff gate cannot judge changes there — it would
// blame the seat for the engine's own spend rows. The Bash sandbox already denies `.coltrane` to Bash.
// That left ONE way in: a Write/Edit grant whose glob covers `.coltrane/…` (a `**` source, a bare Write,
// code_tool_access write/full). A seat holding one could rewrite the ledger or a lock and the gate would
// exempt it by design. So the resolver denies it the same way it denies the layout file: `denials` carries
// `Write(.coltrane/**)` and `Edit(.coltrane/**)` whenever a Write/Edit the seat holds covers a path under
// `.coltrane/`, no target_paths entry under `.coltrane/` is ever granted, and the Claude invoker puts the
// denials on --disallowedTools (where the NO OVER-DENIAL filter keeps them beside a `Write(**)`).
//
//   law                                                 kind         drives                                   plant
//   a ** source → .coltrane/** denied                    behavioural  resolveSeatGrants — src/layout_grants.ts  drop the .coltrane denial (a ** grant then
//                                                                                                               reaches .coltrane)
//   a bare Write / code_tool_access full → denied        behavioural  same                                     deny only for scoped grants
//   a target under .coltrane/ is never granted           behavioural  same                                     keep Write(<target>) for .coltrane/ targets
//   a src/** seat gets no .coltrane denial it doesn't    behavioural  same                                     deny .coltrane for every seat (over-denial is
//   need (the deny follows reach, like the layout's)                                                        harmless but hides a missing reach check)
//   the spawn carries the denials beside Write(**)       behavioural  makeClaudeInvoker(...) argv — src/claude_    omit the .coltrane denials from --disallowedTools
//                                                                    invoker.ts
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { loadLayoutGrants, type Layout } from "./layout_grants_fixtures.js";

const WIDE: Layout = { paths: { source: ["**"] } };
const SRC: Layout = { paths: { source: ["src/**"] } };
const DENY_W = "Write(.coltrane/**)";
const DENY_E = "Edit(.coltrane/**)";

const seat = (allowed_tools: string[], code_tool_access?: string) =>
  testAgent({ slug: "writer", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools, ...(code_tool_access ? { code_tool_access } : {}) } as never);

describe("no Write/Edit grant reaches .coltrane/", () => {
  it("a ** source: denials carry Write(.coltrane/**) and Edit(.coltrane/**)", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Read", "Write(@source)", "Edit(@source)"]), layout: WIDE });
    expect(r.grants, "non-vacuity: the ** grant is held").toContain("Write(**)");
    expect(r.denials, "a ** grant can rewrite the engine's ledger and locks").toEqual(expect.arrayContaining([DENY_W, DENY_E]));
  });

  it("a bare Write literal (no code_tool_access) is denied .coltrane too", async () => {
    const L = await loadLayoutGrants();
    expect(L.resolveSeatGrants({ agent: seat(["Read", "Write"]) }).denials).toContain(DENY_W);
  });

  it("code_tool_access \"full\" with no Write grant is denied .coltrane too", async () => {
    const L = await loadLayoutGrants();
    expect(L.resolveSeatGrants({ agent: seat(["Read"], "full") }).denials).toEqual(expect.arrayContaining([DENY_W, DENY_E]));
  });

  it("a target_paths entry under .coltrane/ is never granted — not even to a bare Write, which covers every path", async () => {
    // A bare Write is used because it covers EVERY path by construction; a `**` glob would make this law
    // hinge on whether the glob engine matches dot-directories (node's matchesGlob does not), which is
    // not the property under test.
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Write"]), target_paths: [".coltrane/ledger.jsonl", "src/a.ts"] });
    expect(r.grants, "non-vacuity: the plain target is granted").toContain("Write(src/a.ts)");
    expect(r.grants.filter((g) => g.includes(".coltrane")), "a target handed the seat the engine's state").toEqual([]);
  });

  it("a src/** seat, which cannot reach .coltrane/, carries no .coltrane denial (the deny follows reach)", async () => {
    const L = await loadLayoutGrants();
    const r = L.resolveSeatGrants({ agent: seat(["Read", "Write(@source)"]), layout: SRC });
    expect(r.denials.filter((d) => d.includes(".coltrane"))).toEqual([]);
  });

  it("the spawn: --disallowedTools carries both denials beside Write(**)", async () => {
    let args: string[] = [];
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    try {
      await invoke({ agent: seat(["Read", "Write(@source)", "Edit(@source)"], "full") as Agent, phase: "build", inputs: [], gig_input: { request_text: "x" }, layout: WIDE, tree_root: "/srv/t" } as unknown as AgentInvocationContext);
    } catch { /* only the argv matters */ }
    const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1]!.split(",") : []; };
    expect(flag("--allowedTools"), "non-vacuity: Write(**) reached the spawn").toContain("Write(**)");
    expect(flag("--disallowedTools"), "the spawn can write the engine's .coltrane/ through its Write grant").toEqual(expect.arrayContaining([DENY_W, DENY_E]));
  });
});
