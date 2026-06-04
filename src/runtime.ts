// §13/runtime — the gig executor. Walks a standard's phases, invokes each agent
// (via an INJECTED invoker so the orchestration is testable without spawning Claude),
// writes each typed output to the store (validated), links provenance (derived_from),
// and records one ledger entry with a deterministic genome_hash + a run_fingerprint
// that carries model_version + (empty, v0) eval_scores — honestly un-tempered.
import { randomUUID } from "node:crypto";
import type { Standard, Agent } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import { sha256Hex, canonJson, runFingerprint, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import type { OutputStore, OutputRecord } from "./outputs.js";
import type { Ledger } from "./ledger.js";

// What an agent invocation sees. The invoker returns the output `data` (validated
// downstream against the agent's declared output domain type).
export interface AgentInvocationContext {
  agent: Agent;
  phase: string;
  inputs: readonly OutputRecord[]; // upstream outputs matching this agent's input_types
  gig_input: Record<string, unknown>;
}

// The one non-deterministic seam. Inject a deterministic fn in tests; the real
// Claude subprocess call in the stdio entry. The runtime around it is deterministic.
export type AgentInvoker = (
  ctx: AgentInvocationContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface RunDeps {
  outputs: OutputStore;
  ledger: Ledger;
  invoke: AgentInvoker;
  model_version?: string | undefined;
  /**
   * Optional cost-budget input. When omitted (default), no budget enforcement
   * runs — preserving v0 back-compat. When present, the runtime tracks
   * per-gig BudgetState matching budget-state.json schema: balance =
   * opening - spent + credit. Before every agent invocation, computes
   * cost-of-append (base + k*size(input)) and throws BudgetExhausted if
   * balance < cost. After success, deducts cost from balance. The final
   * BudgetState is returned in GigResult.budget_state.
   */
  budget?: BudgetInput | undefined;
}

/**
 * Per-gig cost-budget input. Honors budget-state.json schema (PR #56). Only
 * `opening` is required for v0 enforcement; the rest are recomputed.
 *
 * COST FORMULA (v0, tunable):
 *   cost = base_cost + k * size_bytes(input)
 *   defaults: base_cost = 1, k = 0.1
 *
 * Where size_bytes(input) = JSON.stringify(canonical context).length.
 */
export interface BudgetInput {
  opening: number;
  /** base cost per agent invocation. Default 1. */
  base_cost?: number;
  /** per-byte multiplier on input size. Default 0.1. */
  k?: number;
}

/**
 * Per-gig budget snapshot. Mirrors fields of domain_types/budget-state.json
 * (PR #56) that are runtime-tractable in v0. balance = opening - spent + credit.
 *
 * The `agent_state` mirrors the budget-state.json enum:
 *   active           — currently spending, balance > cost-of-next-append
 *   yielding         — below cost-of-next-append, paused (used when partial)
 *   depleted         — balance <= 0 OR < cost-of-next-append, hard stop
 *   awaiting_grade   — work shipped, external grader contacted (v0 unused)
 *   settled          — cycle closed, closing populated (v0 set on success)
 */
export interface BudgetState {
  opening: number;
  spent: number;
  credit: number;
  balance: number;
  agent_state: "active" | "yielding" | "depleted" | "awaiting_grade" | "settled";
  /** Slug of the agent whose invocation tripped depletion. null when solvent. */
  depleted_agent: string | null;
  /** Wall-clock when balance first crossed below cost-of-next-append. null while solvent. */
  depleted_at: string | null;
  base_cost: number;
  k: number;
}

export interface GigResult {
  gig_id: string;
  standard_slug: string;
  genome_hash: string;
  run_fingerprint: string;
  outputs: readonly OutputRecord[];
  status: "complete";
  /** Final budget snapshot. Present only when a budget was supplied. */
  budget_state?: BudgetState;
}

export class RuntimeError extends Error {}

/**
 * Raised when a gig's budget cannot cover the next agent's cost-of-append.
 * Carries the agent_slug, the available balance, and the required cost so
 * the caller can render the exact reason. The in-memory BudgetState is
 * also attached for downstream telemetry.
 */
export class BudgetExhausted extends Error {
  public readonly agent_slug: string;
  public readonly balance: number;
  public readonly cost: number;
  public readonly state: BudgetState;
  constructor(agent_slug: string, balance: number, cost: number, state: BudgetState) {
    super(
      `BudgetExhausted: agent "${agent_slug}" needs cost=${cost} but balance=${balance} (opening=${state.opening}, spent=${state.spent}, credit=${state.credit})`,
    );
    this.name = "BudgetExhausted";
    this.agent_slug = agent_slug;
    this.balance = balance;
    this.cost = cost;
    this.state = state;
  }
}

/**
 * Cost-of-append for an agent invocation. Deterministic function of the
 * input context size — same input → same cost. Keeps cost calculation
 * inside the runtime (not the invoker) so budget enforcement cannot be
 * spoofed by a misbehaving invoker.
 */
export function computeAppendCost(
  ctx: { agent: Agent; phase: string; inputs: readonly OutputRecord[]; gig_input: Record<string, unknown> },
  base_cost: number,
  k: number,
): number {
  // Canonical serialization of what the invoker actually sees. JSON.stringify
  // is sufficient for v0 — deterministic order isn't required since size is
  // the only thing we extract, and Record key order in V8 is insertion-stable.
  const size_bytes = JSON.stringify({
    agent_slug: ctx.agent.slug,
    phase: ctx.phase,
    input_ids: ctx.inputs.map((i) => i.id),
    gig_input: ctx.gig_input,
  }).length;
  return base_cost + k * size_bytes;
}

// Deterministic hash over the definitions a gig touches: the standard + its agents,
// in a canonical (sorted, JCS) form. This is the reproducibility key — same defs,
// same genome_hash, regardless of model or run.
function genomeHash(standard: Standard): string {
  const agents = [...standard.agents]
    .map((a) => ({
      slug: a.slug,
      primitives: a.primitives,
      input_types: a.input_types,
      output_types: a.output_types,
      domain: a.domain,
    }))
    .sort((x, y) => (x.slug < y.slug ? -1 : 1));
  return sha256Hex(
    canonJson({ standard: { slug: standard.slug, domain: standard.domain, phases: standard.phases }, agents }),
  );
}

/**
 * Execute one gig: walk phases in order, each phase's agent consumes the prior
 * outputs that match its input_types, produces a typed output, which is validated
 * + stored + provenance-linked. One immutable ledger entry records the run.
 */
export async function runGig(
  standard: Standard,
  gigInput: Record<string, unknown>,
  deps: RunDeps,
): Promise<GigResult> {
  const gig_id = randomUUID();
  const started_at = new Date().toISOString();
  const produced: OutputRecord[] = [];

  // Budget state. When deps.budget is undefined, enforcement is OFF (back-compat).
  // When present, we track an in-memory BudgetState mirroring budget-state.json.
  const budget: BudgetState | null = deps.budget
    ? {
        opening: deps.budget.opening,
        spent: 0,
        credit: 0,
        balance: deps.budget.opening,
        agent_state: "active",
        depleted_agent: null,
        depleted_at: null,
        base_cost: deps.budget.base_cost ?? 1,
        k: deps.budget.k ?? 0.1,
      }
    : null;

  for (const phase of standard.phases) {
    const agent = standard.agents.find((a) => a.slug === phase.agent);
    if (!agent) throw new RuntimeError(`phase "${phase.name}" references unknown agent "${phase.agent}"`);
    const primitive = agent.primitives[0];
    if (!primitive) throw new RuntimeError(`agent "${agent.slug}" declares no primitive`);
    const domain_type = agent.output_types[0];
    if (!domain_type) throw new RuntimeError(`agent "${agent.slug}" declares no output_type`);

    // gather upstream: prior outputs whose domain_type this agent consumes.
    const inputs = produced.filter((o) => agent.input_types.includes(o.domain_type));

    // BUDGET CHECK — pre-invocation. If balance < cost-of-next-append, the
    // agent transitions to "depleted" and the runtime raises BudgetExhausted.
    // No agent invocation, no output write, no ledger entry — the gig halts.
    if (budget) {
      const cost = computeAppendCost({ agent, phase: phase.name, inputs, gig_input: gigInput }, budget.base_cost, budget.k);
      if (budget.balance < cost) {
        budget.agent_state = "depleted";
        budget.depleted_agent = agent.slug;
        budget.depleted_at = new Date().toISOString();
        throw new BudgetExhausted(agent.slug, budget.balance, cost, budget);
      }
      // Solvent — deduct the cost immediately so concurrent reasoning sees
      // the post-spend balance. agent_state stays "active".
      budget.spent += cost;
      budget.balance = budget.opening - budget.spent + budget.credit;
    }

    const data = await deps.invoke({ agent, phase: phase.name, inputs, gig_input: gigInput });

    // write the typed output (outputs.write validates data vs the domain schema → throws on bad-schema).
    const rec = deps.outputs.write({
      core_type: PRIMITIVE_OUTPUT_TYPE[primitive],
      domain_type,
      domain: agent.domain ?? standard.domain,
      gig_id,
      agent_slug: agent.slug,
      phase: phase.name,
      primitive,
      data,
      input_refs: inputs.map((i) => i.id),
    });

    // provenance: this output is derived_from each upstream input it consumed.
    for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", primitive);
    produced.push(rec);
  }

  const genome_hash = genomeHash(standard);
  const output_hashes = produced.map((p) => p.id);
  const run_fingerprint = runFingerprint({
    genome_hash,
    model_version: deps.model_version ?? "unknown",
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores: {}, // v0 is un-tempered — no behavioral evals yet (the comma is unmeasured)
    output_hashes,
  });

  deps.ledger.append({
    gig_id,
    standard_slug: standard.slug,
    genome_hash,
    run_fingerprint,
    output_hashes,
    started_at,
    finished_at: new Date().toISOString(),
  });

  // Cycle complete — when a budget was supplied, mark it `settled` and
  // surface the final state in the manifest. `settled` mirrors the
  // budget-state.json cycle terminal-state semantics for a closed cycle.
  if (budget) {
    budget.agent_state = "settled";
  }

  const result: GigResult = { gig_id, standard_slug: standard.slug, genome_hash, run_fingerprint, outputs: produced, status: "complete" };
  if (budget) result.budget_state = budget;
  return result;
}
