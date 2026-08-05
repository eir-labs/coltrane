// Runtime — the gig executor. A 2-phase standard runs end-to-end: outputs land
// typed + validated in the store, provenance links phase-2 → phase-1, the ledger
// records one immutable entry with a deterministic genome_hash + run_fingerprint.
// This is the E1 foundation (NL goal → standard → executed → outputs in store).
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  RuntimeError,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type ServerDeps,
  type DomainType,
  type AgentInvoker,
} from "../src";
import type { Standard, Agent } from "../src";

const pageModel: DomainType = {
  slug: "page-model",
  extends: "Signal",
  domain: "eirtests",
  schema: { properties: { url: { type: "string" } } },
  required_fields: ["url"],
};
const finding: DomainType = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

const scout: Agent = { ...TEST_BEHAVIOR,
  slug: "site-scout",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["page-model"],
  domain: "eirtests",
};
const analyst: Agent = { ...TEST_BEHAVIOR,
  slug: "site-analyst",
  primitives: ["INTERPRET"],
  input_types: ["page-model"],
  output_types: ["finding"],
  domain: "eirtests",
};

const standard: Standard = {
  slug: "readiness-scan",
  domain: "eirtests",
  agents: [scout, analyst],
  phases: [
    { name: "sense", chairs: [{ role: "sense", agent_slug: "site-scout", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] },
    { name: "interpret", chairs: [{ role: "interpret", agent_slug: "site-analyst", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] },
  ],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(pageModel);
  registry.registerType(finding);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

// deterministic mock invoker: each agent returns schema-valid data for its output type.
const mockInvoke: AgentInvoker = ({ agent, inputs }) => {
  if (agent.slug === "site-scout") return { url: "/products", source: "https://example.com/products" };
  // analyst consumes the page-model and emits a finding referencing it
  return { title: `finding from ${inputs.length} input(s)`, claims: [`derived from ${inputs.length} input(s)`] };
};

describe("runtime: gig execution end-to-end", () => {
  it("runs a 2-phase standard and lands both typed outputs in the store", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, { site_url: "example.com" }, { outputs, ledger, invoke: mockInvoke });
    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(2);
    expect(outputs.all().length).toBe(2);
    expect(res.outputs.map((o) => o.domain_type)).toEqual(["page-model", "finding"]);
  });

  it("links provenance: the finding is derived_from the page-model", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: mockInvoke });
    const pm = res.outputs.find((o) => o.domain_type === "page-model")!;
    const fnd = res.outputs.find((o) => o.domain_type === "finding")!;
    expect(fnd.input_refs).toContain(pm.id);
    const refs = outputs.refs();
    expect(refs.some((r) => r.from_output_id === fnd.id && r.to_output_id === pm.id && r.relation === "derived_from")).toBe(true);
    // E6 foundation: tracing the finding reaches the page-model.
    expect(outputs.trace(fnd.id).map((o) => o.id)).toContain(pm.id);
  });

  it("records one immutable ledger entry with deterministic genome_hash + run_fingerprint", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: mockInvoke, model_version: "claude-opus-4-7" });
    expect(ledger.count()).toBe(1);
    const entry = ledger.query({ gig_id: res.gig_id })[0]!;
    expect(entry.genome_hash).toBe(res.genome_hash);
    expect(entry.run_fingerprint).toBe(res.run_fingerprint);
    expect(entry.output_hashes.length).toBe(2);
  });

  it("genome_hash is deterministic across runs; run_fingerprint shifts with model_version", async () => {
    const a = setup();
    const r1 = await runGig(standard, {}, { ...a, invoke: mockInvoke, model_version: "m1" });
    const b = setup();
    const r2 = await runGig(standard, {}, { ...b, invoke: mockInvoke, model_version: "m2" });
    expect(r1.genome_hash).toBe(r2.genome_hash); // same defs → same genome_hash
    expect(r1.run_fingerprint).not.toBe(r2.run_fingerprint); // different model → different fingerprint
  });

  it("run_fingerprint is reproducible: identical genome + model + deterministic outputs → identical fingerprint", async () => {
    // Replay-vs-tamper depends on this: an honest replay of the same genome with
    // the same model and the same outputs MUST reproduce the fingerprint. If it
    // doesn't, a legitimate replay is indistinguishable from a tamper. Bug: the
    // runtime folded each output's random UUID into output_hashes, so two
    // identical runs never matched. This pins content-addressing.
    const a = setup();
    const r1 = await runGig(standard, {}, { ...a, invoke: mockInvoke, model_version: "m1" });
    const b = setup();
    const r2 = await runGig(standard, {}, { ...b, invoke: mockInvoke, model_version: "m1" });
    expect(r2.run_fingerprint).toBe(r1.run_fingerprint);
  });

  it("run_fingerprint shifts when an output's content differs (tamper IS caught)", async () => {
    const a = setup();
    const r1 = await runGig(standard, {}, { ...a, invoke: mockInvoke, model_version: "m1" });
    const tamperInvoke: AgentInvoker = ({ agent, inputs }) =>
      agent.slug === "site-scout"
        ? { url: "/TAMPERED", source: "https://example.com/products" }
        : { title: `finding from ${inputs.length} input(s)`, claims: [`derived from ${inputs.length} input(s)`] };
    const b = setup();
    const r2 = await runGig(standard, {}, { ...b, invoke: tamperInvoke, model_version: "m1" });
    expect(r2.run_fingerprint).not.toBe(r1.run_fingerprint); // different content → different fingerprint
  });

  it("rejects a phase referencing an unknown agent", async () => {
    const { outputs, ledger } = setup();
    const broken: Standard = { ...standard, phases: [{ name: "x", chairs: [{ role: "x", agent_slug: "ghost", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }] };
    await expect(runGig(broken, {}, { outputs, ledger, invoke: mockInvoke })).rejects.toThrow(RuntimeError);
  });

  it("rejects bad-schema agent output at write (validation flows through the runtime)", async () => {
    const { outputs, ledger } = setup();
    const badInvoke: AgentInvoker = ({ agent }) =>
      agent.slug === "site-scout" ? {} : { title: "x" }; // scout omits required 'url'
    await expect(runGig(standard, {}, { outputs, ledger, invoke: badInvoke })).rejects.toThrow();
  });
});
