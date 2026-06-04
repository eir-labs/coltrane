// e2e — T11: type-fail at the output_write BOUNDARY (runtime side).
//
// Probe: when a DETERMINISTIC invoker returns a payload that violates the
// agent's output_type schema, the gig_dispatch loop must reject the write
// at the registry boundary (outputs.write → registry.validate → throw),
// surface a typed error, and persist NOTHING in the output store.
//
// Two probes, same shape:
//   (a) missing required field           — omit `capture_ts` from a Signal
//   (b) wrong type for a declared field  — payload_bytes: 42 (number, not string)
//
// RED iff either is accepted silently — that means the validator was bypassed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, bootstrapServerDeps, type ServerDeps, type AgentInvoker } from "../../src/index.js";

async function setupProbe(env: TempdirColtrane, invoke: AgentInvoker, fieldPrefix: string): Promise<{ deps: ServerDeps; typeSlug: string; standardSlug: string; fields: { payload: string; source: string; ts: string } }> {
  // shape-distinct per setup: rename the three required fields with a per-probe
  // prefix so the §5 reuse-enforcement (field_coverage ratio) drops to 0.
  const tag = Math.random().toString(36).slice(2, 8);
  const typeSlug = `t11-strict-signal-${tag}`;
  const agentSlug = `t11-sensor-${tag}`;
  const standardSlug = `t11-pipeline-${tag}`;
  const fields = { payload: `${fieldPrefix}_payload`, source: `${fieldPrefix}_source`, ts: `${fieldPrefix}_ts` };
  const deps = bootstrapServerDeps(env.tempDir);
  deps.invoke = invoke;
  const tReg = await dispatchTool("type_register", {
    slug: typeSlug, extends: "Signal", domain: `t11-${tag}`,
    schema: { type: "object", properties: {
      [fields.payload]: { type: "string" },
      [fields.source]: { type: "string" },
      [fields.ts]: { type: "string" },
    } },
    required_fields: [fields.payload, fields.source, fields.ts],
  }, deps);
  if (!tReg.ok) throw new Error(`type_register failed for ${typeSlug}: ${tReg.error}`);
  const aDef = await dispatchTool("agent_define", {
    slug: agentSlug, primitives: ["SENSE"], input_types: [], output_types: [typeSlug], domain: `t11-${tag}`,
  }, deps);
  if (!aDef.ok) throw new Error(`agent_define failed for ${agentSlug}: ${aDef.error}`);
  const sCom = await dispatchTool("standard_compose", {
    slug: standardSlug, domain: `t11-${tag}`,
    agents: [{ slug: agentSlug, primitives: ["SENSE"], input_types: [], output_types: [typeSlug], domain: `t11-${tag}` }],
    phases: [{ name: "sense", agent: agentSlug }],
  }, deps);
  if (!sCom.ok) throw new Error(`standard_compose failed for ${standardSlug}: ${sCom.error}`);
  const refreshed = bootstrapServerDeps(env.tempDir);
  deps.standards = refreshed.standards;
  return { deps, typeSlug, standardSlug, fields };
}

async function probeBadPayload(env: TempdirColtrane, fieldPrefix: string, mkBad: (f: { payload: string; source: string; ts: string }) => Record<string, unknown>): Promise<{ rejected: boolean; error: string; outputCount: number }> {
  const invoke: AgentInvoker = () => ({}); // overridden below — we need the field-prefix first
  const setup = await setupProbe(env, invoke, fieldPrefix);
  // wire the actual bad payload now that field names are bound
  setup.deps.invoke = () => mkBad(setup.fields);
  const dispatch = await dispatchTool("gig_dispatch", { standard_slug: setup.standardSlug, input: {} }, setup.deps);
  const errMsg = String(dispatch.error ?? "");
  const q = await dispatchTool("output_query", { domain_type: setup.typeSlug }, setup.deps);
  const outs = (q.data as { outputs: unknown[] }).outputs;
  return { rejected: dispatch.ok === false, error: errMsg, outputCount: outs.length };
}

describe("T11 — type-fail at output_write boundary (runtime invoker → registry validator)", () => {
  let env: TempdirColtrane;
  let missingFieldVerdict = "unknown";
  let wrongTypeVerdict = "unknown";

  beforeAll(async () => { env = await setupTempdirColtrane(); }, 120_000);
  afterAll(() => {
    env?.cleanup();
    // eslint-disable-next-line no-console
    console.log(`─── type_fail_boundary receipt ─── missing_field=${missingFieldVerdict} wrong_type=${wrongTypeVerdict}`);
  });

  it("probe A: invoker omits a required field → gig_dispatch returns ERROR, store stays empty", async () => {
    const r = await probeBadPayload(env, "miss", (f) => ({ [f.payload]: "0xCAFEBABE", [f.source]: "t11://probe/a" /* ts MISSING */ }));
    missingFieldVerdict = r.rejected && r.outputCount === 0 ? "rejected" : "accepted";
    expect(r.rejected, `gig_dispatch returned ok=true for missing-required-field payload. error=${r.error}`).toBe(true);
    expect(r.error.toLowerCase()).toMatch(/output rejected|required|schema|valid/);
    expect(r.outputCount, `record(s) leaked into the store after a rejected write: ${r.outputCount}`).toBe(0);
  });

  it("probe B: invoker returns wrong TYPE for a field (number not string) → gig_dispatch returns ERROR, store stays empty", async () => {
    const r = await probeBadPayload(env, "wrong", (f) => ({ [f.payload]: 42, [f.source]: "t11://probe/b", [f.ts]: "2026-06-04T00:00:00Z" }));
    wrongTypeVerdict = r.rejected && r.outputCount === 0 ? "rejected" : "accepted";
    expect(r.rejected, `gig_dispatch returned ok=true for wrong-type-field payload. error=${r.error}`).toBe(true);
    expect(r.error.toLowerCase()).toMatch(/output rejected|type|string|schema|valid/);
    expect(r.outputCount, `record(s) leaked into the store after a rejected write: ${r.outputCount}`).toBe(0);
  });

  it("positive control: a well-formed payload IS accepted (proves the gate isn't blanket-rejecting)", async () => {
    const setup = await setupProbe(env, () => ({}), "ok");
    setup.deps.invoke = () => ({ [setup.fields.payload]: "0xDEADBEEF", [setup.fields.source]: "t11://probe/ok", [setup.fields.ts]: "2026-06-04T00:00:00Z" });
    const r = await dispatchTool("gig_dispatch", { standard_slug: setup.standardSlug, input: {} }, setup.deps);
    expect(r.ok, `well-formed payload rejected: ${r.error}`).toBe(true);
    const q = await dispatchTool("output_query", { domain_type: setup.typeSlug }, setup.deps);
    expect((q.data as { outputs: unknown[] }).outputs.length).toBeGreaterThanOrEqual(1);
  });
});
