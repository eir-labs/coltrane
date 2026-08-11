// The write boundary is `output_write`, and the seal predicate it enforces is the COMPLETE one.
//
// THE BUG this file pins, and the governor's two rejections of the first fix:
//   1. A model chair must self-correct IN-BAND within its single agentic run — NOT by the invoker
//      re-prompting/re-invoking it. The correct mechanism: the chair SEALS by calling `output_write`
//      during its run; a violation returns in-band (dispatchTool's { ok:false, error }) and the
//      agent calls output_write again with a corrected payload. The invoker never re-prompts.
//   2. The boundary must enforce the FULL seal predicate — `checkWritable` (the substance floor via
//      validateOutput + the domain schema via registry.validate + core agreement) — NOT the
//      registry.validate SUBSET the first fix used. A subset silently passes an output the seal
//      rejects (e.g. a bare-core Interpretation with no `claims`).
//
// THE RECONCILIATION (option b): output_write, in a chair's spawn, runs in VALIDATE mode — it
// adjudicates against the full predicate and returns the verdict WITHOUT persisting. The invoker
// captures the payload that PASSED and hands it back; the runtime (executeChair) is the one sealer,
// so the output is sealed EXACTLY ONCE and the seal's own gate is an unreachable backstop.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import * as invokerModule from "../src/claude_invoker.js";
import { createRegistry, createOutputStore, MemoryLedger, MCP_TOOLS, type DomainType } from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// A registered `report` type: an Interpretation whose schema REQUIRES `title`. So a valid report
// owes BOTH `title` (its domain schema) and `claims` (the Interpretation substance floor).
const REPORT_TYPE: DomainType = {
  slug: "report",
  extends: "Interpretation",
  domain: "test",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, claims: { type: "array" } },
    required: ["title"],
  },
  required_fields: ["title"],
};

const makeRegistry = () => createRegistry([REPORT_TYPE]);
const reporter = () => testAgent({ slug: "reporter", primitives: ["INTERPRET"], output_types: ["report"] });
const ctx = () => ({
  agent: reporter(),
  phase: "interpret",
  gig_id: "g1",
  inputs: [] as never[],
  gig_input: {},
  output_types: ["report"] as const,
});

// Build ServerDeps; `mode` selects the output_write write-boundary behaviour for this process.
const deps = (mode?: "validate"): ServerDeps => {
  const registry = makeRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    gig_runs: new Map(),
    ...(mode ? { output_write_mode: mode } : {}),
  };
};

// ── (a) The boundary rejects in-band and does NOT seal; the agent corrects and a valid output
//        passes — all through output_write, with no invoker re-prompt. ──────────────────────────
describe("output_write is the write boundary: validate-mode adjudicates in-band and seals nothing", () => {
  it("a contract-violating payload is rejected IN-BAND (a returned error, not a throw) and nothing persists", async () => {
    const d = deps("validate");
    // Missing the required `title` — exactly the "violates its output_contract" case.
    const r = await dispatchTool("output_write", {
      core_type: "Interpretation", domain_type: "report", domain: "test",
      gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { claims: ["a"] },
    }, d);
    expect(r.ok).toBe(false);                       // in-band verdict, reachable by the still-running agent
    expect(String(r.error)).toMatch(/title|report/i);
    expect(d.outputs.all().length).toBe(0);         // rejected — nothing sealed
  });

  it("a valid payload is VALIDATED but NOT persisted — the runtime is the one sealer (no double-seal)", async () => {
    const d = deps("validate");
    const r = await dispatchTool("output_write", {
      core_type: "Interpretation", domain_type: "report", domain: "test",
      gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { title: "the finding", claims: ["a"] },
    }, d);
    expect(r.ok).toBe(true);
    const data = r.data as { validated?: boolean; validation_result?: { valid: boolean } };
    expect(data.validated).toBe(true);
    expect(data.validation_result?.valid).toBe(true);
    // The whole point of validate-mode: the chair's own output_write does NOT create a durable row.
    // Only the runtime seals the captured payload, so the output is sealed exactly once.
    expect(d.outputs.all().length).toBe(0);
  });

  it("in SEAL mode (a human/agent output_write) the same valid payload DOES persist exactly one row", async () => {
    const d = deps(); // default seal mode
    const r = await dispatchTool("output_write", {
      core_type: "Interpretation", domain_type: "report", domain: "test",
      gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { title: "the finding", claims: ["a"] },
    }, d);
    expect(r.ok).toBe(true);
    expect(d.outputs.all().length).toBe(1); // seal mode is unchanged
  });
});

// ── (b) The boundary enforces the FULL checkWritable, not the registry.validate SUBSET. ─────────
describe("the boundary enforces the COMPLETE seal predicate, not the registry.validate subset", () => {
  it("a substance-floor violation registry.validate would PASS is caught at the boundary", async () => {
    const d = deps("validate");
    // A bare-core Interpretation (no domain_type) with no `claims`. registry.validate short-circuits
    // an absent domain_type to VALID — so the first fix's registry.validate-only check passed it.
    const bareCore = { core_type: "Interpretation", domain_type: "", data: { frame: "x" } };
    expect(d.registry.validate(bareCore).valid).toBe(true); // the SUBSET says fine…

    const r = await dispatchTool("output_write", {
      core_type: "Interpretation", domain_type: "", domain: "test",
      gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { frame: "x" },
    }, d);
    expect(r.ok).toBe(false);                        // …the FULL checkWritable does not
    expect(String(r.error)).toMatch(/claims|substance|Interpretation/i);
    expect(d.outputs.all().length).toBe(0);
  });
});

