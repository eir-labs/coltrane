// An evolution is a version — the hosted write of agent_evolve carries the version it reports.
//
// MEASURED (3 Oct 2026, three times in one day): the hosted agent_evolve answered `new_version: 2`
// (then 3) with a sealed content hash, and the store row stayed at version 1, updated in place.
// The handler computes the merged definition (`next_def`) and the hosted half upserts it filtered
// through AgentObjectSchema's keys — and `next_def` carries no `version`, so the store's upsert
// defaulted it to 1 and matched the existing row. A version reported is a version recorded: the
// payload now carries `version: new_version`, so the store lands a new row and retires the prior
// (its own supersede rule), and the loader's agents rule (a_retired_standard_is_not_a_duplicate
// L8–L10) reads the history as one definition.
import { describe, it, expect, vi } from "vitest";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { testAgent } from "./_support/agents.js";
import type { Agent } from "../src/composition.js";

function hostedDeps(upsert: ReturnType<typeof vi.fn>, agents: Map<string, Agent>): ToolSurfaceDeps {
  const registry = createRegistry();
  const store = { load: vi.fn(), upsert } as unknown as NonNullable<ToolSurfaceDeps["store"]>;
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), hosted: true, store, agents } as ToolSurfaceDeps;
}

describe("agent_evolve, hosted: the upsert payload carries the version it reports", () => {
  it("L1 · evolving a v1 agent upserts version 2 — the row the store lands is a new version, not the old one in place", async () => {
    const upsert = vi.fn(async () => undefined);
    const base = { ...testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["scan-report"], domain: "demo" }), version: 1 } as Agent;
    const surface = createToolSurface(hostedDeps(upsert, new Map([["scout", base]])));
    const res = await surface.find((t) => t.name === "agent_evolve")!.call({ slug: "scout", changes: { method: "1. look harder 2. report 3. stop" } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const reported = (res.data as Record<string, unknown>)["new_version"];
    expect(typeof reported).toBe("number");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [cls, payload] = upsert.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(cls).toBe("agent");
    expect(payload["slug"]).toBe("scout");
    // THE LAW: whatever version the surface reports is the version the store is asked to record.
    expect(payload["version"], "the reported version is the recorded version").toBe(reported);
    // and it is a NEW version, above the base's (the merged definition carries the base's otherwise)
    expect(Number(reported)).toBeGreaterThan(Number((res.data as Record<string, unknown>)["parent_version"] ?? 0));
  });

  it("L2 · an explicit new_version rides through unchanged", async () => {
    const upsert = vi.fn(async () => undefined);
    const base = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["scan-report"], domain: "demo" });
    const surface = createToolSurface(hostedDeps(upsert, new Map([["scout", base]])));
    const res = await surface.find((t) => t.name === "agent_evolve")!.call({ slug: "scout", new_version: 7, changes: { method: "1. look 2. report 3. stop 4. rest" } });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const [, payload] = upsert.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(payload["version"]).toBe(7);
  });
});
