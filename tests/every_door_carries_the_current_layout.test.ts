// EVERY DOOR CARRIES THE CURRENT LAYOUT — the chart door, a reloaded genome, a layered genome.
//
// Three wires survived the implementer's own mutation run: deleting any of them left every law green.
// A wire nothing can break is not guarded; these laws make each one observable.
//
//   · THE CHART DOOR. gig_dispatch with a chart builds its own run-deps (`chartDeps`, src/server.ts) and
//     every movement inherits them. A chart whose movements run without the layout fails every role
//     token closed — or, worse, runs against a layout a later wire supplies from somewhere else.
//   · RELOAD. genome_reload re-reads the tree. If it refreshes the agents and not the layout, the NEXT
//     dispatch seats chairs under the layout the tree USED to have — an edit that narrowed the source is
//     silently not in force.
//   · LAYERS. A consumer genome extends a base. The layout describes ONE repository — the tree the gig
//     runs against, the TOP layer. The base's layout is not the consumer's, and is never inherited.
//
//   law                                          kind         drives                                          plant
//   the chart's movements get the layout         behavioural  dispatchTool("gig_dispatch", {chart_slug}) —     remove `layout` from chartDeps in src/server.ts
//                                                             src/server.ts → runChart → runGig
//   after a reload the NEW layout governs        behavioural  bootstrapServerDeps + dispatchTool("genome_       drop `deps.layout = fresh.layout` in genome_reload
//                                                             reload") then gig_dispatch — src/server.ts
//   a reload that removes the file → no layout   behavioural  same                                             same plant
//   the top layer's layout wins                  behavioural  resolveGenome → loadLayeredGenome — src/loader.ts drop the top layer's layout in loadLayeredGenome
//   a base's layout is never inherited           behavioural  same                                             fall back to the base layer's layout
import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger, composeStandard, type AgentInvoker, type PhaseDef, type Standard } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { resolveGenome } from "../src/loader.js";
import { ChartSchema } from "../src/genome_schema.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { pollSettled } from "./_support/repo_lock_fixtures.js";
import { genomeTree, IMPLEMENTER_FILE, LAYOUT_FILE, type Layout } from "./layout_grants_fixtures.js";

const A: Layout = { paths: { source: ["src/**", "lib/**"] } };
const B: Layout = { paths: { source: ["src/**"] } };
const layoutOf = (c: AgentInvocationContext | undefined): unknown => (c as unknown as { layout?: unknown } | undefined)?.layout;

describe("the chart door carries the layout into every movement", () => {
  const scout = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "chart-demo" });
  const reader = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "chart-demo" });
  const look = (): Standard => composeStandard({
    slug: "look", domain: "chart-demo", agents: [scout], output_types: ["Signal"],
    phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
  });
  const digest = (): Standard => composeStandard({
    slug: "digest", domain: "chart-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
    phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
  });

  it("both movements' chairs are invoked holding the server's layout", async () => {
    const seen: AgentInvocationContext[] = [];
    const invoke: AgentInvoker = async (ctx) => {
      seen.push(ctx);
      return ctx.agent.slug === "reader" ? { claims: [{ claim: "read" }] } : { source: "fixture://chart/look" };
    };
    const registry = createRegistry();
    const deps = {
      registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
      standards: new Map([["look", look()], ["digest", digest()]]),
      agents: new Map([["scout", scout], ["reader", reader]]),
      charts: new Map([["look-then-digest", ChartSchema.parse({
        slug: "look-then-digest",
        movements: [{ movement_id: "sense", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest" }],
        edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
      })]]),
      invoke, gig_runs: new Map(), layout: A,
    } as unknown as ServerDeps;
    const r = await dispatchTool("gig_dispatch", { chart_slug: "look-then-digest", input: { Signal: { source: "seed" } } }, deps);
    expect(r.ok, String(r.error)).toBe(true);
    await pollSettled(deps, (r.data as { gig_id: string }).gig_id);
    expect(seen.map((c) => c.agent.slug).sort(), "non-vacuity: both movements ran").toEqual(["reader", "scout"]);
    for (const c of seen) expect(layoutOf(c), `movement chair "${c.agent.slug}" ran without the layout`).toEqual(A);
  });
});

