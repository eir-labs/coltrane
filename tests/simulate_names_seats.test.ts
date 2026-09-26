// SIMULATE NAMES THE SEATS — the pre-dispatch gate tells you WHO plays, not just how many chairs.
//
// THE DEFECT, in two parts, both reported by eir-drafting:
//
//  1. `standard_simulate` receives each phase as `{ name, chairs: <count> }` — a NUMBER. It cannot
//     name a chair, so it cannot say which chairs are FAN-OUT templates, and a run that will seat
//     22 players comes back looking like a run that seats 1.
//  2. Because it counts chairs, it PRICES chairs. A fan-out chair that expands into 22 seats is
//     quoted at one chair's cost. The tool is documented as "validate before you spend" and it
//     quotes 1/22 of the spend — a gate that cannot fail on the thing it exists to catch.
//
// THE CONTRACT. Simulate reports a SEAT PLAN: every phase, every chair by role, and for a fan-out
// chair the seats it expands into, named `role#key`, computed by the ENGINE'S OWN `expandFanOut`
// against the dispatch payload — never a re-implementation that could drift from what will run.
// Each seat reports the BYTES it would be handed, per input, after narrowing, so "which seat is too
// long, and which record made it so" is a number read before dispatch rather than a failure eight
// phases in. A split that would REFUSE is reported as a refusal in the success payload — a
// pre-flight tells you, it does not throw — exactly as `seal_drill` already does.
import { describe, it, expect } from "vitest";
import { dispatchTool } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard, type PhaseDef, type Chair } from "../src/composition.js";
import { testAgent } from "./_support/agents.js";
import type { DomainType } from "../src/registry.js";
import type { ServerDeps } from "../src/server.js";

const TYPES: DomainType[] = [
    // `expanded`/`bulk` are the fat SIBLINGS a split leaves whole — declared, because the seal
  // boundary refuses a field the type does not name (and rightly).
  { slug: "sim-charter", extends: "Plan", domain: "demo", schema: { properties: { families: { type: "array" }, steps: { type: "array" }, expanded: { type: "string" }, bulk: { type: "string" } } }, required_fields: [] },
  { slug: "sim-clause", extends: "Artifact", domain: "demo", schema: { properties: { family: { type: "string" } } }, required_fields: ["family"] },
];

const FAMILIES = [
  { family: "grant", text: "x".repeat(4000) },
  { family: "mention", text: "y".repeat(10) },
  { family: "moral", text: "z".repeat(10) },
];

function bench(fan: Chair["fan_out"]) {
  const registry = createRegistry();
  for (const t of TYPES) registry.registerType(t);
  const outputs = createOutputStore(registry);
  const std = composeStandard({
    slug: "sim-fan", domain: "demo", input_types: ["sim-charter"],
    agents: [testAgent({ slug: "composer", primitives: ["CREATE"], input_types: ["sim-charter"], output_types: ["sim-clause"], domain: "demo" })],
    phases: [{ name: "compose", chairs: [{
      role: "compose", agent_slug: "composer", depends_on: [], input_contract: ["sim-charter"],
      output_contract: ["sim-clause"], required_skills: [], fan_out: fan,
    } as Chair] }] as PhaseDef[],
  });
  const deps: ServerDeps = { registry, outputs, ledger: new MemoryLedger(), standards: new Map([[std.slug, std]]) };
  return { deps, outputs };
}

const FAN = { over: { type: "sim-charter", path: "families", key: "family" } } as Chair["fan_out"];

type Seat = { role: string; input_bytes: number; inputs: { type: string; source: string; bytes: number; largest_field?: { path: string; bytes: number } }[] };
type PlannedChair = { role: string; seats?: Seat[]; seat_count: number; refusal?: string };
type Plan = { phases: { name: string; chairs: PlannedChair[] }[]; seat_count: number };
const planOf = (r: { data?: unknown }) => (r.data as { seat_plan: Plan }).seat_plan;

