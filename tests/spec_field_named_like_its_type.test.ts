// RED — a single-output record whose FIELD shares its TYPE's name seals as the whole record.
//
// THE DEFECT. A chair may return its record bare, or keyed under its type slug. runGig tells the
// two apart by looking up `data[<type slug>]` and, when something is there, treating it as the keyed
// wrapper (src/runtime.ts, the output_specs loop before the seal). A record whose OWN schema has a
// field with the type's name is therefore misread: `{ line: "red is a colour" }` for a type named
// `line` seals the string "red is a colour" as the record, and the seal fails or seals the wrong thing.
//
// FOUND on 2026-09-16 by build gig a18eb84e. The fixture of completions-seat law 6 declared a type
// `line` with a `line` field; the builder kept that law green by patching the runtime to read a
// SCALAR under the type name as a field. That half-fix leaves the OBJECT case wrong (law 2 below):
// a type `address` with an `address` object field still seals only the inner object. The shape of
// the data alone cannot tell a wrapper from a field; the type's own schema can.
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvoker,
  type DomainType,
  type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

async function sealOne(type: DomainType, record: Record<string, unknown>) {
  const registry = createRegistry();
  registry.registerType(type);
  const agent = testAgent({ slug: "writer", primitives: ["SENSE"], input_types: [], output_types: [type.slug], domain: "demo" });
  const standard = {
    slug: "one-record", domain: "demo", agents: [agent],
    phases: [{ name: "p", chairs: [{ role: "w", agent_slug: "writer", depends_on: [], input_contract: [], output_contract: [type.slug], required_skills: [] }] }],
  } as Standard;
  const invoke: AgentInvoker = () => record;
  const res = await runGig(standard, {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke });
  return res.outputs[0]?.data as Record<string, unknown> | undefined;
}

describe("a field named like its type is a field, not the keyed wrapper", () => {
  it("LAW 1 — a SCALAR field named like its type: the whole record seals", async () => {
    const line: DomainType = {
      slug: "line", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { line: { type: "string" }, turn: { type: "number" } } },
      required_fields: ["line"],
    };
    const record = { line: "red is a colour", turn: 3, source: "fixture://line" };
    let sealed: Record<string, unknown> | undefined;
    let failure = "";
    try {
      sealed = await sealOne(line, record);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    expect(failure, "the record failed to seal because its field was read as the wrapper").toBe("");
    expect(sealed).toMatchObject(record);
  });

  it("LAW 2 — an OBJECT field named like its type: the whole record seals, not the field's value", async () => {
    const address: DomainType = {
      slug: "address", extends: "Signal", domain: "demo",
      schema: {
        type: "object",
        properties: { address: { type: "object", properties: { city: { type: "string" } } }, verified: { type: "boolean" } },
      },
      required_fields: ["address", "verified"],
    };
    const record = { address: { city: "Tokyo" }, verified: true, source: "fixture://address" };
    let sealed: Record<string, unknown> | undefined;
    let failure = "";
    try {
      sealed = await sealOne(address, record);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    expect(failure, "the record failed to seal because its object field was read as the wrapper").toBe("");
    expect(sealed, "only the inner object sealed; the rest of the record was dropped").toMatchObject(record);
  });

  it("LAW 3 (control) — a record genuinely keyed under its type still seals its inner record", async () => {
    // Green today. A fix that stops honouring the keyed form entirely goes red.
    const note: DomainType = {
      slug: "note", extends: "Signal", domain: "demo",
      schema: { type: "object", properties: { claim: { type: "string" } } }, required_fields: ["claim"],
    };
    const sealed = await sealOne(note, { note: { claim: "c", source: "fixture://note" } });
    expect(sealed).toMatchObject({ claim: "c" });
  });
});
