// A DISPATCH PAYLOAD IS CHECKED AGAINST THE TYPES IT CLAIMS TO BE, at the door.
//
// THE DEFECT (eir-drafting, 24 Sep, with a repro): outputs are validated at the seal boundary, and
// sealed inputs are re-hashed and type-checked at the door — but a hand-typed `--input` payload was
// only HASHED, for checkpoint and reuse identity. Nothing ran it against its declared type's schema.
// Measured: `runs/library/gk-2026-manifest.json` carried four fields `drafting-instrument-charter`
// forbids and omitted two its items require, since 21 Sep. Every dispatch taking it passed. It
// surfaced only when a skill happened to SEAL a charter derived from it and the seal boundary refused.
// Months of runs on input nothing checked — an absence that returns a plausible value.
//
// THE CONTRACT: a payload value under a DECLARED input type is validated with the same compiled
// schema the seal enforces, before any chair runs, and refused naming the type and the path. A type
// the registry does not hold, and a bare core type, are not schema-checked (registry.validate's own
// rule) — the payload still reaches the chair, exactly as before.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig,
  type AgentInvoker, type DomainType, type PhaseDef, type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const CHARTER: DomainType = {
  slug: "charter", extends: "Plan", domain: "demo",
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      objective: { type: "string" },
      locators: { type: "array", items: { type: "object", additionalProperties: false, properties: { law_num: { type: "string" }, articles: { type: "array" } }, required: ["law_num", "articles"] } },
    },
  },
  required_fields: ["objective"],
};

function world() {
  const registry = createRegistry();
  registry.registerType(CHARTER);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const std = (): Standard => composeStandard({
  slug: "takes-a-charter", domain: "demo", input_types: ["charter"],
  agents: [testAgent({ slug: "reader", primitives: ["SENSE"], input_types: ["charter"], output_types: ["Signal"], domain: "demo" })],
  phases: [{ name: "read", chairs: [{ role: "r", agent_slug: "reader", depends_on: [], input_contract: ["charter"], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});

async function dispatch(payload: Record<string, unknown>) {
  const w = world();
  let calls = 0;
  const invoke: AgentInvoker = () => { calls++; return { value: "read", source: "fixture://x" }; };
  const err = await runGig(std(), payload, { ...w, invoke } as never).then(() => undefined, (e: Error) => e.message);
  return { err, calls };
}

const GOOD = { objective: "move the copyright", locators: [{ law_num: "昭和四十五年法律第四十八号", articles: ["第二十七条"] }], steps: ["draft"] };

describe("a dispatch payload is checked against its declared types", () => {
  it("I1 — a field the type forbids is refused before any chair runs, naming the type and the path", async () => {
    const { err, calls } = await dispatch({ charter: { ...GOOD, title: "GK 2026", sections: [] } });
    expect(err, "the payload passed unchecked — the eir-drafting defect").toBeTruthy();
    expect(err).toMatch(/charter/);
    expect(err).toMatch(/title|sections|additional/i);
    expect(calls, "no chair may run on input the door refused").toBe(0);
  });

  it("I2 — a missing required field, at its path", async () => {
    const missingTop = await dispatch({ charter: { locators: [] } });
    expect(missingTop.err).toMatch(/objective/);
    const missingNested = await dispatch({ charter: { ...GOOD, locators: [{ law_num: "8 Del. C." }] } });
    expect(missingNested.err, "the path of the offending item must be named").toMatch(/locators\/0|articles/);
    expect(missingNested.calls).toBe(0);
  });

  it("I3 — a payload that satisfies its type runs, unchanged", async () => {
    const { err, calls } = await dispatch({ charter: GOOD });
    expect(err, "a valid payload was refused").toBeUndefined();
    expect(calls).toBe(1);
  });

  it("I6 — a declared type the registry does not hold, and a non-object value, are not checked here", async () => {
    // Refusing an unregistered declared type at this door would fail every genome whose input type is
    // not in the registry — a compose-time question, not the payload's. And a string is not a record of
    // any type: the chair's input_contract governs whether it may run, not this schema check.
    const unregistered = composeStandard({
      slug: "takes-unregistered", domain: "demo", input_types: ["no-such-type"],
      agents: [testAgent({ slug: "reader", primitives: ["SENSE"], input_types: ["no-such-type"], output_types: ["Signal"], domain: "demo" })],
      phases: [{ name: "read", chairs: [{ role: "r", agent_slug: "reader", depends_on: [], input_contract: ["no-such-type"], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
    });
    const w = world();
    const r = await runGig(unregistered, { "no-such-type": { anything: true } }, { ...w, invoke: () => ({ value: "v", source: "fixture://x" }) } as never);
    expect(r.status).toBe("complete");
    const asString = await dispatch({ charter: "not an object" as never });
    expect(asString.err, "a non-object payload is not schema-checked at this door").toBeUndefined();
  });

  it("I4 — a key the standard does not declare, and a bare core type, are not schema-checked", async () => {
    // `notes` is not a declared input type: the existing undeclared-key report covers it, and this
    // door adds no schema opinion about it. (A near-miss of a declared key still refuses, elsewhere.)
    const { err } = await dispatch({ charter: GOOD, notes: { anything: true } });
    expect(err).toBeUndefined();
  });
});

// The door checks the SHAPE the type declares, not the seal's core substance floor: a payload is not
// a sealed output. (Validating it with validateWrite instead would refuse legitimate input for owing
// a floor only an output owes.)
describe("the door's check is the type's shape, not the seal's floor", () => {
  it("I5 — a payload satisfying its domain schema runs even without the core type's floor fields", async () => {
    const noSteps = { objective: "move the copyright" }; // a Plan's floor wants `steps`; an input owes none
    const { err, calls } = await dispatch({ charter: noSteps });
    expect(err, "the door imposed the seal's substance floor on a dispatch payload").toBeUndefined();
    expect(calls).toBe(1);
  });
});
