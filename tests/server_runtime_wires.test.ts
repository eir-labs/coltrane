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
      { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { title: "missing alt", criteria: ["image accessibility"] } },
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
    const a = await dispatchTool("output_write", { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "scout", data: { title: "a", criteria: ["image accessibility"] } }, d);
    const aId = (a.data as { output_id: string }).output_id;
    const b = await dispatchTool(
      "output_write",
      { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { title: "b", criteria: ["image accessibility"] }, refs: [{ to: aId, relation: "derived_from" }] },
      d,
    );
    expect(b.ok).toBe(true);
    expect(d.outputs.refs().length).toBe(1);
    expect(d.outputs.refs()[0]!.relation).toBe("derived_from");
  });

  // Rob #133 (this branch): domain_type is OPTIONAL. A call with no domain_type no longer
  // fails as "unknown domain_type" — it writes a freeform output keyed on core_type only.
  // The honest-failure surface is preserved when a declared domain_type's schema is
  // actually violated; see tests/rob_ergonomic_fixes.
  //
  // NARROWED by #263. This asserted a bare `{}` — no core_type either — and passed, because
  // nothing validated the core. That was never what #133 promised: its own wording is
  // "keyed on core_type ONLY", which requires one. A record with no core is not freeform,
  // it is unclassifiable, and `validateOutput` applies no substance floor to a core it does
  // not recognise. The freeform contract under test is "domain_type is optional", and that
  // is what this now exercises.
  it("succeeds with no domain_type (the freeform output post-#133)", async () => {
    const r = await dispatchTool(
      "output_write",
      { core_type: "Interpretation", domain: "eirtests", gig_id: "g1", agent_slug: "a", data: { note: "freeform", claims: ["one claim"] } },
      makeDeps(),
    );
    expect(r.not_implemented).toBeFalsy();
    expect(r.ok).toBe(true);
  });

  it("refuses a call with no core_type at all — the freeform path still needs a core", async () => {
    const r = await dispatchTool("output_write", {}, makeDeps());
    expect(r.not_implemented, "still wired — this is a refusal, not an unimplemented tool").toBeFalsy();
    expect(r.ok).toBe(false);
  });
});

// Gig-row fixture in the settled #212 shape: 64-hex identity + ISO-8601 timestamps, which
// the shared validator enforces. "h1"/"t0" placeholders passed only because the old guard
// (src/ledger.ts:56-58) checked non-emptiness and nothing else.
const gigEntry = (over: Record<string, unknown>): never => ({
  kind: "gig",
  schema_version: 2,
  standard_slug: "scan",
  genome_hash: "a".repeat(64),
  run_fingerprint: "b".repeat(64),
  output_hashes: [],
  started_at: "2026-05-25T20:00:00.000Z",
  finished_at: "2026-05-25T20:01:00.000Z",
  entry_id: String(over["gig_id"] ?? ""),
  ...over,
}) as never;

describe("execution_history_read", () => {
  it("returns ledger entries, filterable by gig_id", async () => {
    const d = makeDeps();
    d.ledger.append(gigEntry({ gig_id: "g1", genome_hash: "1".repeat(64) }));
    d.ledger.append(gigEntry({ gig_id: "g2", genome_hash: "2".repeat(64) }));
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
    d.ledger.append(gigEntry({ gig_id: "g1", standard_slug: "scan",  genome_hash: "1".repeat(64) }));
    d.ledger.append(gigEntry({ gig_id: "g2", standard_slug: "audit", genome_hash: "2".repeat(64) }));
    const r = await dispatchTool("execution_history_read", { standard_slug: "audit" }, d);
    expect((r.data as { executions: unknown[] }).executions.length).toBe(1);
  });
});
