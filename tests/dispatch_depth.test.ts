// RED — issue #237: `depth` is advertised on gig_dispatch and silently discarded.
//
// src/mcp.ts declares depth on gig_dispatch. The handler reads standard_slug, budget, input
// and wait; grepping the whole case body for `depth` returns zero hits. EVERY dispatch runs at
// full depth — which is the mechanism the consuming product's entire documented cost-control
// practice rests on ("Skim first... A full run is ~$4-7"). An operator following that guidance
// exactly, believing they are running a cheap iteration, pays full price every time.
//
// The fix has to be a real lever, not a recorded field: the depth a gig runs at must reach the
// invocation that spends the money.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, buildPrompt,
  makeClaudeInvoker, DEPTH_MAX_TOOL_CALLS,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const chair: Chair = { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
const standard = (): Standard => composeStandard({
  slug: "depth-demo", domain: "demo",
  agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo", depth_profile: "deep" })],
  phases: [{ name: "sense", chairs: [chair] } as PhaseDef],
});

function deps(invoke: AgentInvoker): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  const std = standard();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
  };
}

describe("#237 — dispatch-time depth reaches the thing that spends", () => {
  it("gig_dispatch({depth:'skim'}) threads skim into the agent invocation", async () => {
    let seen: string | undefined;
    const d = deps((ctx) => { seen = ctx.depth; return { t: "hi" }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "depth-demo", input: {}, depth: "skim", wait: true }, d);
    expect(r.ok, r.error).toBe(true);
    expect(
      seen,
      "the dispatch handler never reads args['depth']; the only reader of a dispatch-time depth " +
        "anywhere in the engine is standard_simulate. Every dispatch runs at full depth.",
    ).toBe("skim");
  });

  it("the async path threads it too, and the response says what depth actually ran", async () => {
    let seen: string | undefined;
    const d = deps((ctx) => { seen = ctx.depth; return { t: "hi" }; });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "depth-demo", input: {}, depth: "skim" }, d);
    expect((r.data as { depth?: string }).depth, "the operator must be able to see the depth the run took").toBe("skim");
    // let the background run reach the chair
    for (let i = 0; i < 200 && seen === undefined; i++) await new Promise((res) => setTimeout(res, 5));
    expect(seen).toBe("skim");
  });

  it("an unrecognized depth is a loud error, not a silent discard", async () => {
    const d = deps(() => ({ t: "hi" }));
    const r = await dispatchTool("gig_dispatch", { standard_slug: "depth-demo", input: {}, depth: "shallowish", wait: true }, d);
    expect(r.ok, "an unknown depth must not quietly run at full depth").toBe(false);
    expect(String(r.error)).toMatch(/depth/i);
  });

  it("omitting depth is unchanged behaviour (the agent's own depth_profile stands)", async () => {
    let seen: string | undefined = "unset";
    const d = deps((ctx) => { seen = ctx.depth; return { t: "hi" }; });
    await dispatchTool("gig_dispatch", { standard_slug: "depth-demo", input: {}, wait: true }, d);
    expect(seen).toBeUndefined();
  });

  it("a shallow depth tightens the chair's turn cap — the only hard spend bound the cage has", async () => {
    const agent = testAgent({ slug: "solo", primitives: ["SENSE"], output_types: ["note"], max_tool_calls: 40 });
    const flag = (args: string[], name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };

    let deepArgs: string[] = [];
    await makeClaudeInvoker({ run: (_b, a) => { deepArgs = a; return JSON.stringify({ t: "x" }); } })(
      { agent, phase: "sense", inputs: [], gig_input: {} },
    );
    expect(flag(deepArgs, "--max-turns"), "sanity: the agent's own cap stands with no run depth").toBe("40");

    let skimArgs: string[] = [];
    await makeClaudeInvoker({ run: (_b, a) => { skimArgs = a; return JSON.stringify({ t: "x" }); } })(
      { agent, phase: "sense", inputs: [], gig_input: {}, depth: "skim" },
    );
    const cap = Number(flag(skimArgs, "--max-turns"));
    expect(
      cap,
      "a skim run that can still take 40 tool turns is a full run wearing a label. --max-turns " +
        "is the only hard per-chair cost bound the cage has.",
    ).toBeLessThan(40);
    expect(cap).toBe(DEPTH_MAX_TOOL_CALLS.skim);
  });

  it("a depth cap never WIDENS an agent's own declared cap", async () => {
    const tight = testAgent({ slug: "solo", primitives: ["SENSE"], output_types: ["note"], max_tool_calls: 2 });
    let args: string[] = [];
    await makeClaudeInvoker({ run: (_b, a) => { args = a; return JSON.stringify({ t: "x" }); } })(
      { agent: tight, phase: "sense", inputs: [], gig_input: {}, depth: "skim" },
    );
    expect(args[args.indexOf("--max-turns") + 1]).toBe("2");
  });

  it("the run depth overrides the agent's static depth_profile in the prompt", () => {
    const agent = testAgent({ slug: "solo", primitives: ["SENSE"], output_types: ["note"], depth_profile: "deep" });
    const base = buildPrompt({ agent, phase: "sense", inputs: [], gig_input: {} });
    expect(base, "sanity: the static profile is what renders with no run depth").toContain("Depth: deep");

    const skimmed = buildPrompt({ agent, phase: "sense", inputs: [], gig_input: {}, depth: "skim" });
    expect(
      skimmed,
      "a depth threaded at dispatch must change what the model is asked to do — otherwise it " +
        "is a recorded field, not a cost lever.",
    ).toContain("Depth: skim");
    expect(skimmed).not.toContain("Depth: deep");
  });
});
