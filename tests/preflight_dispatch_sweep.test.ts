// Dispatch preflight — the UNIFIED t=0 sweep.
//
// The tool-grant guard (tests/preflight_tool_guard.test.ts) proved one dead-reference class is
// caught at t=0, before any chair spends. Three MORE classes were, until this sweep, discovered
// only MID-PHASE in prepareChair — after earlier chairs already ran and spent — even though every
// one of them is knowable at t=0 from the standard alone:
//
//   missing-skill-dir  — a skill-backed chair whose skill_dir is not registered
//   unknown-agent      — a chair seating an agent absent from the standard's agents list
//   no-primitive       — a seated agent with no primitives[0]
//   no-output-type     — a seated agent with no output_types[0]
//
// Unlike tool-grant, these need NO provider environment — they run UNCONDITIONALLY. Each test puts
// a CLEAN phase-0 chair ahead of the offending phase-1 chair, so a refusal at t=0 provably precedes
// any phase-0 spend: the call-counter stays 0, nothing is sealed, the ledger stays empty.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  PreflightDispatchError,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type DomainType,
} from "../src";
import type { Standard, Agent, Chair } from "../src";

const note: DomainType = {
  slug: "note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { text: { type: "string" } } },
  required_fields: ["text"],
};
const summary: DomainType = {
  slug: "summary",
  extends: "Interpretation",
  domain: "demo",
  schema: { properties: { gist: { type: "string" } } },
  required_fields: ["gist"],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(summary);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// A clean phase-0 sensor: resolves under the sweep (has a primitive, an output type, is in the
// agents list) and would ALWAYS run first if the gig were allowed to start.
const cleanSensor: Agent = {
  ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["note"],
  domain: "demo", allowed_tools: [],
} as Agent;
const senseChair: Chair = { role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
const sensePhase = { name: "sense", chairs: [senseChair] };

const makeInvoke = (counter: { n: number }): AgentInvoker => ({ agent }) => {
  counter.n++;
  if (agent.slug === "sensor") return { text: "a note", source: "test" };
  return { gist: "a summary", claims: ["c"] };
};

// Every doomed sweep must cost NOTHING: no chair invoked, nothing sealed, no ledger row.
function expectZeroSpend(counter: { n: number }, outputs: ReturnType<typeof setup>["outputs"], ledger: MemoryLedger) {
  expect(counter.n, "no chair may run when the gig is doomed at preflight").toBe(0);
  expect(outputs.all().length, "nothing sealed").toBe(0);
  expect(ledger.count(), "no ledger row").toBe(0);
}

describe("preflight sweep — missing-skill-dir class (class 2)", () => {
  it("refuses at t=0 when a skill-backed chair has no registered skill_dir — ZERO spend", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const standard: Standard = {
      slug: "sweep-skill", domain: "demo", agents: [cleanSensor],
      phases: [
        sensePhase,
        { name: "distill", chairs: [{ role: "distill", agent_slug: "", skill_slug: "ghost-skill", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      // No skill_dirs registered in deps → the skill-backed chair is a dead reference.
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    const off = err!.offenders.find((o) => o.kind === "missing-skill-dir");
    expect(off, "a missing-skill-dir offender is named").toBeDefined();
    expect(off).toMatchObject({ kind: "missing-skill-dir", chair: "distill", phase: "distill" });
    expectZeroSpend(counter, outputs, ledger);
  });
});

describe("preflight sweep — unknown-agent class (class 3)", () => {
  it("refuses at t=0 when a chair seats an agent absent from the standard — ZERO spend", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const standard: Standard = {
      slug: "sweep-ghost", domain: "demo", agents: [cleanSensor],
      phases: [
        sensePhase,
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "ghost", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    const off = err!.offenders.find((o) => o.kind === "unknown-agent");
    expect(off, "an unknown-agent offender is named").toBeDefined();
    expect(off).toMatchObject({ kind: "unknown-agent", chair: "interpret", phase: "interpret", agent: "ghost" });
    expectZeroSpend(counter, outputs, ledger);
  });
});

describe("preflight sweep — no-primitive / no-output-type class (class 4)", () => {
  it("refuses at t=0 when a seated agent declares no primitive — ZERO spend", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const noPrim: Agent = {
      ...TEST_BEHAVIOR, slug: "noprim", primitives: [], input_types: ["note"], output_types: ["summary"],
      domain: "demo", allowed_tools: [],
    } as Agent;
    const standard: Standard = {
      slug: "sweep-noprim", domain: "demo", agents: [cleanSensor, noPrim],
      phases: [
        sensePhase,
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "noprim", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    const off = err!.offenders.find((o) => o.kind === "no-primitive");
    expect(off, "a no-primitive offender is named").toBeDefined();
    expect(off).toMatchObject({ kind: "no-primitive", chair: "interpret", phase: "interpret", agent: "noprim" });
    expectZeroSpend(counter, outputs, ledger);
  });

  it("refuses at t=0 when a seated agent declares no output_type — ZERO spend", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const noOut: Agent = {
      ...TEST_BEHAVIOR, slug: "noout", primitives: ["INTERPRET"], input_types: ["note"], output_types: [],
      domain: "demo", allowed_tools: [],
    } as Agent;
    const standard: Standard = {
      slug: "sweep-noout", domain: "demo", agents: [cleanSensor, noOut],
      phases: [
        sensePhase,
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "noout", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    const off = err!.offenders.find((o) => o.kind === "no-output-type");
    expect(off, "a no-output-type offender is named").toBeDefined();
    expect(off).toMatchObject({ kind: "no-output-type", chair: "interpret", phase: "interpret", agent: "noout" });
    expectZeroSpend(counter, outputs, ledger);
  });

  it("one agent with NEITHER a primitive NOR an output type offends both — reports both", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const empty: Agent = {
      ...TEST_BEHAVIOR, slug: "empty", primitives: [], input_types: ["note"], output_types: [],
      domain: "demo", allowed_tools: [],
    } as Agent;
    const standard: Standard = {
      slug: "sweep-empty", domain: "demo", agents: [cleanSensor, empty],
      phases: [
        sensePhase,
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "empty", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    const kinds = err!.offenders.filter((o) => o.chair === "interpret").map((o) => o.kind).sort();
    expect(kinds).toEqual(["no-output-type", "no-primitive"]);
    expectZeroSpend(counter, outputs, ledger);
  });
});

describe("preflight sweep — one refusal names offenders of DIFFERENT classes across phases", () => {
  it("a standard with an unknown-agent chair AND a missing-skill-dir chair refuses once, naming both", async () => {
    const { outputs, ledger } = setup();
    const counter = { n: 0 };
    const standard: Standard = {
      slug: "sweep-mixed", domain: "demo", agents: [cleanSensor],
      phases: [
        sensePhase, // clean phase 0 — would run first if the gig started
        { name: "interpret", chairs: [{ role: "interpret", agent_slug: "ghost", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
        { name: "distill", chairs: [{ role: "distill", agent_slug: "", skill_slug: "ghost-skill", depends_on: ["sense"], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
      ],
    };
    let err: PreflightDispatchError | undefined;
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: makeInvoke(counter) });
    } catch (e) { err = e as PreflightDispatchError; }
    expect(err).toBeInstanceOf(PreflightDispatchError);
    // ONE refusal carries BOTH classes.
    const kinds = err!.offenders.map((o) => o.kind).sort();
    expect(kinds).toEqual(["missing-skill-dir", "unknown-agent"]);
    // and the message names both chairs
    expect(err!.message).toMatch(/interpret/);
    expect(err!.message).toMatch(/distill/);
    expectZeroSpend(counter, outputs, ledger);
  });
});
