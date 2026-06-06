// 2 more tools wired OUT of NEEDS_RUNTIME — both §6, both real-backed:
//   output_write          -> deps.outputs.write() + addRef() provenance edges
//   execution_history_read -> deps.ledger.query()
// No invented store: the outputs store and the ledger already exist. TDD: these
// assertions are the contract; the server wiring is made to satisfy them.

import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const findingType: DomainType = {
  slug: "finding",
  extends: "Judgment",
  domain: "eirtests",
  schema: { type: "object", properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(findingType);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("output_write", () => {
  it("writes a typed output through the router, auto-resolving primitive from core_type", async () => {
    const d = makeDeps();
    const r = await dispatchTool(
      "output_write",
      { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { title: "missing alt" } },
      d,
    );
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { output_id: string; primitive: string };
    expect(typeof data.output_id).toBe("string");
    expect(data.primitive).toBe("JUDGE"); // resolved from Judgment
    // it actually persisted — visible through output_query
    const q = await dispatchTool("output_query", { gig_id: "g1" }, d);
    expect((q.data as { total_count: number }).total_count).toBe(1);
  });

  it("rejects a bad-schema output AT WRITE (T3 — nothing persisted)", async () => {
    const d = makeDeps();
    const r = await dispatchTool(
      "output_write",
      { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { wrong: "no title" } },
      d,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(d.outputs.all().length).toBe(0);
  });

  it("links provenance edges when refs are supplied", async () => {
    const d = makeDeps();
    const a = await dispatchTool("output_write", { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "scout", data: { title: "a" } }, d);
    const aId = (a.data as { output_id: string }).output_id;
    const b = await dispatchTool(
      "output_write",
      { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { title: "b" }, refs: [{ to: aId, relation: "derived_from" }] },
      d,
    );
    expect(b.ok).toBe(true);
    expect(d.outputs.refs().length).toBe(1);
    expect(d.outputs.refs()[0]!.relation).toBe("derived_from");
  });

  // Rob #133 (this branch): domain_type is OPTIONAL. A bare {} call no longer
  // fails as "unknown domain_type" — it writes a freeform output keyed on
  // core_type only. The honest-failure surface is preserved when a declared
  // domain_type's schema is actually violated; see tests/rob_ergonomic_fixes.
  it("is no longer not_implemented on a bare {} call (it succeeds as a freeform output post-#133)", async () => {
    const r = await dispatchTool("output_write", {}, makeDeps());
    expect(r.not_implemented).toBeFalsy();
    expect(r.ok).toBe(true);
  });
});

describe("execution_history_read", () => {
  it("returns ledger entries, filterable by gig_id", async () => {
    const d = makeDeps();
    d.ledger.append({ gig_id: "g1", standard_slug: "scan", genome_hash: "h1", run_fingerprint: "f1", output_hashes: [], started_at: "t0", finished_at: "t1" });
    d.ledger.append({ gig_id: "g2", standard_slug: "scan", genome_hash: "h2", run_fingerprint: "f2", output_hashes: [], started_at: "t0", finished_at: "t1" });
    const all = await dispatchTool("execution_history_read", {}, d);
    expect(all.ok).toBe(true);
    expect(all.not_implemented).toBeFalsy();
    expect((all.data as { executions: unknown[] }).executions.length).toBe(2);
    const one = await dispatchTool("execution_history_read", { gig_id: "g1" }, d);
    const execs = (one.data as { executions: { gig_id: string }[] }).executions;
    expect(execs.length).toBe(1);
    expect(execs[0]!.gig_id).toBe("g1");
  });

  it("filters by standard_slug", async () => {
    const d = makeDeps();
    d.ledger.append({ gig_id: "g1", standard_slug: "scan", genome_hash: "h1", run_fingerprint: "f1", output_hashes: [], started_at: "t0", finished_at: "t1" });
    d.ledger.append({ gig_id: "g2", standard_slug: "audit", genome_hash: "h2", run_fingerprint: "f2", output_hashes: [], started_at: "t0", finished_at: "t1" });
    const r = await dispatchTool("execution_history_read", { standard_slug: "audit" }, d);
    expect((r.data as { executions: unknown[] }).executions.length).toBe(1);
  });
});
