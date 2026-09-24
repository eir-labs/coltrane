// OPTIONAL DECLARED INPUT — a chair may declare a type it CAN read without demanding that one exist.
//
// Today every entry of a chair's `input_contract` is a demand: compose refuses a type no upstream
// chair produces, the pre-flight refuses a declared gig input the payload omits, and prepareChair
// refuses again at the seat. That is right for the common case and wrong for a real one, which
// eir-drafting hit: a chair that reads the PREVIOUS round's findings when there was a previous
// round, and runs on the first round when nothing has ever sealed one. There is no way to say so,
// so the author must either drop the type from the contract — and then it is never routed even when
// it does exist — or seal an empty record to satisfy a demand nobody meant to make.
//
//   chair.optional_inputs: string[]   ⊆ input_contract
//
// The twin of `optional_outputs` (#243), and it inherits that field's discipline exactly:
//   - it NARROWS a floor, it never widens routing. An optional type is still declared, so when it
//     IS present it is handed over as it always was. Optional means "may be absent", not "ignored".
//   - a name in `optional_inputs` that the chair does not declare in `input_contract` is REFUSED at
//     compose. A typo there silently keeps the type the author meant to relax REQUIRED while they
//     believe otherwise — the absence stands in for the declaration, which is the defect class the
//     floor exists to close.
//   - what is NOT optional stays refused, with the same two messages and the same #244 distinction
//     between a missing payload key and a mis-wired pipeline.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig,
  type AgentInvoker, type DomainType, type PhaseDef, type Standard, type OutputRecord, type Chair,
} from "../src/index.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { composeChart } from "../src/chart.js";
import { ChairSchema } from "../src/genome_schema.js";
import type { Agent } from "../src/composition.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";

const TYPES: DomainType[] = [
  { slug: "opt-brief", extends: "Plan", domain: "demo", schema: { properties: { topic: { type: "string" } } }, required_fields: [] },
  // The optional one: last round's findings, which on the first round nothing has ever sealed.
  { slug: "opt-prior", extends: "Interpretation", domain: "demo", schema: { properties: { note: { type: "string" } } }, required_fields: [] },
  // What the first phase seals when the loop has NO previous round: something, so the phase runs
  // and the pre-flight's t=0 walk is the only thing that could refuse the later chair.
  { slug: "opt-log", extends: "Signal", domain: "demo", schema: { properties: { observed: { type: "number" } } }, required_fields: [] },
  { slug: "opt-draft", extends: "Artifact", domain: "demo", schema: { properties: { text: { type: "string" } } }, required_fields: ["text"] },
];

function world() {
  const registry = createRegistry();
  for (const t of TYPES) registry.registerType(t);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

type Seen = { role: string; inputs: OutputRecord[]; gig_input: Record<string, unknown> };
function band() {
  const seen: Seen[] = [];
  const invoke: AgentInvoker = (ctx) => {
    seen.push({ role: ctx.role ?? "", inputs: [...ctx.inputs], gig_input: ctx.gig_input });
    if (ctx.agent.slug !== "reader") return { ...coreInvariantFields("Artifact"), text: "drafted" };
    // The reader seals whichever type its chair promises this round.
    return (ctx.output_types ?? []).includes("opt-log")
      ? { ...coreInvariantFields("Signal"), observed: 1 }
      : { ...coreInvariantFields("Interpretation"), note: "read" };
  };
  return { seen, invoke };
}

/**
 * Two phases. The SECOND chair declares "opt-prior" — a type the standard declares as a gig input
 * and no chair produces. It is the later phase on purpose: the pre-flight walks every chair at t=0,
 * so if the pre-flight still demanded it, phase one would never seal.
 */
function standard(opts: { optional?: string[]; priorFromUpstream?: boolean } = {}): Standard {
  const draft: Chair = {
    role: "draft", agent_slug: "drafter", depends_on: ["read"],
    input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [],
    ...(opts.optional ? { optional_inputs: opts.optional } : {}),
  } as Chair;
  return composeStandard({
    slug: "opt", domain: "demo",
    input_types: opts.priorFromUpstream ? ["opt-brief"] : ["opt-brief", "opt-prior"],
    agents: [
      testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["opt-brief"], output_types: ["opt-prior", "opt-log"], domain: "demo" }),
      testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" }),
    ],
    phases: [
      { name: "read", chairs: [{ role: "read", agent_slug: "reader", depends_on: [], input_contract: ["opt-brief"],
        // The whole difference between the two rounds: whether ANYTHING upstream seals "opt-prior".
        output_contract: [opts.priorFromUpstream ? "opt-prior" : "opt-log"], required_skills: [] }] },
      { name: "draft", chairs: [draft] },
    ] as PhaseDef[],
  });
}

