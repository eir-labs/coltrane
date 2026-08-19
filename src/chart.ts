// THE CHART — one gig as a performance of many standards.
//
// A standard is a phase graph over chairs. A chart is the same idea one level up: a typed DAG over
// STANDARDS, where each MOVEMENT names one and typed EDGES carry a movement's SEALED OUTPUTS into
// the next movement's entry chairs. Everything a standard already refuses at compose time, a chart
// refuses at compose time too — a cycle, an edge naming a type nothing seals, an unclassified
// conditional flow, an entry slot with no provider, a gate key colliding with a human chair — so a
// misarranged performance dies where it is authored, never at minute nine.
//
// THREE SEAMS THIS MODULE OWNS, AND WHY THEY ARE HERE AND NOT IN runtime.ts:
//
//  1. COMPOSE (`composeChart`). Eleven rules in a fixed firing order, each independently testable
//     against a minimal violating input, returning a STRUCTURED violation list. A rule that fires
//     stops the walk: a chart is refused for one named reason, not for a heap of cascading ones.
//  2. IDENTITY (`chartHash`). The arrangement's own hash, folded into `run_fingerprint` in the slot
//     that held `genome_hash`. For the degenerate one-movement chart it SHORT-CIRCUITS to
//     `genomeHash(standard)` verbatim, which is what makes a single-standard gig's fingerprint
//     byte-identical to what it was before charts existed.
//  3. PERFORM (`runChart`). Walk the movements in topological order, calling `runGig` per movement.
//     The runtime stays the thing that runs ONE standard; the chart is the thing that arranges
//     several. Between movements — the only place a stop is free — the chart checks the approval
//     gates and the budget envelope, and records what completed so a resume never re-derives it.
//
// Spec: sealed design gig 51fda6b1 (product-design-v1), design-concept `chart-schema-spec-001`,
// verified by a deliver-phase verdict (7/7) and approved by the governor. The ChartSchema itself
// lives with every other genome class in src/genome_schema.ts — one Zod source, no exceptions.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChartSchema, type ChartInput, type ChartOutput, type ChartEdgeOutput, type ChartApprovalGateOutput, type VenueOutput } from "./genome_schema.js";
import { toolBaseName } from "./tool_providers.js";
import type { Agent, Chair, Standard } from "./composition.js";
import { composeMovementGigId, type OutputRecord } from "./outputs.js";
import { canonJson, sha256Hex, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import { producersSha, CHECKPOINT_SCHEMA_VERSION, type CheckpointRole, type GigCheckpoint, type PriorBudgetState, type RunIdentity } from "./reuse.js";
import { runGig, genomeHash, outputSatisfiesType, CORE_TO_PRIMITIVE, ResumeRefused, type GigResult, type RunDeps } from "./runtime.js";
import { drainGigHeader } from "./output_mirror.js";

export type Chart = ChartOutput;
export type ChartMovement = Chart["movements"][number];
export type ChartEdge = ChartEdgeOutput;
export type ChartApprovalGate = ChartApprovalGateOutput;
/** The room a performance is held in. Its shape is `VenueSchema` (one Zod source); its only engine
 *  behaviour today is the ceiling rule below, which is why the type surfaces from this module. */
export type Venue = VenueOutput;

/** A movement with its standard RESOLVED — the composition's output, and what a run walks. */
export interface ResolvedMovement {
  movement_id: string;
  standard: Standard;
  runtime_fills: Record<string, unknown>;
  seatings: Chart["movements"][number]["seatings"];
}

/** How an edge was classified by R6. A `conditional` edge may legitimately carry nothing. */
export interface ClassifiedEdge {
  from_movement: string;
  to_movement: string;
  output_type: string;
  kind: "hard" | "conditional";
}

/** One refusal, located. Never a bare boolean: a chart is refused FOR something, at a place. */
export interface ChartViolation {
  /** "R0".."R9" — the rule that fired, so a caller can act on the class of defect. */
  rule: string;
  detail: string;
  movement_id?: string;
  edge?: { from_movement: string; to_movement: string; output_type: string };
  gate_id?: string;
}

/** Everything a performance needs, and nothing it has not been checked for. */
export interface ChartPlan {
  chart: Chart;
  movements: readonly ResolvedMovement[];
  /** Topological order over edges ∪ gate ordering — the order `runChart` walks. */
  order: readonly string[];
  edges_classified: readonly ClassifiedEdge[];
  chart_hash: string;
}

export type ChartComposition =
  | (ChartPlan & { ok: true; violations: readonly ChartViolation[] })
  | { ok: false; violations: readonly ChartViolation[] };

export interface ChartComposeInput {
  chart: ChartInput;
  /** The caller's genome. A movement's standard resolves here or the movement is a dead name. */
  standards: ReadonlyMap<string, Standard>;
  /** For R3: a seating names an agent, and an agent that does not exist is a dead seat. */
  agents?: ReadonlyMap<string, Agent> | undefined;
  /**
   * For R10: the rooms this caller knows. A chart that names a `venue` is composable ONLY against a
   * map that holds it — an unresolvable ceiling is not an absent ceiling, so a caller who knows no
   * venues cannot compose a chart that names one. A chart with no `venue` never consults this.
   */
  venues?: ReadonlyMap<string, Venue> | undefined;
  /**
   * The types the chart's DISPATCH PAYLOAD will carry — the third way an entry slot can be filled
   * (R7), beside an incoming hard edge and a movement's `runtime_fills`.
   *
   * Declared at compose time on purpose. A payload is a dispatch-time fact, but "which types this
   * performance is seeded with" is an authoring-time DECISION, exactly as a standard declares its
   * `input_types` rather than discovering them at t=0. Absent = the chart declares no payload, and
   * a required entry slot with no edge and no fill is a dead slot.
   */
  payload_types?: readonly string[] | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Identity
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** One movement, no edges, no gates: the single-standard gig, wearing the chart's clothes. */
export function isDegenerateChart(chart: {
  movements: readonly unknown[];
  edges?: readonly unknown[];
  approval_gates?: readonly unknown[];
}): boolean {
  return chart.movements.length === 1 && (chart.edges?.length ?? 0) === 0 && (chart.approval_gates?.length ?? 0) === 0;
}

/**
 * The arrangement's identity.
 *
 * MOVEMENT lines (sorted by movement_id) fold `movement_id` with the movement's standard
 * projection; EDGE lines (sorted) fold the endpoints, the type and the declared `optional` flag;
 * GATE lines fold the arrangement's human seats. Declaration order therefore cannot move the hash,
 * and the same standards arranged differently cannot share it.
 *
 * The standard projection is `genomeHash(standard)` ITSELF, deliberately: the spec asked for "the
 * same field set genomeHash folds today", and the only way to guarantee those are the same bytes —
 * now and after the next change to that field set — is to call the same function. It is also what
 * makes the degenerate short-circuit below an exact identity rather than a coincidence.
 */
export function chartHash(plan: {
  movements: readonly ResolvedMovement[];
  chart: { edges?: readonly ChartEdge[] | undefined; approval_gates?: readonly ChartApprovalGate[] | undefined };
}): string {
  const edges = plan.chart.edges ?? [];
  const gates = plan.chart.approval_gates ?? [];
  // THE SHORT-CIRCUIT. A one-movement, no-edge, no-gate chart hashes to exactly what its standard
  // hashed to before charts existed — no movement_id, no wrapper bytes. Falsifiable, and falsified
  // by tests/chart.test.ts: chartHash(oneMovement) === genomeHash(sameStandard).
  if (plan.movements.length === 1 && edges.length === 0 && gates.length === 0) {
    return genomeHash(plan.movements[0]!.standard);
  }
  const movementLines = [...plan.movements]
    .map((m) => `M\t${m.movement_id}\t${genomeHash(m.standard)}`)
    .sort();
  // The DECLARED edge, `optional` flag included — the arrangement as authored, per the spec's
  // formula. (The R6 classification is derivable from it plus the source movement's projection,
  // which is already folded above, so nothing is lost by folding the declaration instead.)
  const edgeLines = [...edges]
    .map((e) => `E\t${e.from_movement}\t${e.to_movement}\t${e.output_type}\t${e.optional}`)
    .sort();
  // GATE lines are an addition to the spec's two-line formula, deliberately: an approval gate
  // changes what the performance DOES (it requires a person), so a chart that gained one is not the
  // same arrangement, and a resume across the change must be refused rather than silently accepted.
  const gateLines = [...gates]
    .map((g) => `G\t${g.gate_id}\t${g.after_movement}\t${g.before_movement}\t${g.chair}`)
    .sort();
  return sha256Hex([...movementLines, ...edgeLines, ...gateLines].join("\n") + "\n");
}

/**
 * Desugar a bare `standard_slug` into the chart it always was.
 *
 * `chart_slug == movement_id == standard_slug`, no edges, no gates, and the dispatch payload
 * becomes the movement's `runtime_fills`. Every existing caller path is preserved because a
 * single-standard gig IS this chart.
 */
export function degenerateChart(standard_slug: string, gig_input?: Record<string, unknown>): Chart {
  return ChartSchema.parse({
    slug: standard_slug,
    movements: [{ movement_id: standard_slug, standard_slug, runtime_fills: gig_input ?? {} }],
  });
}

/**
 * The dispatch target refine: EXACTLY ONE of `standard_slug` / `chart_slug`.
 *
 * Both optional at the outer level (so no existing caller's shape breaks) and refined to
 * exactly-one, because "a standard AND a chart" names two performances and "neither" names none.
 */
export function dispatchTarget(args: { standard_slug?: string | undefined; chart_slug?: string | undefined }):
  | { ok: true; kind: "standard" | "chart"; slug: string }
  | { ok: false; error: string } {
  const std = (args.standard_slug ?? "").trim();
  const chart = (args.chart_slug ?? "").trim();
  if (std !== "" && chart !== "") {
    return { ok: false, error: `dispatch names exactly one target: standard_slug "${std}" and chart_slug "${chart}" are both set. A single-standard dispatch IS the one-movement chart — pass one.` };
  }
  if (std === "" && chart === "") {
    return { ok: false, error: `dispatch names exactly one target: neither standard_slug nor chart_slug was supplied.` };
  }
  return std !== "" ? { ok: true, kind: "standard", slug: std } : { ok: true, kind: "chart", slug: chart };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Compose — R0..R10, in firing order
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The charset the checkpoint store's path guard admits. An id outside it cannot be resumed. */
const MOVEMENT_ID_SAFE = /^[A-Za-z0-9._-]+$/;

/** Roles nothing else depends on: the seats whose outputs leave the standard. */
function terminalRoles(standard: Standard): Set<string> {
  const depended = new Set<string>();
  for (const ph of standard.phases) for (const ch of ph.chairs) for (const d of ch.depends_on) depended.add(d);
  const out = new Set<string>();
  for (const ph of standard.phases) for (const ch of ph.chairs) if (!depended.has(ch.role)) out.add(ch.role);
  return out;
}

function chairsOf(standard: Standard): Chair[] {
  return standard.phases.flatMap((p) => [...p.chairs]);
}

/**
 * What a standard SEALS, split by whether it is promised or merely possible.
 *
 * `required` is the union of the standard's declared `output_types` and every terminal chair's
 * promised-and-not-optional contract. The union, not just the declaration, because
 * `Standard.output_types` is optional in the schema and a type a terminal chair genuinely seals is
 * sealed whether or not the standard restates it — a rule that called that a dead name would refuse
 * most real standards.
 */
function sealedTypes(standard: Standard): { required: Set<string>; optional: Set<string> } {
  const terminal = terminalRoles(standard);
  const required = new Set<string>(standard.output_types ?? []);
  const optional = new Set<string>();
  for (const ch of chairsOf(standard)) {
    if (!terminal.has(ch.role)) continue;
    const opt = new Set(ch.optional_outputs ?? []);
    for (const t of ch.output_contract) (opt.has(t) ? optional : required).add(t);
  }
  for (const t of required) optional.delete(t);
  return { required, optional };
}

/**
 * The types a movement must receive FROM OUTSIDE its standard.
 *
 * A type is an outside need when a chair consumes it, the standard declares it as a gig input
 * (#177's contract — the standard's own statement that it comes from elsewhere), and no chair in
 * the standard produces it. Anything else is the standard's internal dataflow, which
 * `composeStandard` has already validated and which is none of the chart's business.
 */
function outsideNeeds(standard: Standard): string[] {
  const declared = new Set(standard.input_types ?? []);
  const producedInside = new Set<string>();
  for (const ch of chairsOf(standard)) for (const t of ch.output_contract) producedInside.add(t);
  const needs = new Set<string>();
  for (const ch of chairsOf(standard)) {
    for (const t of ch.input_contract) {
      if (!declared.has(t) || producedInside.has(t)) continue;
      needs.add(t);
    }
  }
  return [...needs];
}

/**
 * The effective tool set of one agent in one room: its OWN grants, intersected with the room's
 * equipment. Grants are returned as the agent declared them (scoping intact) and matched on their
 * BASE name, because that is how every other grant resolution in the engine matches — a room that
 * holds `Bash` holds `Bash(npx vitest run:*)`.
 *
 * The direction is the whole point: this can only ever return a subset of `agent.allowed_tools`. A
 * tool present in the room and absent from the charter does not appear, so a venue cannot hand a
 * player authority its charter never claimed.
 */
export function venueEffectiveTools(agent: Agent, venue: Venue): string[] {
  const room = new Set(venue.equipment.tools.map(toolBaseName));
  return (agent.allowed_tools ?? []).filter((g) => room.has(toolBaseName(g)));
}

/**
 * The types a chart's SOURCE movements are seeded with — the honest answer to R7 at load time.
 *
 * R7 refuses a movement whose required outside input has no provider: no incoming hard edge, no
 * `runtime_fills` entry, and not declared on the dispatch payload. The payload is a dispatch-time
 * fact, so a LOADER cannot know it — and a loader that passed nothing would make every chart whose
 * first movement declares a gig contract unloadable, which is not a defect in the chart.
 *
 * So the load-time answer is this: a movement with NO incoming edge is a boundary movement, seeded
 * from outside the arrangement, and its standard's own `input_types` — the standard's declaration
 * that these types enter from elsewhere (#177) — are what the payload is expected to carry. An
 * INTERIOR movement gets nothing from here, so the dead slot R7 exists for (movement B needs a type
 * and nothing upstream produces it) still fires at load.
 *
 * The strict check happens where the payload is a fact: `gig_dispatch` re-composes the chart with
 * the real payload's keys, so a dispatch that does not actually carry the seed is refused there.
 */
export function chartEntrySeedTypes(chart: Chart, standards: ReadonlyMap<string, Standard>): string[] {
  const hasIncoming = new Set(chart.edges.map((e) => e.to_movement));
  const seeds = new Set<string>();
  for (const m of chart.movements) {
    if (hasIncoming.has(m.movement_id)) continue;
    for (const t of standards.get(m.standard_slug)?.input_types ?? []) seeds.add(t);
  }
  return [...seeds];
}

/** When a Zod refusal carries BOTH an unrecognized key K and a missing required field F — in the
 *  SAME object — such that F ends with K (`movement_id`.endsWith(`id`)), the author almost certainly
 *  meant F. Return a phrase linking the two so the R0 detail can name the near-miss. Suffix
 *  containment covers the reported pair (`id` → `movement_id`) with no string-distance dependency;
 *  matching within one object path guards against pairing keys from two unrelated movements. */
function describeNearMiss(issues: readonly z.ZodIssue[]): string | null {
  const unrecognized: { key: string; parent: string }[] = [];
  const required: { field: string; parent: string }[] = [];
  for (const iss of issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) unrecognized.push({ key: k, parent: iss.path.join(".") });
    } else if (iss.code === "invalid_type" && iss.received === "undefined") {
      const field = iss.path[iss.path.length - 1];
      if (typeof field === "string") required.push({ field, parent: iss.path.slice(0, -1).join(".") });
    }
  }
  for (const u of unrecognized) {
    const hit = required.find((r) => r.parent === u.parent && r.field !== u.key && r.field.endsWith(u.key));
    if (hit) return `unrecognized key "${u.key}" is a near-miss for the required key "${hit.field}" — did you mean "${hit.field}"?`;
  }
  return null;
}

export function composeChart(input: ChartComposeInput): ChartComposition {
  const V = (v: ChartViolation[]): ChartComposition => ({ ok: false, violations: v });

  // ── R0 schema ────────────────────────────────────────────────────────────────────────────────
  // A malformed chart never reaches the relational rules.
  let chart: Chart;
  try {
    chart = ChartSchema.parse(input.chart);
  } catch (e) {
    const base = `chart does not parse: ${e instanceof Error ? e.message : String(e)}`;
    // The schema already knows the expected key. When the refusal carries an unrecognized key that
    // is a near-miss for a missing required one (e.g. a movement keyed `id` where `movement_id` is
    // required), name it — the refusal still stands, but the author is told which key was meant
    // instead of being left to reconcile two unrelated Zod lines.
    const nearMiss = e instanceof z.ZodError ? describeNearMiss(e.issues) : null;
    return V([{ rule: "R0", detail: nearMiss ? `${base} — ${nearMiss}` : base }]);
  }

  // ── R1 movement_id uniqueness (and addressability) ───────────────────────────────────────────
  // Must fire before every rule that keys on movement_id — which, after R1, is all of them.
  {
    const violations: ChartViolation[] = [];
    const seen = new Set<string>();
    for (const m of chart.movements) {
      if (seen.has(m.movement_id)) {
        violations.push({ rule: "R1", movement_id: m.movement_id, detail: `duplicate movement_id "${m.movement_id}" — movement_id is the checkpoint and reuse namespace, so two movements sharing one would share each other's cached work.` });
      }
      seen.add(m.movement_id);
      if (!MOVEMENT_ID_SAFE.test(m.movement_id)) {
        violations.push({ rule: "R1", movement_id: m.movement_id, detail: `movement_id "${m.movement_id}" is not addressable: a checkpoint id must match ${String(MOVEMENT_ID_SAFE)}. An id outside that charset reads back as "no checkpoint", which would make this movement silently un-resumable.` });
      }
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R2 standard resolution ───────────────────────────────────────────────────────────────────
  const resolved: ResolvedMovement[] = [];
  {
    const violations: ChartViolation[] = [];
    for (const m of chart.movements) {
      const standard = input.standards.get(m.standard_slug);
      if (!standard) {
        violations.push({ rule: "R2", movement_id: m.movement_id, detail: `unknown standard "${m.standard_slug}" in movement "${m.movement_id}" — it resolves to nothing in this genome.` });
        continue;
      }
      resolved.push({ movement_id: m.movement_id, standard, runtime_fills: m.runtime_fills, seatings: m.seatings });
    }
    if (violations.length > 0) return V(violations);
  }
  const byId = new Map(resolved.map((m) => [m.movement_id, m]));

  // ── R3 seating resolution (dead seat) ────────────────────────────────────────────────────────
  // The same defect class as a granted tool with no provider: a seating that names a chair the
  // standard does not declare, or an agent the genome does not hold, backs nothing.
  {
    const violations: ChartViolation[] = [];
    for (const m of resolved) {
      const roles = new Set(chairsOf(m.standard).map((c) => c.role));
      for (const s of m.seatings) {
        if (!roles.has(s.chair)) {
          violations.push({ rule: "R3", movement_id: m.movement_id, detail: `movement "${m.movement_id}" seats chair "${s.chair}", which standard "${m.standard.slug}" does not declare. Declared chairs: [${[...roles].join(", ")}].` });
        }
        if (input.agents && !input.agents.has(s.agent_slug)) {
          violations.push({ rule: "R3", movement_id: m.movement_id, detail: `movement "${m.movement_id}" seats agent "${s.agent_slug}" in chair "${s.chair}", and no such agent resolves in this genome — a dead seat.` });
        }
      }
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R4 edge + gate endpoint resolution ───────────────────────────────────────────────────────
  // Gate endpoints are resolved HERE, not with the gate keys in R8, because R5's graph includes
  // gate ordering edges and cannot be built over unknown nodes.
  {
    const violations: ChartViolation[] = [];
    for (const e of chart.edges) {
      for (const [side, id] of [["from_movement", e.from_movement], ["to_movement", e.to_movement]] as const) {
        if (!byId.has(id)) {
          violations.push({ rule: "R4", edge: { from_movement: e.from_movement, to_movement: e.to_movement, output_type: e.output_type }, detail: `edge references unknown movement "${id}" (${side}).` });
        }
      }
    }
    for (const g of chart.approval_gates) {
      for (const [side, id] of [["after_movement", g.after_movement], ["before_movement", g.before_movement]] as const) {
        if (!byId.has(id)) {
          violations.push({ rule: "R4", gate_id: g.gate_id, detail: `approval gate "${g.gate_id}" references unknown movement "${id}" (${side}).` });
        }
      }
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R5 acyclicity, over edges ∪ gate ordering ────────────────────────────────────────────────
  const order: string[] = [];
  {
    const adj = new Map<string, Set<string>>(resolved.map((m) => [m.movement_id, new Set<string>()]));
    for (const e of chart.edges) adj.get(e.from_movement)!.add(e.to_movement);
    // A gate is an ORDERING as much as an approval: nothing before it may wait on anything after it.
    for (const g of chart.approval_gates) if (g.after_movement !== g.before_movement) adj.get(g.after_movement)!.add(g.before_movement);

    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<string, number>([...adj.keys()].map((k) => [k, WHITE]));
    const stack: string[] = [];
    let cycle: string[] | undefined;
    const visit = (id: string): void => {
      if (cycle) return;
      color.set(id, GREY);
      stack.push(id);
      for (const next of adj.get(id) ?? []) {
        if (cycle) break;
        const c = color.get(next);
        if (c === GREY) { cycle = [...stack.slice(stack.indexOf(next)), next]; break; }
        if (c === WHITE) visit(next);
      }
      stack.pop();
      color.set(id, BLACK);
      // Post-order push, reversed below: the topological order the performance walks.
      if (!cycle) order.push(id);
    };
    // Declaration order seeds the DFS, so a chart with no edges walks as written.
    for (const m of resolved) if (color.get(m.movement_id) === WHITE) visit(m.movement_id);
    if (cycle) {
      return V([{ rule: "R5", detail: `chart is cyclic: ${cycle.join(" → ")}. A performance has a first movement.` }]);
    }
    order.reverse();
  }

  // ── R6 dead-name / optional-flow classification ──────────────────────────────────────────────
  // The entry-chair-seed rule, promoted to the edge level: an edge asserts that a type SEALED by
  // the source movement seeds the sink's entry. An edge naming a type nothing seals is a dead name.
  const edges_classified: ClassifiedEdge[] = [];
  {
    const violations: ChartViolation[] = [];
    for (const e of chart.edges) {
      const src = byId.get(e.from_movement)!;
      const { required, optional } = sealedTypes(src.standard);
      const where = { from_movement: e.from_movement, to_movement: e.to_movement, output_type: e.output_type };
      if (required.has(e.output_type)) {
        // Promised: a hard edge, whatever `optional` says. `optional` narrows nothing here.
        edges_classified.push({ ...where, kind: "hard" });
        continue;
      }
      if (optional.has(e.output_type)) {
        if (e.optional !== true) {
          violations.push({ rule: "R6", edge: where, detail: `movement "${e.from_movement}" seals "${e.output_type}" only through a terminal chair's optional_outputs, so this flow may carry nothing: conditional flow must set optional:true on the edge. Declare it, or make the type a promised output of standard "${src.standard.slug}".` });
          continue;
        }
        edges_classified.push({ ...where, kind: "conditional" });
        continue;
      }
      violations.push({ rule: "R6", edge: where, detail: `dead name: "${e.output_type}" is never sealed by movement "${e.from_movement}" (standard "${src.standard.slug}" seals [${[...required, ...optional].join(", ") || "nothing"}]). An edge that names an unsealed type would carry nothing and could not say so.` });
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R7 entry-slot satisfaction (dead slot) ───────────────────────────────────────────────────
  // A required outside-need with no provider is refused where the chart is authored. A CONDITIONAL
  // edge does not count: it is classified, not guaranteed, and the sink requires the type.
  {
    const violations: ChartViolation[] = [];
    const payload = new Set(input.payload_types ?? []);
    for (const m of resolved) {
      const hard = new Set<string>();
      for (const e of edges_classified) if (e.to_movement === m.movement_id && e.kind === "hard") hard.add(e.output_type);
      const conditional = new Set<string>();
      for (const e of edges_classified) if (e.to_movement === m.movement_id && e.kind === "conditional") conditional.add(e.output_type);
      const fills = new Set(Object.keys(m.runtime_fills));
      for (const need of outsideNeeds(m.standard)) {
        if (hard.has(need) || fills.has(need) || payload.has(need)) continue;
        const onlyConditional = conditional.has(need) ? ` A conditional edge carries "${need}" but may carry nothing, so it cannot be its only provider.` : "";
        violations.push({ rule: "R7", movement_id: m.movement_id, detail: `dead slot: movement "${m.movement_id}" input "${need}" has no provider — no incoming hard edge carries it, runtime_fills does not fill it, and the chart payload does not declare it.${onlyConditional}` });
      }
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R8 gate key discipline ───────────────────────────────────────────────────────────────────
  // A gate is keyed by `gate_id` precisely so an ARRANGEMENT-level approval cannot be answered by
  // an approval meant for a within-movement human chair that shares a role name.
  {
    const violations: ChartViolation[] = [];
    const seen = new Set<string>();
    for (const g of chart.approval_gates) {
      if (seen.has(g.gate_id)) {
        violations.push({ rule: "R8", gate_id: g.gate_id, detail: `duplicate gate_id "${g.gate_id}" — approvals are keyed by it, so two gates sharing one would be answered by a single yes.` });
      }
      seen.add(g.gate_id);
      if (g.after_movement === g.before_movement) {
        violations.push({ rule: "R8", gate_id: g.gate_id, detail: `gate "${g.gate_id}" gates movement "${g.before_movement}" on itself. A gate orders two movements.` });
      }
      for (const id of [g.after_movement, g.before_movement]) {
        const m = byId.get(id);
        if (!m) continue; // R4 already reported it
        for (const ch of chairsOf(m.standard)) {
          if (ch.human === true && ch.role === g.gate_id) {
            violations.push({ rule: "R8", gate_id: g.gate_id, detail: `gate_id "${g.gate_id}" collides with a human chair role in movement "${id}" (standard "${m.standard.slug}"). Both park on approvals["${g.gate_id}"], so one person's yes would answer the other's question.` });
          }
        }
      }
    }
    if (violations.length > 0) return V(violations);
  }

  // ── R9 budget envelope, on the compose path ──────────────────────────────────────────────────
  // Restated here rather than left to Zod: `z.number().positive()` accepts Infinity, and an
  // unbounded envelope is not a bound.
  if (chart.budget_envelope) {
    const total = chart.budget_envelope.total_usd;
    if (!Number.isFinite(total) || total <= 0) {
      return V([{ rule: "R9", detail: `budget_envelope.total_usd must be a finite positive number of dollars; got ${String(total)}. An envelope that cannot be exceeded is not an envelope.` }]);
    }
  }

  // ── R10 the venue ceiling — a room NARROWS a player, never widens one ────────────────────────
  // The venue is one enforcement layer among several, and the only one that bounds what EXISTS in
  // the room rather than what a principal may reach for. So it composes with the others by
  // INTERSECTION, and the failure it can prove statically is the one worth refusing here: a seated
  // agent whose entire grant set lies outside the room. That chair's work is dead before the
  // downbeat — the spawn would advertise nothing it was chartered to hold — so the arrangement is
  // refused where it is authored, with the agent, the room and the emptiness named.
  //
  // What this does NOT do: decide whether a NON-empty intersection is sufficient. Which of an
  // agent's tools a given chair actually needs is not stated anywhere in the genome, so claiming to
  // check it would be a check in name only. Emptiness is the part that is provable.
  if (chart.venue !== undefined) {
    const venue = input.venues?.get(chart.venue);
    if (!venue) {
      return V([{
        rule: "R10",
        detail:
          `unknown venue "${chart.venue}" — it resolves to nothing this caller can see, so the ceiling it is ` +
          `supposed to impose cannot be computed. An unresolvable ceiling is not an absent ceiling: define the ` +
          `venue under venues/<slug>.json (venue_define), or drop the field.`,
      }]);
    }
    const violations: ChartViolation[] = [];
    for (const m of resolved) {
      // Everyone who plays this movement: the standard's own composed roster, plus any agent the
      // chart seats over it. One pass per agent, whichever way it got into the room.
      const seated = new Map<string, Agent>();
      for (const a of m.standard.agents) seated.set(a.slug, a);
      for (const s of m.seatings) {
        const a = input.agents?.get(s.agent_slug);
        if (a) seated.set(a.slug, a);
      }
      for (const a of seated.values()) {
        const grants = a.allowed_tools ?? [];
        // An agent that grants nothing needs nothing from the room. Deny-by-default cuts both ways.
        if (grants.length === 0) continue;
        if (venueEffectiveTools(a, venue).length > 0) continue;
        violations.push({
          rule: "R10",
          movement_id: m.movement_id,
          detail:
            `venue "${venue.slug}" starves agent "${a.slug}" in movement "${m.movement_id}": its grants ` +
            `[${grants.join(", ")}] intersect the room's equipment [${venue.equipment.tools.join(", ") || "nothing"}] in ` +
            `NOTHING, so every tool the agent is chartered to hold is absent here. A venue is a ceiling, not a grant — ` +
            `it cannot supply what the charter does not claim. Widen the room's equipment, seat an agent this room ` +
            `equips, or hold this movement somewhere else.`,
        });
      }
    }
    if (violations.length > 0) return V(violations);
  }

  const plan: ChartPlan = {
    chart,
    movements: resolved,
    order,
    edges_classified,
    // The venue is NOT folded in: a room is environment, not structure (see ChartSchema.venue).
    chart_hash: chartHash({ movements: resolved, chart }),
  };
  return { ok: true, violations: [], ...plan };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Perform
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** How a GATE's sealed approval is filed among the chart checkpoint's movement rows. A movement_id
 *  cannot collide with it: R1 admits only `[A-Za-z0-9._-]+`, and this prefix carries a colon. */
const GATE_ROW_PREFIX = "gate:";

/** The chart's own checkpoint: which movements completed, and what the performance has spent. */
export function chartCheckpointId(gig_id: string): string {
  return `${gig_id}.chart`;
}

/**
 * A movement's gig id.
 *
 * The degenerate chart's movement runs under the chart's own id, unchanged — same outputs file,
 * same checkpoint, same ledger row id a single-standard dispatch always had. A real arrangement
 * gives each movement its own id, so one movement's checkpoint, header and row cannot be another's.
 *
 * The spec left open whether the movements of one chart should instead SHARE a gig id, so that
 * `OutputStore.trace` — scoped to a single gig — would walk the whole performance. That question
 * is now ANSWERED THE OTHER WAY: the ids stay separate (a movement keeps its own checkpoint,
 * header and row) and the STORE learned the id scheme instead. `performanceRoot` reads a
 * performance off a movement's gig id, so `trace` walks the whole arrangement and LABELS each
 * node with the movement it lived in. The composition is the one owner of how the id is built;
 * the store is the one owner of how it is read back apart.
 */
export function movementGigId(plan: { chart: Chart }, gig_id: string, movement_id: string): string {
  return isDegenerateChart(plan.chart) ? gig_id : composeMovementGigId(gig_id, movement_id);
}

/** Where a movement's own checkpoint lives. Equal to the gig id, as `runGig` expects. */
export function movementCheckpointId(plan: { chart: Chart }, gig_id: string, movement_id: string): string {
  return movementGigId(plan, gig_id, movement_id);
}

export interface ChartMovementRun {
  movement_id: string;
  standard_slug: string;
  gig_id: string;
  /** `skipped` = restored from the chart checkpoint; it played in an earlier attempt. */
  status: "complete" | "skipped" | "awaiting_approval" | "budget_exhausted";
  result?: GigResult;
  /** What this movement handed on: its sealed outputs, or the ones a resume restored. */
  outputs: readonly OutputRecord[];
  /** Real settled model spend for this movement. 0 when no invoker reported cost. */
  spent_usd: number;
}

export interface ChartResult {
  chart_slug: string;
  chart_hash: string;
  gig_id: string;
  status: "complete" | "awaiting_approval" | "budget_exhausted";
  movements: readonly ChartMovementRun[];
  /**
   * Present iff parked: WHOSE seat the performance is waiting on, and where.
   *
   * `gate_id` is present for an ARRANGEMENT-level gate (approved through `approvals[gate_id]`) and
   * absent when a movement parked at its own within-movement human chair (`approvals[role]`). The
   * two are different offices and the reply says which, rather than calling a chair role a gate id.
   */
  awaiting?: { movement_id: string; chair: string; gate_id?: string; phase?: string };
  /**
   * Gate approvals that STAND for this performance — a yes is a record, not a message.
   *
   * Includes an approval sealed in an earlier attempt and restored here, because the fact an
   * operator needs is "this gate is answered", and re-sealing it on every resume would put two
   * yeses in the chain for one decision.
   */
  gates_approved?: ReadonlyArray<{ gate_id: string; chair: string; approved_by: string; output_id: string }>;
  /** Cumulative real spend across every movement of this performance. */
  spent_usd: number;
  /** Present when the chart declares an envelope. Names the boundary a refusal happened at. */
  budget?: { total_usd: number; spent_usd: number; exhausted_at_movement?: string };
  /** Present when this run resumed an earlier attempt at the same performance. */
  resumed?: { movements: string[]; outputs: number };
}

/**
 * The chart's resume identity. Same discipline as a run's (src/reuse.ts RunIdentity): a resume into
 * a MOVED arrangement would put movements from chart B onto sealed outputs from chart A with
 * nothing recording it, so the gate is stated, not assumed.
 */
function chartIdentity(plan: ChartPlan, chartInput: Record<string, unknown>, deps: RunDeps): RunIdentity {
  return {
    standard_slug: plan.chart.slug,
    genome_hash: plan.chart_hash,
    producers_sha: producersSha({ agents: plan.movements.flatMap((m) => [...m.standard.agents]) }),
    gig_input_sha: sha256Hex(canonJson(chartInput)),
    model_version: deps.model_version ?? "unknown",
    depth: deps.depth ?? "",
    canonical_form_version: CANONICAL_FORM_VERSION,
  };
}

/**
 * Perform the chart: walk the movements in topological order, one `runGig` each.
 *
 * The boundaries are where everything interesting happens, because a boundary is the last place a
 * stop is free:
 *   - the incoming edges' carriers are gathered and handed to the sink as SEALED RECORDS (so its
 *     provenance reaches back across the boundary, rather than a payload copy that says it came
 *     from nowhere),
 *   - an approval gate parks the performance — checkpointed, drained as `awaiting_approval`,
 *     nothing hollow sealed — exactly as an in-standard human chair does,
 *   - the budget envelope is compared against real settled spend BEFORE the next movement starts,
 *   - and the movement that just finished is recorded, so a resume never re-derives it.
 */
export async function runChart(
  plan: ChartPlan,
  chartInput: Record<string, unknown>,
  deps: RunDeps,
): Promise<ChartResult> {
  const degenerate = isDegenerateChart(plan.chart);
  if (deps.resume_from !== undefined && deps.gig_id !== undefined && deps.gig_id !== deps.resume_from) {
    throw new ResumeRefused(deps.resume_from, `the caller supplied a different gig_id ("${deps.gig_id}") — a resumed performance continues the one it resumes, it does not fork one`);
  }
  const gig_id = deps.resume_from ?? deps.gig_id ?? randomUUID();
  const started_at = new Date().toISOString();
  const chart_slug = plan.chart.slug;
  const identity = chartIdentity(plan, chartInput, deps);
  const cpId = chartCheckpointId(gig_id);

  /** Movements a previous attempt completed: movement_id → its handed-on records. */
  const restored = new Map<string, { records: OutputRecord[]; row: CheckpointRole }>();
  /** Gates an earlier attempt already sealed: gate_id → the approval that stands. */
  const restoredGates = new Map<string, { gate_id: string; chair: string; approved_by: string; output_id: string }>();
  let priorSpentUsd = 0;
  let chartStartedAt = started_at;

  // ── resume ────────────────────────────────────────────────────────────────────────────────────
  if (deps.resume_from !== undefined) {
    if (!deps.checkpoints) throw new ResumeRefused(gig_id, "no checkpoint store is wired, so there is nothing to resume from");
    let cp: GigCheckpoint | undefined;
    try {
      cp = deps.checkpoints.read(cpId);
    } catch (e) {
      throw new ResumeRefused(gig_id, `its chart checkpoint could not be read — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cp) {
      if (cp.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
        throw new ResumeRefused(gig_id, `its chart checkpoint is schema v${cp.schema_version} and this engine reads v${CHECKPOINT_SCHEMA_VERSION}`);
      }
      const drift = Object.keys(identity)
        .filter((k) => (cp!.identity as unknown as Record<string, unknown>)[k] !== (identity as unknown as Record<string, unknown>)[k])
        .map((k) => `${k}: checkpoint="${String((cp!.identity as unknown as Record<string, unknown>)[k])}" current="${String((identity as unknown as Record<string, unknown>)[k])}"`);
      if (drift.length > 0) throw new ResumeRefused(gig_id, "it was checkpointed under a different arrangement", drift);
      const known = new Set(plan.movements.map((m) => m.movement_id));
      for (const row of cp.roles) {
        const gateId = row.role.startsWith(GATE_ROW_PREFIX) ? row.role.slice(GATE_ROW_PREFIX.length) : undefined;
        if (gateId === undefined && !known.has(row.role)) {
          throw new ResumeRefused(gig_id, `its chart checkpoint names movement "${row.role}", which this chart does not declare`);
        }
        const gate = gateId === undefined ? undefined : plan.chart.approval_gates.find((g) => g.gate_id === gateId);
        if (gateId !== undefined && !gate) {
          throw new ResumeRefused(gig_id, `its chart checkpoint names gate "${gateId}", which this chart does not declare`);
        }
        const records: OutputRecord[] = [];
        for (let i = 0; i < row.output_ids.length; i++) {
          const id = row.output_ids[i]!;
          const rec = deps.outputs.get(id);
          if (!rec) throw new ResumeRefused(gig_id, `its chart checkpoint names output "${id}" for movement "${row.role}", which the output store no longer holds`);
          if (rec.content_sha !== row.content_shas[i]) throw new ResumeRefused(gig_id, `output "${id}" (movement "${row.role}") has a different content_sha than the chart checkpoint recorded — the store moved under it`);
          const fp = deps.outputs.typeFingerprint(rec.domain_type);
          if (fp === "") throw new ResumeRefused(gig_id, `the registry can no longer describe type "${rec.domain_type}" (movement "${row.role}"), so its sealed output cannot be checked`);
          if (fp !== row.type_fingerprints[i]) throw new ResumeRefused(gig_id, `type "${rec.domain_type}" (movement "${row.role}") has changed shape since that output was sealed`);
          records.push(rec);
        }
        if (gate) {
          // The gate was answered in an earlier attempt and its yes is sealed. It is NOT asked
          // again: two records for one decision would put a second yes in the chain and make the
          // approval look like a repeated act.
          const rec = records[0]!;
          restoredGates.set(gate.gate_id, { gate_id: gate.gate_id, chair: gate.chair, approved_by: rec.agent_slug, output_id: rec.id });
          continue;
        }
        restored.set(row.role, { records, row });
      }
      priorSpentUsd = cp.prior_budget_state?.spent_usd ?? 0;
      chartStartedAt = cp.started_at;
    } else if (!degenerate) {
      // FAILURE POSTURE, inherited from `runGig`: a resume is a CLAIM about a specific prior
      // performance. If nothing was ever recorded as complete the claim is false, and quietly
      // running cold would charge the caller for a full performance they believe they are
      // continuing. A degenerate chart is exempt — it writes no chart checkpoint at all, and its
      // resume is the single-standard resume it always was, read from the movement's own.
      const anyMovementCheckpoint = plan.movements.some((m) => {
        try { return deps.checkpoints!.read(movementCheckpointId(plan, gig_id, m.movement_id)) !== undefined; } catch { return false; }
      });
      if (!anyMovementCheckpoint) {
        throw new ResumeRefused(gig_id, "no chart checkpoint exists for it (nothing was ever recorded as complete)");
      }
    }
  }

  const runs = new Map<string, ChartMovementRun>();
  const gatesApproved: Array<{ gate_id: string; chair: string; approved_by: string; output_id: string }> = [];
  let spentUsd = priorSpentUsd;
  const envelope = plan.chart.budget_envelope?.total_usd;

  /** Write the chart's checkpoint: which movements are done, and what the performance has spent. */
  const saveChartCheckpoint = (): void => {
    if (!deps.checkpoints || degenerate) return;
    const roles: CheckpointRole[] = [];
    for (const id of plan.order) {
      const run = runs.get(id);
      if (!run || (run.status !== "complete" && run.status !== "skipped")) continue;
      const prior = restored.get(id);
      roles.push(
        prior && run.status === "skipped"
          ? prior.row
          : {
              role: id, phase: run.standard_slug, movement_id: id,
              output_ids: run.outputs.map((r) => r.id),
              content_shas: run.outputs.map((r) => r.content_sha),
              domain_types: run.outputs.map((r) => r.domain_type),
              type_fingerprints: run.outputs.map((r) => deps.outputs.typeFingerprint(r.domain_type)),
              sealed_at: new Date().toISOString(),
            },
      );
    }
    // A gate's sealed yes rides on the checkpoint too, so a resumed performance restores the
    // approval instead of asking for it again.
    for (const g of gatesApproved) {
      const rec = deps.outputs.get(g.output_id);
      if (!rec) continue;
      const gate = plan.chart.approval_gates.find((x) => x.gate_id === g.gate_id);
      roles.push({
        role: `${GATE_ROW_PREFIX}${g.gate_id}`, phase: `gate`,
        ...(gate ? { movement_id: gate.before_movement } : {}),
        output_ids: [rec.id], content_shas: [rec.content_sha], domain_types: [rec.domain_type],
        type_fingerprints: [deps.outputs.typeFingerprint(rec.domain_type)],
        sealed_at: rec.created_at,
      });
    }
    if (roles.length === 0) return;
    // What the performance has spent SO FAR, in real dollars — the number the envelope is
    // denominated in, and the one a resumed performance reads before spawning anything.
    const prior_budget_state: PriorBudgetState = { spent_usd: spentUsd };
    try {
      deps.checkpoints.write({
        schema_version: CHECKPOINT_SCHEMA_VERSION, gig_id: cpId, identity,
        started_at: chartStartedAt, updated_at: new Date().toISOString(),
        roles,
        prior_budget_state,
      });
    } catch { /* a checkpoint that will not persist must not kill a performance that is otherwise fine */ }
  };

  /** The records an edge into `movement_id` carries: the source movement's sealed outputs, by type. */
  const carriersFor = (movement_id: string): OutputRecord[] => {
    const out: OutputRecord[] = [];
    for (const e of plan.edges_classified) {
      if (e.to_movement !== movement_id) continue;
      const src = runs.get(e.from_movement);
      if (!src) continue;
      // The SAME type-match the runtime uses at the seal boundary (subtype-aware for a core-type
      // declaration, exact for a domain type) — asked through its one owner, not re-derived here.
      for (const rec of src.outputs) {
        if (!outputSatisfiesType(rec, e.output_type)) continue;
        if (!out.includes(rec)) out.push(rec);
      }
    }
    return out;
  };

  const park = async (gate: ChartApprovalGate, movement: ResolvedMovement): Promise<ChartResult> => {
    saveChartCheckpoint();
    // AWAITED, like the in-standard park: parking is the performance's last act before the caller
    // exits, and an in-flight fetch dies with the process — which would leave the sink's row saying
    // "running" about a performance that is waiting on a person.
    await drainGigHeader({
      gig_id, standard_slug: chart_slug, status: "awaiting_approval",
      genome_hash: plan.chart_hash, started_at: chartStartedAt, finished_at: new Date().toISOString(),
      outputs_count: [...runs.values()].reduce((n, r) => n + r.outputs.length, 0),
      error: `awaiting approval at chart gate "${gate.gate_id}" (chair "${gate.chair}") before movement "${movement.movement_id}"`,
    }).catch((e) => {
      if (process.env["COLTRANE_DRAIN_DEBUG"]) console.error(`[drain] awaiting chart header ${gig_id}: ${String(e)}`);
    });
    runs.set(movement.movement_id, {
      movement_id: movement.movement_id, standard_slug: movement.standard.slug,
      gig_id: movementGigId(plan, gig_id, movement.movement_id),
      status: "awaiting_approval", outputs: [], spent_usd: 0,
    });
    return result("awaiting_approval", { gate_id: gate.gate_id, movement_id: movement.movement_id, chair: gate.chair });
  };

  const result = (
    status: ChartResult["status"],
    awaiting?: ChartResult["awaiting"],
    exhausted_at?: string,
  ): ChartResult => ({
    chart_slug, chart_hash: plan.chart_hash, gig_id, status,
    movements: plan.order.map(
      (id) =>
        runs.get(id) ?? {
          movement_id: id, standard_slug: byIdOf(id).standard.slug,
          gig_id: movementGigId(plan, gig_id, id),
          status: status === "budget_exhausted" ? "budget_exhausted" : "awaiting_approval",
          outputs: [], spent_usd: 0,
        },
    ),
    ...(awaiting ? { awaiting } : {}),
    ...(gatesApproved.length > 0 ? { gates_approved: gatesApproved } : {}),
    spent_usd: spentUsd,
    ...(envelope !== undefined ? { budget: { total_usd: envelope, spent_usd: spentUsd, ...(exhausted_at ? { exhausted_at_movement: exhausted_at } : {}) } } : {}),
    ...(restored.size > 0 ? { resumed: { movements: [...restored.keys()], outputs: [...restored.values()].reduce((n, r) => n + r.records.length, 0) } } : {}),
  });

  const byIdOf = (movement_id: string): ResolvedMovement => plan.movements.find((m) => m.movement_id === movement_id)!;

  // ── the walk ──────────────────────────────────────────────────────────────────────────────────
  for (const movement_id of plan.order) {
    const movement = byIdOf(movement_id);

    // A movement an earlier attempt completed never runs again: its sealed outputs are the edge's
    // carriers, re-read from the store and re-checked above.
    const already = restored.get(movement_id);
    if (already) {
      runs.set(movement_id, {
        movement_id, standard_slug: movement.standard.slug,
        gig_id: movementGigId(plan, gig_id, movement_id),
        status: "skipped", outputs: already.records, spent_usd: 0,
      });
      continue;
    }

    // ── the gates in front of this movement ────────────────────────────────────────────────────
    for (const gate of plan.chart.approval_gates) {
      if (gate.before_movement !== movement_id) continue;
      const standing = restoredGates.get(gate.gate_id);
      if (standing) { gatesApproved.push(standing); continue; } // answered already, and sealed
      const approval = deps.approvals?.[gate.gate_id];
      if (!approval) return park(gate, movement);
      // A yes SEALS, through the same output gate as every record, under the approving principal's
      // name, carrying the content_shas of exactly what was approved.
      const approvedInputs = runs.get(gate.after_movement)?.outputs ?? [];
      const core = deps.outputs.coreTypeOf("Judgment") ?? "Judgment";
      const rec = deps.outputs.write({
        core_type: core, domain_type: "Judgment", domain: movement.standard.domain,
        gig_id, agent_slug: deps.approved_by ?? "human", from_role: gate.chair,
        phase: `gate:${gate.gate_id}`, primitive: CORE_TO_PRIMITIVE[core] ?? "JUDGE",
        data: approval,
        input_refs: approvedInputs.map((i) => i.id),
        input_shas: approvedInputs.map((i) => i.content_sha),
      });
      for (const i of approvedInputs) deps.outputs.addRef(rec.id, i.id, "derived_from", rec.primitive);
      gatesApproved.push({ gate_id: gate.gate_id, chair: gate.chair, approved_by: rec.agent_slug, output_id: rec.id });
    }

    // ── the envelope ──────────────────────────────────────────────────────────────────────────
    // Deterministic, at the boundary, before any inference: a spend that already happened must not
    // cost another invocation to discover.
    if (envelope !== undefined && spentUsd >= envelope) {
      saveChartCheckpoint();
      runs.set(movement_id, {
        movement_id, standard_slug: movement.standard.slug,
        gig_id: movementGigId(plan, gig_id, movement_id),
        status: "budget_exhausted", outputs: [], spent_usd: 0,
      });
      return result("budget_exhausted", undefined, movement_id);
    }

    // ── the movement ──────────────────────────────────────────────────────────────────────────
    const movementGig = movementGigId(plan, gig_id, movement_id);
    const seeds = [
      ...carriersFor(movement_id),
      // A gate's sealed verdict is offered to the movement it gates, on the same terms as an edge's
      // carrier: if the sink consumes a Judgment, the approval is part of what it reasoned from.
      ...gatesApproved
        .filter((g) => plan.chart.approval_gates.some((x) => x.gate_id === g.gate_id && x.before_movement === movement_id))
        .map((g) => deps.outputs.get(g.output_id))
        .filter((r): r is OutputRecord => r !== undefined),
    ];
    // A movement whose own checkpoint exists resumes from it (its completed chairs are already
    // sealed); one with no checkpoint runs cold. The DEGENERATE chart passes the caller's resume
    // claim straight through instead, so a resume of a single-standard gig that never recorded
    // anything is refused by `runGig` exactly as it always was — a chart must not quietly turn a
    // false claim into a cold run.
    //
    // `deps.budget` (append units) rides along unchanged and is therefore PER MOVEMENT: it is a rate
    // limiter on one run's consumed context. The cross-movement bound is the chart's envelope, in
    // real dollars, checked at the boundary above. Two different limits, kept apart deliberately.
    const priorMovementCp = deps.checkpoints?.read(movementGig);
    const resumeMovement = deps.resume_from !== undefined && (degenerate || priorMovementCp !== undefined);
    const movementDeps: RunDeps = {
      ...deps,
      gig_id: movementGig,
      resume_from: resumeMovement ? movementGig : undefined,
      seed_outputs: seeds.length > 0 ? seeds : undefined,
      chart: {
        chart_slug, movement_id, chart_hash: plan.chart_hash, degenerate,
        prior_budget_state: { spent_usd: spentUsd },
      },
    };
    const gigInput = { ...chartInput, ...movement.runtime_fills };

    let res: GigResult;
    try {
      res = await runGig(movement.standard, gigInput, movementDeps);
    } catch (e) {
      // The performance keeps what it earned: the movements that completed are recorded, so a
      // resume starts at the one that died rather than at the top.
      saveChartCheckpoint();
      throw e;
    }

    const movementSpend = res.usage?.total_cost_usd ?? 0;
    spentUsd += movementSpend;
    runs.set(movement_id, {
      movement_id, standard_slug: movement.standard.slug, gig_id: movementGig,
      status: res.status === "awaiting_approval" ? "awaiting_approval" : "complete",
      result: res, outputs: res.outputs, spent_usd: movementSpend,
    });

    // A movement that parked at its OWN human chair parks the performance: the chart has no more
    // right to run past a person than the standard does.
    if (res.status === "awaiting_approval") {
      saveChartCheckpoint();
      // A within-movement human chair, not a gate: no gate_id, and the chair is named as the
      // role it is. The approving resume answers it through `approvals[role]`, exactly as a
      // single-standard dispatch does.
      return result(
        "awaiting_approval",
        res.awaiting ? { movement_id, chair: res.awaiting.role, phase: res.awaiting.phase } : undefined,
      );
    }
    saveChartCheckpoint();
  }

  // The performance finished, so there is nothing left to resume.
  if (deps.checkpoints && !degenerate) {
    try { deps.checkpoints.remove(cpId); } catch { /* reclaiming disk must not fail a run that succeeded */ }
  }
  return result("complete");
}
