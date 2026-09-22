// A chair's COMMITMENT on the bus is sealed, not chatted (wiki spec.coltrane-bus: "Commitments are
// sealed, not chatted"). The chat chair's hands seal for real — unlike a gig seat, whose output_write
// only validates because the runtime is its sealer — and every commitment is stamped with where it was
// made: gig `bus:<name>`, the chair as agent, phase `bus`. A chair cannot stamp another's name.
import { describe, it, expect } from "vitest";
import { makeEngineToolSource, type ServerDeps } from "../src/server.js";
import { busCommitSource } from "../src/bus_terminal.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";

const deps = (): ServerDeps => {
  const registry = createRegistry();
  registry.registerType({ slug: "decision", extends: "Judgment", domain: "bus", schema: { properties: { what: { type: "string" } } }, required_fields: ["what"] } as never);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
};
const DECISION = { core_type: "Judgment", domain_type: "decision", domain: "bus", data: { what: "ship the bus verbs", criteria: ["c"], verdicts: [], reasoning_chain: ["r"] } };

describe("a chair's commitment is sealed", () => {
  it("S1 — a sealing source persists what output_write accepts; the default source only validates", async () => {
    const d = deps();
    await makeEngineToolSource(() => d).call("mcp__coltrane__output_write", { ...DECISION, gig_id: "g", agent_slug: "a", phase: "p" });
    expect(d.outputs.all().length, "a gig seat's source never persists").toBe(0);
    const r = await makeEngineToolSource(() => d, { seal: true }).call("mcp__coltrane__output_write", { ...DECISION, gig_id: "g", agent_slug: "a", phase: "p" });
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(d.outputs.all().length).toBe(1);
  });

  it("S2 — a commitment made on a bus is stamped with the bus and the chair, whatever the model wrote", async () => {
    const d = deps();
    const src = busCommitSource(makeEngineToolSource(() => d, { seal: true }), { bus: "coltrane", chair: "eir" });
    await src.call("mcp__coltrane__output_write", { ...DECISION, gig_id: "someone-else", agent_slug: "blakey", phase: "x" });
    const [rec] = d.outputs.all();
    expect(rec).toMatchObject({ gig_id: "bus:coltrane", agent_slug: "eir", phase: "bus" });
  });

  it("S3 — every other tool passes through untouched", async () => {
    const calls: Array<[string, unknown]> = [];
    const inner = { list: async () => [], call: async (n: string, a: Record<string, unknown>) => { calls.push([n, a]); return { ok: true }; } };
    await busCommitSource(inner, { bus: "coltrane", chair: "eir" }).call("mcp__coltrane__output_query", { domain_type: "decision" });
    expect(calls).toEqual([["mcp__coltrane__output_query", { domain_type: "decision" }]]);
  });
});
