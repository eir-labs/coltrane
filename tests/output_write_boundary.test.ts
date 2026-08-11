// RED-first — a model chair's emitted payload MUST be adjudicated against its output_contract
// at the WRITE BOUNDARY (the earliest frame the predicate is answerable and the producer can
// still act), not post-hoc at seal after the agent process has exited.
//
// THE BUG this file pins:
//   makeClaudeInvoker's extractJson returns the parsed object to the runtime as the chair's
//   answer with NO schema/contract validation. An output that violates its output_contract
//   (e.g. a missing required field) is only caught post-hoc at seal (runtime.ts →
//   deps.outputs.validateWrite → outputs.ts checkWritable), by which point the agent has
//   EXITED — a total, unrecoverable failure with no feedback to the producer.
//
// THE INVARIANT the fix installs:
//   In the invoker, after extracting the payload, validate it with registry.validate against
//   the resolved output-type schema BEFORE returning it. On invalid, RE-PROMPT the SAME agent
//   with the exact validation error, bounded to a small number of repair attempts, so it can
//   correct within its own turn. Only a persistently-invalid output fails the chair — cleanly,
//   with the reason — NOT a silent accept-then-fatal-seal.
//
// The injected `run` seam stands in for the spawned `claude` here: it returns the raw JSON
// blob the model would have emitted, deterministically, so the whole loop is exercised without
// a subprocess.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import * as invokerModule from "../src/claude_invoker.js";
import { createRegistry, createOutputStore, MemoryLedger, MCP_TOOLS, type DomainType } from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// A registered `report` type whose contract REQUIRES `title`. A payload without `title` is
// exactly the "violates its output_contract" case — and registry.validate (the same enforcer
// the seal runs) rejects it.
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

const registry = () => createRegistry([REPORT_TYPE]);
const reporter = () => testAgent({ slug: "reporter", primitives: ["INTERPRET"], output_types: ["report"] });
const ctx = () => ({
  agent: reporter(),
  phase: "interpret",
  inputs: [] as never[],
  gig_input: {},
  output_types: ["report"] as const,
});

const VALID = JSON.stringify({ title: "the finding", claims: ["a"] });
const INVALID = JSON.stringify({ claims: ["a"] }); // missing required `title`

// The prompt an injected run was handed (from `-p <prompt>`), so a test can prove the repair
// re-prompt carried the exact validation error.
function promptOf(args: string[]): string {
  const i = args.indexOf("-p");
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : "";
}

describe("output-write boundary: a chair's payload is adjudicated where it is written, not at seal", () => {
  it("a valid payload passes straight through, unchanged, on the first attempt", async () => {
    let calls = 0;
    const invoke = makeClaudeInvoker({
      registry: registry(),
      run: () => { calls++; return VALID; },
    });
    const out = await invoke(ctx());
    expect(out).toEqual({ title: "the finding", claims: ["a"] });
    expect(calls).toBe(1); // no repair loop for a compliant output
  });

  it("a persistently-invalid payload FAILS CLOSED at the boundary — never silently returned", async () => {
    // Before the fix this RESOLVES with the invalid object (silent accept), which then dies
    // post-hoc at seal after the agent has exited. After the fix it REJECTS in-loop with the
    // contract reason, so the producer's failure is legible where it happened.
    let calls = 0;
    const invoke = makeClaudeInvoker({
      registry: registry(),
      run: () => { calls++; return INVALID; },
    });
    await expect(invoke(ctx())).rejects.toThrow(/report|title/i);
    // Bounded repair: the initial attempt plus a small, finite number of repairs — not one,
    // and not unbounded.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("an invalid first payload is REPAIRED in-loop: the re-prompt carries the exact validation error", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const invoke = makeClaudeInvoker({
      registry: registry(),
      run: (_bin, args) => {
        prompts.push(promptOf(args));
        calls++;
        return calls === 1 ? INVALID : VALID; // fix it on the second turn
      },
    });
    const out = await invoke(ctx());
    expect(out).toEqual({ title: "the finding", claims: ["a"] });
    expect(calls).toBe(2); // one repair, then success
    // The repair prompt must name the field that was wrong — a blind restart would not.
    expect(prompts[1]).toMatch(/title/i);
    expect(prompts[1]!.length).toBeGreaterThan(prompts[0]!.length); // the base prompt + a repair appendix
  });

  it("exposes a typed contract error distinct from the parse error", () => {
    // Probed as a namespace property so a missing export does not hard-fail the whole file.
    const ModelOutputContractError = (invokerModule as unknown as Record<string, unknown>)[
      "ModelOutputContractError"
    ];
    expect(ModelOutputContractError).toBeTypeOf("function");
  });
});

describe("output_write: the declared output_schema matches what the handler actually returns", () => {
  // Secondary bug of the same family: mcp.ts declared `validation_result` and the handler never
  // returned it, while the handler returned `primitive`/`output` the schema never advertised.
  const note: DomainType = {
    slug: "note", extends: "Signal", domain: "demo",
    schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
  };
  const deps = (): ServerDeps => {
    const registry = createRegistry([note]);
    return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
  };

  it("the handler returns validation_result (declared and, before the fix, never returned)", async () => {
    const r = await dispatchTool("output_write", {
      core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "sensor",
      data: { t: "x", source: "fixture://demo/sensor" },
    }, deps());
    expect(r.ok).toBe(true);
    const data = r.data as { output_id: string; validation_result?: { valid: boolean } };
    expect(data.output_id).toBeTypeOf("string");
    expect(data.validation_result).toBeDefined();
    expect(data.validation_result!.valid).toBe(true);
  });

  it("every key the handler returns is advertised in the declared output_schema", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "output_write")!;
    const declared = Object.keys((tool.output_schema as { properties: Record<string, unknown> }).properties);
    // The handler returns { output_id, primitive, output, validation_result }.
    for (const k of ["output_id", "primitive", "output", "validation_result"]) {
      expect(declared, `output_write must advertise "${k}"`).toContain(k);
    }
  });
});