// ── The invoker captures from output_write and NEVER re-invokes. ────────────────────────────────
describe("the output_write-seal invoker captures the passed payload and runs the agent exactly once", () => {
  // A stream-json transcript standing in for the spawned `claude`: the agent calls output_write with
  // an invalid payload (rejected in-band), then AGAIN with a valid one (accepted) — all inside its
  // ONE run. The invoker must capture the payload that passed and never re-invoke.
  const STREAM = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_bad", name: "mcp__coltrane__output_write",
      input: { core_type: "Interpretation", domain_type: "report", gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { claims: ["a"] } } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_bad", is_error: true, content: "output rejected: report failed schema validation — must have required property 'title'" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_ok", name: "mcp__coltrane__output_write",
      input: { core_type: "Interpretation", domain_type: "report", gig_id: "g1", phase: "interpret", agent_slug: "reporter", data: { title: "the finding", claims: ["a"] } } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_ok", is_error: false, content: "{\"validated\":true}" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Sealed the report." },
  ].map((e) => JSON.stringify(e)).join("\n");

  it("captures the LAST passing output_write payload and calls the model ONCE (no re-prompt loop)", async () => {
    let calls = 0;
    const invoke = makeClaudeInvoker({
      registry: makeRegistry(),
      sealVia: "output_write",
      run: () => { calls++; return STREAM; },
    });
    const out = await invoke(ctx());
    // The blob the runtime seals — keyed by domain_type, carrying the payload that PASSED (not the
    // earlier rejected one).
    expect(out).toEqual({ report: { title: "the finding", claims: ["a"] } });
    // The heart of the governor's first rejection: the agent self-corrected WITHIN its single run.
    // The invoker did not re-invoke — so exactly one call, never the old bounded repair loop.
    expect(calls).toBe(1);
  });

  it("a run that never gets a write past the boundary fails legibly — never a silent empty seal", async () => {
    // Only rejected output_write calls: nothing passed, so the chair sealed nothing.
    const onlyRejected = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_bad", name: "mcp__coltrane__output_write",
        input: { core_type: "Interpretation", domain_type: "report", data: { claims: ["a"] } } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_bad", is_error: true, content: "rejected" }] } },
      { type: "result", subtype: "success", is_error: false, result: "gave up" },
    ].map((e) => JSON.stringify(e)).join("\n");
    let calls = 0;
    const invoke = makeClaudeInvoker({
      registry: makeRegistry(),
      sealVia: "output_write",
      run: () => { calls++; return onlyRejected; },
    });
    await expect(invoke(ctx())).rejects.toThrow(/write boundary|output_write/i);
    expect(calls).toBe(1); // still no re-invocation
  });

  it("the prompt tells the agent to seal via output_write (the in-band boundary), not to print JSON", async () => {
    let prompt = "";
    const invoke = makeClaudeInvoker({
      registry: makeRegistry(),
      sealVia: "output_write",
      run: (_bin, args) => {
        const i = args.indexOf("-p");
        prompt = i >= 0 && i + 1 < args.length ? args[i + 1]! : "";
        return STREAM;
      },
    });
    await invoke(ctx());
    expect(prompt).toMatch(/output_write/);
  });

  it("still exposes the typed contract error", () => {
    const ModelOutputContractError = (invokerModule as unknown as Record<string, unknown>)[
      "ModelOutputContractError"
    ];
    expect(ModelOutputContractError).toBeTypeOf("function");
  });
});

// ── The secondary bug the PR already fixed stays fixed: output_write's declared output_schema
//    matches what the handler actually returns. ──────────────────────────────────────────────────
describe("output_write: the declared output_schema matches what the handler actually returns", () => {
  const note: DomainType = {
    slug: "note", extends: "Signal", domain: "demo",
    schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
  };
  const noteDeps = (): ServerDeps => {
    const registry = createRegistry([note]);
    return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
  };

  it("the handler returns validation_result (declared and, before the fix, never returned)", async () => {
    const r = await dispatchTool("output_write", {
      core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "sensor",
      data: { t: "x", source: "fixture://demo/sensor" },
    }, noteDeps());
    expect(r.ok).toBe(true);
    const data = r.data as { output_id?: string; validation_result?: { valid: boolean } };
    expect(data.validation_result).toBeDefined();
    expect(data.validation_result!.valid).toBe(true);
  });

  it("every key the handler returns is advertised in the declared output_schema", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "output_write")!;
    const declared = Object.keys((tool.output_schema as { properties: Record<string, unknown> }).properties);
    for (const k of ["output_id", "primitive", "output", "validation_result"]) {
      expect(declared, `output_write must advertise "${k}"`).toContain(k);
    }
  });
});
