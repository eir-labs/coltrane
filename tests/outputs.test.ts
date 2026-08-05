// O5 — §6 outputs store, tested directly (not through the router). Append + query,
// the output_refs provenance graph walks correctly, the backward-compat findings
// view, and core_type/schema validation AT WRITE. Counter-claim: an output is
// written without validation, or trace breaks (infinite-loops) on a provenance cycle.
import { describe, it, expect } from "vitest";
import { createRegistry, createOutputStore, type DomainType, type OutputStore } from "../src";

const sig: DomainType = { slug: "page-model", extends: "Signal", domain: "eirtests", schema: { properties: { url: { type: "string" } } }, required_fields: ["url"] };
const finding: DomainType = { slug: "finding", extends: "Verdict", domain: "eirtests", schema: { properties: { title: { type: "string" } } }, required_fields: ["title"] };

// Every core carries the substance it is defined by — `outputs.write` enforces the core
// invariant on every seal (#227/#228, and the #227 ruling that binds all six cores, bare or
// subtyped). A Verdict declares the evidence it verified; a Signal declares where it was
// acquired from. These fixtures always were incomplete instances of their own core; the seal
// path just never looked.
const CHECKS = { checks: [{ method: "fixture-assertion", target_ref: "eirtests", result: "pass" }] };
const SOURCE = { source: "https://eirtests.example" };

function store(): OutputStore {
  const reg = createRegistry();
  reg.registerType(sig);
  reg.registerType(finding);
  return createOutputStore(reg);
}

describe("O5: outputs store — append + query", () => {
  it("write returns the row, get + all read it back", () => {
    const s = store();
    const rec = s.write({ core_type: "Signal", domain_type: "page-model", domain: "eirtests", gig_id: "g1", agent_slug: "scout", primitive: "SENSE", data: { url: "/", ...SOURCE } });
    expect(rec.id).toBeTruthy();
    expect(s.get(rec.id)?.domain_type).toBe("page-model");
    expect(s.all().length).toBe(1);
  });
});

describe("O5: provenance graph walks correctly", () => {
  it("addRef links a derived_from edge; trace returns the ancestor", () => {
    const s = store();
    const a = s.write({ core_type: "Signal", domain_type: "page-model", domain: "eirtests", gig_id: "g1", agent_slug: "scout", primitive: "SENSE", data: { url: "/", ...SOURCE } });
    const b = s.write({ core_type: "Verdict", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "verifier", primitive: "VERIFY", data: { title: "x", ...CHECKS }, input_refs: [a.id] });
    s.addRef(b.id, a.id, "derived_from", "VERIFY");
    expect(s.refs().length).toBe(1);
    const ids = s.trace(b.id).map((o) => o.id);
    expect(ids).toContain(a.id);
  });

  it("rejects an invalid relation and a dangling endpoint", () => {
    const s = store();
    const a = s.write({ core_type: "Signal", domain_type: "page-model", domain: "eirtests", gig_id: "g1", agent_slug: "scout", primitive: "SENSE", data: { url: "/", ...SOURCE } });
    expect(() => s.addRef(a.id, a.id, "not_a_relation" as never, "SENSE")).toThrow();
    expect(() => s.addRef(a.id, "ghost-id", "derived_from", "SENSE")).toThrow();
  });
});

describe("O5: validation AT WRITE (no unvalidated persistence)", () => {
  it("rejects a bad-schema output and persists nothing", () => {
    const s = store();
    expect(() => s.write({ core_type: "Signal", domain_type: "page-model", domain: "eirtests", gig_id: "g1", agent_slug: "scout", primitive: "SENSE", data: { wrong: "no url", ...SOURCE } })).toThrow();
    expect(s.all().length).toBe(0);
  });
});

describe("O5: findings view", () => {
  it("projects eirtests findings; agent_slug → agent_role", () => {
    const s = store();
    s.write({ core_type: "Verdict", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "verifier", primitive: "VERIFY", data: { title: "t", ...CHECKS } });
    const rows = s.findings();
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_role).toBe("verifier");
  });
});

describe("O5: trace is cycle-safe (no infinite loop)", () => {
  it("a derived_from cycle terminates", () => {
    const s = store();
    const a = s.write({ core_type: "Signal", domain_type: "page-model", domain: "eirtests", gig_id: "g1", agent_slug: "scout", primitive: "SENSE", data: { url: "/a", ...SOURCE } });
    const b = s.write({ core_type: "Verdict", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "v", primitive: "VERIFY", data: { title: "b", ...CHECKS } });
    // deliberately create a cycle a → b → a
    s.addRef(a.id, b.id, "derived_from", "SENSE");
    s.addRef(b.id, a.id, "derived_from", "VERIFY");
    const walked = s.trace(a.id); // must not hang
    expect(walked.length).toBeGreaterThanOrEqual(1);
    expect(new Set(walked.map((o) => o.id)).size).toBe(walked.length); // each node visited once
  });
});
