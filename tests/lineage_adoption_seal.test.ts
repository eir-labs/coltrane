// The wiring, proven by running it rather than by reading it.
//
// The pure halves are covered elsewhere (lineage_adoption.test.ts, agent_lineage_grounding.test.ts).
// What those cannot show is that the decision is actually REACHED when a human seals a
// lineage-verdict inside a real gig — that the seam fires, that it finds the record the verdict
// approved, and that it stays quiet for every other kind of human chair. A green unit test beside
// an unwired seam is exactly the hollow-green shape this repo keeps finding.

import { describe, it, expect, vi } from "vitest";
import { composeStandard, defineAgent, type PhaseDef } from "../src/composition.js";
import { runGig, type AgentInvoker, type GigProgressEvent } from "../src/runtime.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const TYPES: DomainType[] = [
  // Properties are DECLARED, not left open: the registry composes a strict schema and rejects
  // additionalProperties, which is the same discipline that rejected `ungrounded_edges` on the
  // real lineage-verdict. A fixture that dodged it would not be exercising the real gate.
  { slug: "lineage-record", extends: "Artifact", domain: "lineage",
    schema: { type: "object", properties: { connections: { type: "array" } } }, required_fields: [] },
  { slug: "lineage-verdict", extends: "Verdict", domain: "lineage",
    schema: { type: "object", properties: { pass: { type: "boolean" }, approver: { type: "string" }, rationale: { type: "string" }, checks: { type: "array" } } }, required_fields: [] },
  { slug: "some-other-verdict", extends: "Verdict", domain: "test",
    schema: { type: "object", properties: { pass: { type: "boolean" }, approver: { type: "string" }, checks: { type: "array" } } }, required_fields: [] },
];

const scribe = defineAgent({
  // INTERPRET alongside CREATE because composeStandard refuses a CREATE chair that opens a
  // standard with no upstream reasoning — a real genome law, not a fixture quirk.
  slug: "scribe", primitives: ["INTERPRET", "CREATE"], input_types: [], output_types: ["lineage-record"],
  domain: "lineage", identity: "you compose", method: "1. read 2. compose 3. stop",
  constraints: [], behavioral_primitives: ["synthesizer", "executor"],
});

// The Verdict core type refuses an empty checks[] — an unchecked verdict is not a verdict.
const CHECKS = [{ method: "read the record", result: "grounded on both sides" }];
const RECORD = { id: "rec-1", connections: [{ relation: "descends-from" }], validation_criteria: ["checkable"] };

const std = (verdictType: string) => composeStandard({
  slug: "compose-then-adopt", domain: "lineage", agents: [scribe],
  phases: [
    { name: "compose", chairs: [{ role: "compose", agent_slug: "scribe", depends_on: [], input_contract: [], output_contract: ["lineage-record"], optional_outputs: [], required_skills: [] }] },
    { name: "approve", chairs: [{ role: "approve", human: true, agent_slug: "", depends_on: ["compose"], input_contract: [], output_contract: [verdictType], optional_outputs: [], required_skills: [] }] },
  ] as PhaseDef[],
});

async function run(verdictType: string, approval: Record<string, unknown>) {
  const events: GigProgressEvent[] = [];
  const registry = createRegistry(TYPES);
  const res = await runGig(std(verdictType), {}, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke: vi.fn(async () => RECORD) as unknown as AgentInvoker,
    approvals: { approve: approval },
    approved_by: "eugene",
    onProgress: (ev: GigProgressEvent) => events.push(ev),
  } as never);
  return { res, events, adoption: events.filter((e) => e.type === "lineage_adoption") };
}

