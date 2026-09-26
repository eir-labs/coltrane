// THE CHAIR RECORDS ITS RESOLVED GRANTS — and the layout reaches the chair from the tree it runs against.
//
// "Recorded. The resolved grant set is part of the chair's record, so the reason a seat could or couldn't
// write a path is auditable afterwards." The chair's record is `chair_complete` (src/runtime.ts): the
// event every door's progress sink receives and the gig log tees, which already records what the seat
// ran AT (effort, session_id). It must now record what the seat ran WITH: `resolved_grants`, and
// `target_paths_applied` — so a run with no target_paths says so rather than reading as narrowed.
//
// And a record of grants resolved against no layout would be a faithful record of the wrong thing. So the
// last law runs the DISPATCH DOOR end to end: a genome tree on disk carrying coltrane.layout.json is
// bootstrapped the way `coltrane dispatch --genome <tree>` bootstraps it, and the chair's invocation must
// carry that tree's layout.
//
//   law                                          kind         drives                                     plant
//   chair_complete carries resolved_grants        behavioural  runGig — src/runtime.ts                    drop resolved_grants from the chair_complete emit
//   …and target_paths_applied, both ways          behavioural  same                                       record target_paths_applied: true unconditionally
//   the layout reaches the chair's invocation     behavioural  runGig — src/runtime.ts                    omit `layout` from the deps.invoke ctx
//   the dispatch door carries the tree's layout   behavioural  bootstrapServerDeps + dispatchTool          omit `layout` from the assembleRunDeps call in
//                                                              ("gig_dispatch") — src/server.ts           server.ts's dispatch door
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type GigProgressEvent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { genomeTree, IMPLEMENTER_FILE, type Layout } from "./layout_grants_fixtures.js";

const LAYOUT: Layout = { paths: { source: ["src/**", "lib/**"] }, commands: { laws: ["npx vitest run"] } };

const implementer = testAgent({
  slug: "implementer", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Bash(@laws)"],
});
const standard = {
  slug: "change-v1", domain: "demo", agents: [implementer],
  phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }],
} as unknown as Standard;

async function run(gigInput: Record<string, unknown>) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const events: GigProgressEvent[] = [];
  const seen: AgentInvocationContext[] = [];
  const invoke: AgentInvoker = (ctx) => {
    seen.push(ctx);
    return { ...coreInvariantFields("Signal"), value: "done" };
  };
  await runGig(standard, gigInput, {
    outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, layout: LAYOUT,
    onProgress: (e: GigProgressEvent) => events.push(e),
  } as never);
  const done = events.find((e) => e.type === "chair_complete") as (GigProgressEvent & Record<string, unknown>) | undefined;
  return { done, seen };
}

describe("the chair records its resolved grants", () => {
  it("chair_complete records the grants the seat ran WITH — expanded by the layout, narrowed by the change's target_paths", async () => {
    const { done } = await run({ request_text: "fix a", target_paths: ["src/a.ts"] });
    expect(done, "no chair_complete was emitted").toBeDefined();
    const grants = done!["resolved_grants"] as string[] | undefined;
    expect(Array.isArray(grants), "the chair's record does not say what the seat could touch").toBe(true);
    expect([...grants!].sort()).toEqual(["Bash(npx vitest run:*)", "Read", "Write(src/a.ts)"]);
    expect(done!["target_paths_applied"], "the record does not say the change's target_paths narrowed the seat").toBe(true);
  });

  it("a change with NO target_paths is recorded as un-narrowed — target_paths_applied: false, present, never absent", async () => {
    const { done } = await run({ request_text: "fix a" });
    expect(done && "target_paths_applied" in done, "an un-narrowed seat is indistinguishable from a chair nobody recorded").toBe(true);
    expect(done!["target_paths_applied"]).toBe(false);
    expect([...(done!["resolved_grants"] as string[])].sort()).toEqual(["Bash(npx vitest run:*)", "Read", "Write(lib/**)", "Write(src/**)"]);
  });

  it("the layout on the run reaches the chair's invocation as ctx.layout — the invoker resolves against it", async () => {
    const { seen } = await run({ request_text: "fix a", target_paths: ["src/a.ts"] });
    expect(seen.length, "the chair was never invoked").toBe(1);
    expect((seen[0] as unknown as { layout?: unknown }).layout, "runGig did not hand the chair the run's layout").toEqual(LAYOUT);
    expect(seen[0]!.gig_input["target_paths"], "the change-request's target_paths did not reach the chair").toEqual(["src/a.ts"]);
  });
});

describe("the dispatch door carries the layout of the tree it runs against", () => {
  it("bootstrapServerDeps(<tree with coltrane.layout.json>) → gig_dispatch → the chair's invocation holds THAT tree's layout", async () => {
    const { bootstrapServerDeps, dispatchTool } = await import("../src/server.js");
    const tree = genomeTree({ layout: LAYOUT, agents: [{ ...IMPLEMENTER_FILE, primitives: ["SENSE"], output_types: ["Signal"], allowed_tools: ["Read", "Write(@source)"] }] });
    mkdirSync(join(tree, "standards"), { recursive: true });
    writeFileSync(join(tree, "standards", "tree-change-v1.json"), JSON.stringify({
      slug: "tree-change-v1", domain: "software-change", agent_slugs: ["implementer"],
      phases: [{ name: "build", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
    }, null, 2));
    const deps = bootstrapServerDeps(tree);
    expect(deps.standards?.has("tree-change-v1"), "the tree's standard did not load — the door law would run nothing").toBe(true);
    const seen: AgentInvocationContext[] = [];
    deps.invoke = (ctx) => {
      seen.push(ctx);
      return { ...coreInvariantFields("Signal"), content: "done" };
    };
    const r = await dispatchTool("gig_dispatch", { standard_slug: "tree-change-v1", input: { request_text: "fix a", target_paths: ["src/a.ts"] }, wait: true }, deps);
    expect(seen.length, `the chair was never invoked: ${JSON.stringify(r).slice(0, 400)}`).toBeGreaterThan(0);
    expect((seen[0] as unknown as { layout?: unknown }).layout, "the dispatch door ran the gig without the tree's layout — every role token would fail closed").toEqual(LAYOUT);
  });
});
