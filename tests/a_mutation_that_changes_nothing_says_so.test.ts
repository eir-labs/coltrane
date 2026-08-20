// A MUTATION VERB THAT CHANGED NOTHING MUST SAY SO — NOT RETURN ok:true WITH A NEW VERSION.
//
// Two genome mutation verbs shared one defect: an argument supplied in a shape the handler does not
// read matches nothing, the real work is skipped, and the call returns SUCCESS anyway — with a
// version bump and, for type_extend, two sealed identity hashes. The caller is told the genome
// moved. It did not.
//
//   agent_evolve  reads args.changes. Field edits placed at the TOP LEVEL leave `changes`
//                 undefined, so `if (evolveSlug && changes && …)` is skipped and the handler falls
//                 through to `return { ok: true, … new_version … }`. Reported by PR #325.
//
//   type_extend   reads extension.schema.properties / .required. An `extension` supplied at the top
//                 level (e.g. {if, then}) matches neither, so addProps is {} and the "extension" is
//                 dropped — while the call returns ok:true, "additive: +0 field(s)", version 2, and
//                 sealed content/effective hashes. Observed 2026-08-20 attempting to author a
//                 conditional constraint on prior-art-hit; the constraint was silently discarded.
//
// This is the same family the codebase keeps closing, in the WRITE path: a report of success that
// nothing verifies. It is worse than a dead name, because a dead name fails closed — this fails
// open and then RECORDS the failure as a version.
//
// The fix is not to guess the caller's intent from a mis-shaped argument. It is to refuse: a
// mutation that would change nothing is an error naming the shape it expected, so the caller
// learns in one call rather than discovering it downstream when the constraint never fires.
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent } from "../src/composition.js";

// IN-MEMORY deps on purpose. Pointing these verbs at the real genome_dir would make the law MUTATE
// domain_types/ and agents/ as a side effect of running the suite — a test that writes to the
// substrate it is auditing.
const PROBE_TYPE = {
  slug: "probe-hit",
  extends: "Signal",
  domain: "test",
  schema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
  required_fields: ["source"],
};

const PROBE_AGENT = {
  slug: "probe-agent", domain: "test", primitives: ["SENSE"],
  behavioral_primitives: ["analyst"], input_types: [], output_types: ["Signal"],
  identity: "a probe", method: "1. probe", constraints: [], allowed_tools: ["Read"],
  max_tool_calls: 5,
} as unknown as Agent;

const deps = (): ServerDeps => {
  const registry = createRegistry([PROBE_TYPE as never]);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    gig_runs: new Map(),
    agents: new Map([["probe-agent", PROBE_AGENT]]),
  } as unknown as ServerDeps;
};

describe("a mutation that changes nothing says so", () => {
  it("the verbs exist and a WELL-SHAPED call still succeeds — the law is not vacuous", async () => {
    const r = await dispatchTool("type_extend", {
      slug: "probe-hit",
      extension: { schema: { properties: { probe_field_x: { type: "string" } } } },
      reason: "non-vacuity probe: a real extension must still be accepted",
    }, deps());
    expect(r.ok, `a well-shaped type_extend was refused: ${JSON.stringify(r)}`).toBe(true);
  });

  it("type_extend REFUSES an extension whose shape it does not read", async () => {
    const r = await dispatchTool("type_extend", {
      slug: "probe-hit",
      // Top-level JSON Schema keywords — the shape a caller reaches for, and the shape the handler
      // never looks at. Before this law it returned ok:true, "+0 field(s)", and a version bump.
      extension: { if: { properties: { verified: { const: true } } }, then: { required: ["verification_method"] } },
      reason: "a conditional constraint, supplied the way a caller would write it",
    }, deps());
    expect(
      r.ok,
      "type_extend accepted an extension it does not read and reported success with a version " +
        "bump — the caller is told the genome moved when nothing was added",
    ).toBe(false);
    expect(String((r as { error?: string }).error ?? ""), "the refusal must name the shape expected")
      .toMatch(/extension\.schema\.properties|fields_to_add|no field/i);
  });

  it("agent_evolve REFUSES field edits placed outside `changes`", async () => {
    const r = await dispatchTool("agent_evolve", {
      slug: "probe-agent",
      // The shape a caller reaches for. `changes` is absent, so the handler's guarded block is
      // skipped and it used to fall through to ok:true with a new_version.
      max_tool_calls: 999,
      reason: "a field edit, supplied the way a caller would write it",
    }, deps());
    expect(
      r.ok,
      "agent_evolve accepted a call with no `changes` object and reported success with a " +
        "new_version — a silent no-op recorded as a mutation",
    ).toBe(false);
    expect(String((r as { error?: string }).error ?? ""), "the refusal must name `changes`")
      .toMatch(/changes/i);
  });
});