describe("after genome_reload, the tree's NEW layout governs", () => {
  function tree(layout: Layout): string {
    const root = genomeTree({ layout, agents: [{ ...IMPLEMENTER_FILE, primitives: ["SENSE"], output_types: ["Signal"], allowed_tools: ["Read", "Write(@source)"] }] });
    mkdirSync(join(root, "standards"), { recursive: true });
    writeFileSync(join(root, "standards", "tree-change-v1.json"), JSON.stringify({
      slug: "tree-change-v1", domain: "software-change", agent_slugs: ["implementer"],
      phases: [{ name: "build", chairs: [{ role: "impl", agent_slug: "implementer", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
    }));
    return root;
  }

  async function dispatchOnce(deps: ServerDeps, seen: AgentInvocationContext[]): Promise<AgentInvocationContext | undefined> {
    const before = seen.length;
    await dispatchTool("gig_dispatch", { standard_slug: "tree-change-v1", input: { request_text: "x" }, wait: true }, deps);
    return seen[before];
  }

  it("an edited coltrane.layout.json is the one the next dispatch seats under", async () => {
    const { bootstrapServerDeps } = await import("../src/server.js");
    const root = tree(A);
    const deps = bootstrapServerDeps(root);
    const seen: AgentInvocationContext[] = [];
    deps.invoke = (ctx) => { seen.push(ctx); return { ...coreInvariantFields("Signal"), content: "done" }; };
    expect(layoutOf(await dispatchOnce(deps, seen)), "non-vacuity: the first dispatch runs under the boot layout").toEqual(A);

    writeFileSync(join(root, LAYOUT_FILE), JSON.stringify(B));
    const rl = await dispatchTool("genome_reload", {}, deps);
    expect(rl.ok, String(rl.error)).toBe(true);
    expect(layoutOf(await dispatchOnce(deps, seen)), "after a reload the chair still ran under the STALE layout").toEqual(B);
  });

  it("a reload after the layout file is removed leaves no layout — the stale one does not linger", async () => {
    const { bootstrapServerDeps } = await import("../src/server.js");
    const root = tree(A);
    const deps = bootstrapServerDeps(root);
    const seen: AgentInvocationContext[] = [];
    deps.invoke = (ctx) => { seen.push(ctx); return { ...coreInvariantFields("Signal"), content: "done" }; };
    rmSync(join(root, LAYOUT_FILE));
    await dispatchTool("genome_reload", {}, deps);
    // With no layout the implementer's Write(@source) fails closed at dispatch, so the chair is not
    // invoked at all; either way, no seat may hold the removed layout.
    const c = await dispatchOnce(deps, seen);
    expect(layoutOf(c), "a removed layout lingered past the reload").toBeUndefined();
    expect(seen.every((s) => layoutOf(s) === undefined), "some seat ran under the removed layout").toBe(true);
    expect(deps.layout, "the server still holds the removed layout").toBeUndefined();
  });
});

describe("a layered genome's layout is the TOP layer's", () => {
  function layered(base: Layout | undefined, top: Layout | undefined): string {
    const baseRoot = genomeTree(base ? { layout: base } : {});
    const topRoot = genomeTree(top ? { layout: top } : {});
    writeFileSync(join(topRoot, "genome.json"), JSON.stringify({ extends: [baseRoot] }));
    return topRoot;
  }

  it("base and top both declare one: the top's wins", () => {
    const g = resolveGenome(layered(A, B));
    expect(g.provenance, "non-vacuity: this was a LAYERED load (loadLayeredGenome sets provenance)").toBeDefined();
    expect((g as unknown as { layout?: unknown }).layout, "the layered load dropped or overrode the top layer's layout").toEqual(B);
  });

  it("only the top declares one: it is the genome's layout", () => {
    const g = resolveGenome(layered(undefined, B));
    expect((g as unknown as { layout?: unknown }).layout, "the layered load dropped the top layer's layout").toEqual(B);
  });

  it("only the BASE declares one: the consumer has no layout — a base's shape is not the consumer repository's", () => {
    const g = resolveGenome(layered(A, undefined));
    expect((g as unknown as { layout?: unknown }).layout, "the consumer inherited the base repository's layout").toBeUndefined();
  });
});