describe("the adoption decision is reached at the human seal", () => {
  it("fires with adopt:true on a passing, signed lineage-verdict", async () => {
    const { res, adoption } = await run("lineage-verdict", { pass: true, approver: "eugene", rationale: "grounded", checks: CHECKS });
    expect(res.status).not.toBe("awaiting_approval");
    expect(adoption).toHaveLength(1);
    expect(adoption[0]).toMatchObject({ type: "lineage_adoption", role: "approve", adopt: true, approved_by: "eugene" });
  });

  it("names the record the verdict approved — not some other output", async () => {
    const { res, adoption } = await run("lineage-verdict", { pass: true, approver: "eugene", checks: CHECKS });
    const record = res.outputs.find((o) => o.domain_type === "lineage-record");
    expect(record).toBeDefined();
    // The ref is the content_sha of the approved input, which is the same value the verdict's
    // own input_shas carry. If these ever disagree, the adoption is grounding something the
    // approver did not sign.
    expect((adoption[0] as { record_ref?: string }).record_ref).toBe(record!.content_sha);
    const verdict = res.outputs.find((o) => o.domain_type === "lineage-verdict");
    expect(verdict!.input_shas).toContain(record!.content_sha);
  });

  it("fires with adopt:false and the refusal when the verdict does not pass", async () => {
    const { adoption } = await run("lineage-verdict", { pass: false, approver: "eugene", checks: CHECKS });
    expect(adoption).toHaveLength(1);
    expect(adoption[0]).toMatchObject({ adopt: false });
    expect((adoption[0] as { refusals?: string[] }).refusals).toContain("not-a-pass");
  });

  it("refuses an unsigned pass at the seal, not just in the unit", async () => {
    const { adoption } = await run("lineage-verdict", { pass: true, checks: CHECKS });
    expect(adoption[0]).toMatchObject({ adopt: false });
    expect((adoption[0] as { refusals?: string[] }).refusals).toContain("no-approver");
  });

  it("stays SILENT for a human chair sealing anything other than a lineage-verdict", async () => {
    const { res, adoption } = await run("some-other-verdict", { pass: true, approver: "eugene", checks: CHECKS });
    expect(res.outputs.some((o) => o.domain_type === "some-other-verdict")).toBe(true);
    expect(adoption).toHaveLength(0);
  });
});

describe("the ENTRY human chair — a record seeded from the dispatch payload", () => {
  // lineage-adopt-v0's only chair is human with depends_on []. Every test above seats the human
  // chair downstream of a compose phase, so every one of them passed while the real standard's
  // adoption was blind. This is the case that was missing, and it is the only shape that standard
  // will ever run in.
  const entryStd = () => composeStandard({
    // input_types declares that the GIG supplies the record — which is how composeStandard
    // permits an entry chair to require a type no upstream chair produces. The real
    // lineage-adopt-v0 declares exactly this.
    slug: "adopt-only", domain: "lineage", agents: [], input_types: ["lineage-record"],
    phases: [
      { name: "approve", chairs: [{ role: "approve", human: true, agent_slug: "", depends_on: [], input_contract: ["lineage-record"], output_contract: ["lineage-verdict"], optional_outputs: [], required_skills: [] }] },
    ] as PhaseDef[],
  });

  async function runEntry(payload: Record<string, unknown>, approval: Record<string, unknown>) {
    const events: GigProgressEvent[] = [];
    await runGig(entryStd(), payload, {
      outputs: createOutputStore(createRegistry(TYPES)),
      ledger: new MemoryLedger(),
      invoke: vi.fn() as unknown as AgentInvoker,
      approvals: { approve: approval },
      approved_by: "eugene",
      onProgress: (ev: GigProgressEvent) => events.push(ev),
    } as never);
    return events.filter((e) => e.type === "lineage_adoption");
  }

  it("adopts a payload-seeded record by its slug id", async () => {
    const a = await runEntry(
      { "lineage-record": { id: "lineage-record--subject--abc", connections: [] } },
      { pass: true, approver: "eugene", checks: CHECKS },
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ adopt: true, record_ref: "lineage-record--subject--abc", approved_by: "eugene" });
  });

  it("still refuses when the payload record has no id to reference", async () => {
    const a = await runEntry(
      { "lineage-record": { connections: [] } },
      { pass: true, approver: "eugene", checks: CHECKS },
    );
    expect(a[0]).toMatchObject({ adopt: false });
    expect((a[0] as { refusals?: string[] }).refusals).toContain("no-record-ref");
  });
});