describe("O — a declared input may be marked optional, and then its absence is not a refusal", () => {
  it("O1 — the chair RUNS when nothing has ever sealed its optional type, and is handed none of it", async () => {
    const w = world();
    const b = band();
    // "opt-prior" is a declared gig input, deliberately NOT supplied, and produced by no chair the
    // draft chair depends on — the first round of eir-drafting's loop.
    const std = standard({ optional: ["opt-prior"], priorFromUpstream: false });
    const res = await runGig(std, { "opt-brief": { topic: "t" } }, { ...w, invoke: b.invoke } as never);
    expect(res.status).toBe("complete");
    const seat = b.seen.find((s) => s.role === "draft")!;
    expect(seat, "the draft chair must have been seated").toBeTruthy();
    expect(seat.inputs.some((i) => i.domain_type === "opt-prior"), "nothing sealed it, so nothing is handed over").toBe(false);
    expect(seat.gig_input["opt-prior"]).toBeUndefined();
  });

  it("O2 — optional is not ignored: when the type IS present the chair still receives it", async () => {
    const w = world();
    const b = band();
    // Now an upstream chair DOES produce it. The declaration still routes it.
    const res = await runGig(standard({ optional: ["opt-prior"], priorFromUpstream: true }), { "opt-brief": { topic: "t" } }, { ...w, invoke: b.invoke } as never);
    expect(res.status).toBe("complete");
    const seat = b.seen.find((s) => s.role === "draft")!;
    expect(seat.inputs.some((i) => i.domain_type === "opt-prior"), "a present optional input is handed over exactly as a required one is").toBe(true);
  });

  it("O3 — what is NOT marked optional is still refused, with the message it always gave", async () => {
    const w = world();
    const b = band();
    // Missing DECLARED GIG INPUT — #244's payload branch.
    await expect(runGig(standard({ priorFromUpstream: false }), { "opt-brief": { topic: "t" } }, { ...w, invoke: b.invoke } as never))
      .rejects.toThrow(/opt-prior/);
    expect(b.seen.some((s) => s.role === "draft"), "the seat never ran").toBe(false);
  });

  it("O4 — marking a type optional that the chair does not declare is refused at COMPOSE", () => {
    expect(() => standard({ optional: ["opt-nowhere"] })).toThrow(
      /marks "opt-nowhere" optional but does not declare it .* optional_inputs must be a subset of input_contract/s,
    );
  });

  it("O5 — a chair that declares nothing optional is unchanged: every declared type is still demanded", () => {
    // The pipeline check at compose: "opt-prior" is neither a gig input nor produced upstream.
    expect(() =>
      composeStandard({
        slug: "opt-unwired", domain: "demo", input_types: ["opt-brief"],
        agents: [testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" })],
        phases: [{ name: "draft", chairs: [{ role: "draft", agent_slug: "drafter", depends_on: [], input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [] }] }] as PhaseDef[],
      }),
    ).toThrow(/requires "opt-prior" not produced by any upstream chair/);
  });

  // ── the chart layer ──────────────────────────────────────────────────────────────────────────
  // R7 calls an entry type with no provider a DEAD SLOT. It reads the standard's chairs directly,
  // so without this the waiver stops at the standard boundary: a movement could never be arranged
  // around a chair whose optional input nothing fills — the mechanism would work and be unreachable.
  const oneMovement = (optional: string[]) => {
    const std = composeStandard({
      slug: "opt-mv", domain: "demo", input_types: ["opt-brief", "opt-prior"],
      agents: [testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" })],
      phases: [{ name: "draft", chairs: [{ role: "draft", agent_slug: "drafter", depends_on: [], input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [], optional_inputs: optional } as Chair] }] as PhaseDef[],
    });
    return composeChart({
      chart: { slug: "opt-chart", movements: [{ movement_id: "draft", standard_slug: "opt-mv" }] } as never,
      standards: new Map([["opt-mv", std]]),
      agents: new Map<string, Agent>([["drafter", testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" }) as Agent]]),
      payload_types: ["opt-brief"],
    });
  };

  it("O7 — a chart does not call an OPTIONAL entry slot a dead slot", () => {
    const c = oneMovement(["opt-prior"]);
    expect(c.ok, c.ok ? "" : JSON.stringify(c.violations)).toBe(true);
  });

  it("O8 — the same slot, not marked optional, is still R7 (the control)", () => {
    const c = oneMovement([]);
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.violations.map((v) => v.rule)).toContain("R7");
    expect(c.violations.find((v) => v.rule === "R7")!.detail).toMatch(/dead slot.*opt-prior/);
  });

  it("O9 — one chair's waiver never excuses another chair's demand for the same type", () => {
    // Two chairs read "opt-prior"; only one calls it optional. The standard still needs a provider,
    // so the chart must still refuse. Optional is a property of a CHAIR's contract, not of a type.
    const std = composeStandard({
      slug: "opt-two", domain: "demo", input_types: ["opt-brief", "opt-prior"],
      agents: [testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" })],
      phases: [{ name: "draft", chairs: [
        { role: "lenient", agent_slug: "drafter", depends_on: [], input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [], optional_inputs: ["opt-prior"] } as Chair,
        { role: "strict", agent_slug: "drafter", depends_on: [], input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [] } as Chair,
      ] }] as PhaseDef[],
    });
    const c = composeChart({
      chart: { slug: "opt-chart-two", movements: [{ movement_id: "draft", standard_slug: "opt-two" }] } as never,
      standards: new Map([["opt-two", std]]),
      agents: new Map<string, Agent>([["drafter", testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" }) as Agent]]),
      payload_types: ["opt-brief"],
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.violations.find((v) => v.rule === "R7")!.detail).toMatch(/opt-prior/);
  });

  it("O10 — a SKILL-backed chair honours it too: the waiver is the seat's, not the agent path's", async () => {
    // prepareChair checks the contract twice, once per branch. A waiver in only the agent branch
    // would leave a skill chair — the deterministic half of a standard — refusing what the genome
    // says may be absent, and nothing here would have noticed.
    const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
    const std = composeStandard({
      slug: "opt-skill", domain: "demo", input_types: ["opt-brief", "opt-prior"],
      agents: [],
      phases: [{ name: "compute", chairs: [{
        role: "echo", agent_slug: "", skill_slug: "upstream-echo", depends_on: [],
        input_contract: ["opt-brief", "opt-prior"], output_contract: ["Signal"], required_skills: [],
        optional_inputs: ["opt-prior"],
      } as Chair] }] as PhaseDef[],
    });
    const w = world();
    const res = await runGig(std, { "opt-brief": { topic: "t" } }, {
      ...w, invoke: () => ({}), skill_dirs: new Map([["upstream-echo", join(REPO_ROOT, "tests/_support/skills/upstream-echo")]]),
    } as never);
    expect(res.status).toBe("complete");
  });

  it("O11 — the field survives the SCHEMA: a chair authored on disk keeps its waiver", () => {
    // ChairSchema strips unknown keys, so a field the schema does not name is dropped in silence and
    // the chair goes back to demanding the type while its author reads `optional_inputs` in the file
    // and believes otherwise. That is the whole defect class, one layer down.
    const parsed = ChairSchema.parse({
      role: "draft", agent_slug: "drafter", input_contract: ["opt-brief", "opt-prior"],
      output_contract: ["opt-draft"], optional_inputs: ["opt-prior"],
    });
    expect(parsed.optional_inputs).toEqual(["opt-prior"]);
    // and omitted means EVERY declared type is demanded — deny-by-default, like optional_outputs
    expect(ChairSchema.parse({ role: "r", output_contract: ["opt-draft"] }).optional_inputs).toEqual([]);
  });

  it("O6 — an optional type no upstream produces composes, where a required one does not", () => {
    // The same standard as O5, one field different. This is the compose-time half of O1: without
    // the waiver the author cannot even author the loop, let alone run its first round.
    expect(() =>
      composeStandard({
        slug: "opt-wired", domain: "demo", input_types: ["opt-brief"],
        agents: [testAgent({ slug: "drafter", primitives: ["CREATE"], input_types: ["opt-brief", "opt-prior"], output_types: ["opt-draft"], domain: "demo" })],
        phases: [{ name: "draft", chairs: [{ role: "draft", agent_slug: "drafter", depends_on: [], input_contract: ["opt-brief", "opt-prior"], output_contract: ["opt-draft"], required_skills: [], optional_inputs: ["opt-prior"] } as Chair] }] as PhaseDef[],
      }),
    ).not.toThrow();
  });
});