describe("S — standard_simulate says which chairs are seats", () => {
  it("S1 — every chair is named by ROLE, per phase, not counted", async () => {
    const { deps } = bench(undefined);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: {}, depth: "standard" }, deps);
    expect(r.ok, r.error).toBe(true);
    const plan = planOf(r);
    expect(plan.phases.map((p) => p.name)).toEqual(["compose"]);
    expect(plan.phases[0]!.chairs.map((c) => c.role)).toEqual(["compose"]);
  });

  it("S2 — a plain chair is exactly one seat, its own role (the control)", async () => {
    const { deps } = bench(undefined);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: { "sim-charter": { families: FAMILIES } }, depth: "standard" }, deps);
    const ch = planOf(r).phases[0]!.chairs[0]!;
    expect(ch.seat_count).toBe(1);
    expect(ch.seats!.map((s) => s.role)).toEqual(["compose"]);
  });

  it("S3 — a FAN-OUT chair reports the seats it expands into, named role#key", async () => {
    const { deps } = bench(FAN);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: { "sim-charter": { families: FAMILIES } }, depth: "standard" }, deps);
    expect(r.ok, r.error).toBe(true);
    const ch = planOf(r).phases[0]!.chairs[0]!;
    expect(ch.seat_count).toBe(3);
    expect(ch.seats!.map((s) => s.role)).toEqual(["compose#grant", "compose#mention", "compose#moral"]);
    expect(planOf(r).seat_count).toBe(3);
  });

  it("S4 — each seat reports the bytes it would be handed, of the NARROWED view", async () => {
    const { deps } = bench(FAN);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: { "sim-charter": { families: FAMILIES } }, depth: "standard" }, deps);
    const seats = planOf(r).phases[0]!.chairs[0]!.seats!;
    const big = seats.find((s) => s.role === "compose#grant")!;
    const small = seats.find((s) => s.role === "compose#mention")!;
    // The whole set is ~4000 + 10 + 10. If a seat were handed the WHOLE record the two would be
    // equal — that equality IS the bug this number exists to expose.
    expect(big.input_bytes).toBeGreaterThan(4000);
    expect(small.input_bytes).toBeLessThan(1000);
    expect(big.inputs.map((i) => i.type)).toContain("sim-charter");
  });

  it("S5 — a split that would REFUSE is reported, and simulate still answers", async () => {
    const { deps } = bench({ over: { type: "sim-charter", path: "families", key: "nope" } } as Chair["fan_out"]);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: { "sim-charter": { families: FAMILIES } }, depth: "standard" }, deps);
    expect(r.ok, "a pre-flight REPORTS a refusal; it does not become one").toBe(true);
    const ch = planOf(r).phases[0]!.chairs[0]!;
    expect(ch.refusal).toMatch(/has no "nope"/);
    expect(ch.seats).toBeUndefined();
  });

  it("S6 — the estimate prices SEATS, not chair records: 3 seats cost more than 1", async () => {
    const { deps: fanned } = bench(FAN);
    const { deps: plain } = bench(undefined);
    const input = { "sim-charter": { families: FAMILIES } };
    const a = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: input, depth: "standard" }, fanned);
    const b = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: input, depth: "standard" }, plain);
    const cost = (x: { data?: unknown }) => (x.data as { estimated_cost: number }).estimated_cost;
    expect(cost(a), "a chair that seats 3 players is not one chair's worth of spend").toBeGreaterThan(cost(b));
  });

  it("S7 — the seats come from the ENGINE's split: a payload that fans out differently says so", async () => {
    // Not a re-implementation. Two items in, two seats out, named by the same key function the run
    // will use — so a drift between plan and run is impossible by construction.
    const { deps } = bench(FAN);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: { "sim-charter": { families: [{ family: "only" }] } }, depth: "standard" }, deps);
    expect(planOf(r).phases[0]!.chairs[0]!.seats!.map((s) => s.role)).toEqual(["compose#only"]);
  });

  it("S9 — each input names its LARGEST FIELD, so a fat sibling reads out loud", async () => {
    // Measured by eir-drafting on the run that failed: a seat was handed 490,779 characters to read
    // one provision of 48,849, and 434,225 of it was two sibling arrays in the same `data` object.
    // The split narrows the path it splits; every OTHER field of that record is rendered whole into
    // the prompt (claude_invoker.ts:266). "Prompt is too long" eight phases in cannot say that.
    // This line can: the number and the field name, before anything is spent.
    const registry = createRegistry();
    for (const t of TYPES) registry.registerType(t);
    const outputs = createOutputStore(registry);
    const std = composeStandard({
      slug: "sim-fat", domain: "demo", input_types: ["sim-charter"],
      agents: [testAgent({ slug: "composer", primitives: ["CREATE"], input_types: ["sim-charter"], output_types: ["sim-clause"], domain: "demo" })],
      phases: [{ name: "compose", chairs: [{
        role: "compose", agent_slug: "composer", depends_on: [], input_contract: ["sim-charter"],
        output_contract: ["sim-clause"], required_skills: [], fan_out: FAN,
      } as Chair] }] as PhaseDef[],
    });
    const deps: ServerDeps = { registry, outputs, ledger: new MemoryLedger(), standards: new Map([[std.slug, std]]) };
    const r = await dispatchTool("standard_simulate", {
      standard_slug: "sim-fat", depth: "standard",
      // `families` is split to one small item; `expanded` is the sibling that rides whole.
      mock_input: { "sim-charter": { families: [{ family: "grant" }, { family: "moral" }], expanded: "E".repeat(50_000) } },
    }, deps);
    const seat = planOf(r).phases[0]!.chairs[0]!.seats!.find((x) => x.role === "compose#grant")!;
    const input = seat.inputs.find((i) => i.type === "sim-charter")!;
    expect(input.largest_field!.path).toBe("expanded");
    expect(input.largest_field!.bytes).toBeGreaterThan(50_000 - 100);
    // and the seat's own total says it is carrying it
    expect(seat.input_bytes).toBeGreaterThan(50_000);
  });

  it("S10 — the plan works over SEALED inputs, which is how a real dispatch names its set", async () => {
    // Every law above hands the payload inline. The dispatch that matters names sealed outputs by
    // `$output`, and the seat is then handed a narrowed VIEW of a record — a different code path,
    // and the one eir-drafting runs. Without this the record path is unplanned and unmeasured.
    const { deps, outputs } = bench(FAN);
    const rec = outputs.write({
      core_type: "Plan", domain_type: "sim-charter", domain: "demo", gig_id: "g-prior",
      agent_slug: "author", primitive: "PLAN", data: { families: FAMILIES, steps: ["s"], expanded: "E".repeat(20_000) },
    });
    const r = await dispatchTool("standard_simulate", {
      standard_slug: "sim-fan", depth: "standard", mock_input: { "sim-charter": { $output: rec.id } },
    }, deps);
    expect(r.ok, r.error).toBe(true);
    const ch = planOf(r).phases[0]!.chairs[0]!;
    expect(ch.seats!.map((x) => x.role)).toEqual(["compose#grant", "compose#mention", "compose#moral"]);
    const big = ch.seats!.find((x) => x.role === "compose#grant")!;
    const small = ch.seats!.find((x) => x.role === "compose#mention")!;
    // The record is named, not "gig_input" — the plan says WHICH sealed record each seat reads.
    expect(big.inputs.find((i) => i.type === "sim-charter")!.source).toBe(rec.id);
    // The view is NARROWED: the two seats differ by their own item, ~4000 apart. Equal numbers here
    // would mean the plan measured the whole record and every seat looked identical — which is the
    // exact blindness that let a 490,779-character seat read as fine.
    expect(big.input_bytes - small.input_bytes).toBeGreaterThan(3_000);
    // and the fat sibling is named, at its full weight, in EVERY seat — because it rides whole
    expect(small.inputs.find((i) => i.type === "sim-charter")!.largest_field!.path).toBe("expanded");
    expect(small.input_bytes).toBeGreaterThan(20_000);
  });

  it("S11 — with across_sources, a seat's plan counts only the record its item came from", async () => {
    const { deps, outputs } = bench({ over: { type: "sim-charter", path: "families", key: "family", across_sources: true } } as Chair["fan_out"]);
    const a = outputs.write({ core_type: "Plan", domain_type: "sim-charter", domain: "demo", gig_id: "g1", agent_slug: "author", primitive: "PLAN", data: { families: [{ family: "grant" }], steps: ["s"], bulk: "A".repeat(30_000) } });
    const b = outputs.write({ core_type: "Plan", domain_type: "sim-charter", domain: "demo", gig_id: "g2", agent_slug: "author", primitive: "PLAN", data: { families: [{ family: "moral" }], steps: ["s"], bulk: "B".repeat(10) } });
    const r = await dispatchTool("standard_simulate", {
      standard_slug: "sim-fan", depth: "standard", mock_input: { "sim-charter": [{ $output: a.id }, { $output: b.id }] },
    }, deps);
    const seats = planOf(r).phases[0]!.chairs[0]!.seats!;
    const moral = seats.find((x) => x.role === "compose#moral")!;
    // The split DROPS the other round. A plan that still counted it would report the 30k record
    // against a seat that will never see it, and the number would be a lie in the safe direction.
    expect(moral.inputs.map((i) => i.source)).toEqual([b.id]);
    expect(moral.input_bytes).toBeLessThan(1_000);
  });

  it("S12 — largest_field DESCENDS: a skill output's nested `data` is a tautology, not an answer", async () => {
    // Measured by eir-drafting on the first real use of the seat plan. A skill seals `{data: {...}}`,
    // so the biggest TOP-LEVEL field of every source-set record in their chain is `data` — a true
    // answer that is the same answer whatever is wrong, which is no answer. The defect lives one
    // level down: `data.expanded` is 20,007 of a 51,659-byte seat, and `data.sources` (the
    // provision the seat exists to read) is 20,120.
    const registry = createRegistry();
    for (const t of TYPES) registry.registerType(t);
    const outputs = createOutputStore(registry);
    const std = composeStandard({
      slug: "sim-nested", domain: "demo", input_types: ["sim-charter"],
      agents: [testAgent({ slug: "composer", primitives: ["CREATE"], input_types: ["sim-charter"], output_types: ["sim-clause"], domain: "demo" })],
      phases: [{ name: "compose", chairs: [{
        role: "compose", agent_slug: "composer", depends_on: [], input_contract: ["sim-charter"],
        output_contract: ["sim-clause"], required_skills: [], fan_out: FAN,
      } as Chair] }] as PhaseDef[],
    });
    const deps: ServerDeps = { registry, outputs, ledger: new MemoryLedger(), standards: new Map([[std.slug, std]]) };
    const r = await dispatchTool("standard_simulate", {
      standard_slug: "sim-nested", depth: "standard",
      // Two big children on purpose: the wrapper is ~70k, its largest child 40k. A path that named
      // the child while reporting the PARENT's bytes would read as a 70,000-byte `expanded`, and a
      // caller would go carve up the wrong field.
      mock_input: { "sim-charter": { families: FAMILIES, nested: { expanded: "E".repeat(40_000), other: "O".repeat(30_000) } } },
    }, deps);
    const seat = planOf(r).phases[0]!.chairs[0]!.seats!.find((x) => x.role === "compose#mention")!;
    const lf = seat.inputs.find((i) => i.type === "sim-charter")!.largest_field!;
    expect(lf.path, "naming the wrapper is the same answer whatever is wrong").toBe("nested.expanded");
    expect(lf.bytes).toBeGreaterThan(40_000 - 100);
    expect(lf.bytes, "the bytes must be the NAMED field's, not its parent's").toBeLessThan(45_000);
  });

  it("S13 — the descent stops at an ARRAY, and at a leaf: a path is a field, not an index", async () => {
    const registry = createRegistry();
    for (const t of TYPES) registry.registerType(t);
    const outputs = createOutputStore(registry);
    const std = composeStandard({
      slug: "sim-arr", domain: "demo", input_types: ["sim-charter"],
      agents: [testAgent({ slug: "composer", primitives: ["CREATE"], input_types: ["sim-charter"], output_types: ["sim-clause"], domain: "demo" })],
      phases: [{ name: "compose", chairs: [{
        role: "compose", agent_slug: "composer", depends_on: [], input_contract: ["sim-charter"],
        output_contract: ["sim-clause"], required_skills: [], fan_out: FAN,
      } as Chair] }] as PhaseDef[],
    });
    const deps: ServerDeps = { registry, outputs, ledger: new MemoryLedger(), standards: new Map([[std.slug, std]]) };
    const r = await dispatchTool("standard_simulate", {
      standard_slug: "sim-arr", depth: "standard",
      // The fat thing is an ARRAY of objects. "expanded.0" would be an index, not a field, and a
      // caller cannot act on it — the array itself is the thing to carry or drop.
      mock_input: { "sim-charter": { families: FAMILIES, expanded: Array.from({ length: 40 }, () => ({ text: "T".repeat(1000) })) } },
    }, deps);
    const lf = planOf(r).phases[0]!.chairs[0]!.seats![0]!.inputs.find((i) => i.type === "sim-charter")!.largest_field!;
    expect(lf.path).toBe("expanded");
    expect(lf.bytes).toBeGreaterThan(40_000);
  });

  it("S14 — a declared `carry` shows up in the PLAN: the diet is visible before anything is spent", async () => {
    // The two features are one workflow: simulate names the fat field, you declare a carry list,
    // simulate says what it bought. If the plan did not reflect carry, an operator would declare a
    // diet and have no way to check it short of dispatching.
    const withCarry = bench({ over: { type: "sim-charter", path: "families", key: "family", carry: ["families"] } } as Chair["fan_out"]);
    const without = bench(FAN);
    const input = { "sim-charter": { families: FAMILIES, expanded: "E".repeat(30_000) } };
    const a = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: input, depth: "standard" }, withCarry.deps);
    const b = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: input, depth: "standard" }, without.deps);
    const seatBytes = (r: { data?: unknown }) => planOf(r).phases[0]!.chairs[0]!.seats!.find((x) => x.role === "compose#mention")!.input_bytes;
    expect(seatBytes(b), "control: the fat sibling rides whole").toBeGreaterThan(30_000);
    expect(seatBytes(a), "and a declared diet is what the seat is planned to hold").toBeLessThan(1_000);
  });

  it("S8 — with no payload to split, the chair is named as a template and says why it has no plan", async () => {
    const { deps } = bench(FAN);
    const r = await dispatchTool("standard_simulate", { standard_slug: "sim-fan", mock_input: {}, depth: "standard" }, deps);
    expect(r.ok).toBe(true);
    const ch = planOf(r).phases[0]!.chairs[0]!;
    // Absent must not quietly stand in for "one seat": an unknowable count is stated, not guessed.
    expect(ch.refusal).toMatch(/no input of type "sim-charter"/);
    expect(ch.seat_count).toBe(0);
  });
});
