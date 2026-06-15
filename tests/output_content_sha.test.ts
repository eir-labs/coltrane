// #176 follow-up: the runtime stamps a real content_sha on every sealed output at write time,
// so the provenance chain is hash-anchored (input_refs → each input's content_sha) without any
// agent needing a hashing tool. This replaces the judge's placeholder predecessor SHAs.
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, type DomainType } from "../src/index.js";

function store() {
  const r = createRegistry();
  const t: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };
  r.registerType(t);
  return createOutputStore(r);
}
const base = { core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g", agent_slug: "a", phase: "p", primitive: "SENSE" } as const;

describe("every sealed output carries a runtime-computed content_sha", () => {
  it("write stamps a 64-hex content_sha", () => {
    const rec = store().write({ ...base, data: { v: "x" } });
    expect(rec.content_sha).toMatch(/^[0-9a-f]{64}$/);
  });
  it("identical content → identical content_sha; different content → different", () => {
    const s = store();
    const a = s.write({ ...base, data: { v: "same" } });
    const b = s.write({ ...base, data: { v: "same" } });
    const c = s.write({ ...base, data: { v: "different" } });
    expect(b.content_sha).toBe(a.content_sha);
    expect(c.content_sha).not.toBe(a.content_sha);
  });
  it("a record's predecessor SHAs are runtime-recoverable via input_refs → content_sha", () => {
    // The honest replacement for an agent fabricating predecessor hashes: a downstream
    // record's input_refs point at upstream records, and each upstream record's runtime-
    // stamped content_sha IS the real predecessor SHA — no hashing tool in any agent.
    const s = store();
    const pred = s.write({ ...base, data: { v: "upstream" } });
    const succ = s.write({ ...base, data: { v: "downstream" }, input_refs: [pred.id] });
    const predecessorShas = succ.input_refs.map((id) => s.get(id)!.content_sha);
    expect(predecessorShas).toEqual([pred.content_sha]);
    expect(predecessorShas[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
