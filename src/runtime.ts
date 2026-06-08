// §13/runtime — the gig executor. Walks a standard's phases, invokes each agent
// (via an INJECTED invoker so the orchestration is testable without spawning Claude),
// writes each typed output to the store (validated), links provenance (derived_from),
// and records one ledger entry with a deterministic genome_hash + a run_fingerprint
// that carries model_version + (empty, v0) eval_scores — honestly un-tempered.
import { randomUUID } from "node:crypto";
import type { Standard, Agent, Chair } from "./composition.js";
import { normalizePhase } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import { sha256Hex, canonJson, runFingerprint, outputContentHash, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import type { OutputStore, OutputRecord } from "./outputs.js";
import type { Ledger } from "./ledger.js";
import type { SkillRecord, EvalRecord } from "./loader.js";

// What an agent invocation sees. The invoker returns the output `data` (validated
// downstream against the agent's declared output domain type). `skills` carries
// the SkillRecords the runtime resolved from this agent's skill_slugs against the
// genome's skills map — the Claude invoker uses them to emit the prompt's Skills
// layer (layer 3 of 5). Optional so hand-built ctx literals + callers that don't
// supply a skills map stay valid; buildPrompt treats absent/empty as "no layer".
export interface AgentInvocationContext {
  agent: Agent;
  phase: string;
  inputs: readonly OutputRecord[]; // upstream outputs matching this agent's input_types
  gig_input: Record<string, unknown>;
  skills?: readonly SkillRecord[];
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
  // §13/skills — when supplied, runGig resolves each agent's `skill_slugs`
  // against this map and passes the resulting SkillRecords through the
  // AgentInvocationContext so the Claude invoker can emit the Skills layer.
  // Absent = each invocation sees `skills: []` (back-compat — unit suites that
  // don't supply skills still run green; the agent simply gets no skill layer).
  skills?: ReadonlyMap<string, SkillRecord> | undefined;
  // 5th-class eval definitions, slug-keyed. When supplied, scoreEval resolves a
  // declared eval_slug against this map and judges the produced outputs against
  // its contract. Absent = an unresolvable eval scores 0.0 (can't attest it held).
  evals?: ReadonlyMap<string, EvalRecord> | undefined;
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
  // 5th-class eval scores keyed by eval_slug. Empty when the standard declares
  // no eval_slugs. Populated by scanning the produced outputs against each
  // declared eval at gig-completion time.
  eval_scores: Record<string, number>;
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
// Resolve a list of skill slugs against the genome's skills map. Missing slugs
// are silently dropped — the diagnostic surface is the resulting empty Skills
// layer in the prompt (the model receives no skill content). Returns [] when
// either the slugs list or the map is absent.
function resolveSkills(
  slugs: readonly string[] | undefined,
  map: ReadonlyMap<string, SkillRecord> | undefined,
): readonly SkillRecord[] {
  if (!slugs || slugs.length === 0 || !map) return [];
  const out: SkillRecord[] = [];
  for (const slug of slugs) {
    const rec = map.get(slug);
    if (rec) out.push(rec);
  }
  return out;
}

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

  // Resolve agent-by-slug once (used for legacy-phase normalization).
  const agentBySlug = new Map(standard.agents.map((a) => [a.slug, a]));

  // Cross-phase role → output map. A chair in phase N can depends_on a chair
  // in phase 0..N-1; this map carries each completed chair's output by role so
  // downstream chairs can resolve their depends_on regardless of phase.
  const producedByRole = new Map<string, OutputRecord>();

  for (const phaseInput of standard.phases) {
    const phase = normalizePhase(phaseInput, agentBySlug);

    // Per-phase DAG executor. Chairs whose `depends_on` is fully covered by
    // already-produced roles form the next dispatch-batch and run in parallel
    // via Promise.allSettled. Failures from any chair in the batch are joined
    // into a single RuntimeError naming every failing chair role. Cross-phase
    // depends_on works because `producedByRole` carries across phases.
    const remaining = new Map<string, Chair>();
    for (const ch of phase.chairs) remaining.set(ch.role, ch);

    while (remaining.size > 0) {
      // Topological level: every chair whose depends_on ⊂ already-produced roles.
      const ready: Chair[] = [];
      for (const ch of remaining.values()) {
        if (ch.depends_on.every((dep) => producedByRole.has(dep))) ready.push(ch);
      }
      if (ready.length === 0) {
        // No chair can advance — at least one depends_on is unresolved at
        // runtime even though composition passed. Shouldn't happen since
        // composeStandard rejects forward/unknown/cycle, but guard so a
        // hand-rolled Standard literal can't wedge the runtime silently.
        const stuck = [...remaining.values()].map((c) => c.role).join(", ");
        throw new RuntimeError(`phase "${phase.name}" cannot advance — chairs [${stuck}] have unresolved depends_on`);
      }

      // Per-chair work happens in two stages so non-invocation failures
      // (BudgetExhausted, contract violations, programming-level errors like
      // TypeError from a circular gig_input) propagate UNWRAPPED through the
      // synchronous pre-stage; only the actual invoker rejection is caught
      // and aggregated into a phase-level "chair(s) failed" RuntimeError that
      // names every failing chair.
      const prepared = ready.map((chair) => prepareChair(chair, phase.name));

      const settled = await Promise.allSettled(
        prepared.map((p) => invokeAndWriteChair(p)),
      );

      const failures: string[] = [];
      const failureErrors: string[] = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]!;
        const ch = ready[i]!;
        if (r.status === "rejected") {
          failures.push(ch.role);
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          failureErrors.push(`${ch.role}: ${reason}`);
        } else {
          producedByRole.set(ch.role, r.value);
          produced.push(r.value);
        }
      }
      if (failures.length > 0) {
        throw new RuntimeError(
          `phase "${phase.name}" aborted — chair(s) failed: ${failures.join(", ")} (${failureErrors.join(" | ")})`,
        );
      }

      // Drop completed chairs from remaining so the next iteration picks up
      // chairs unblocked by this batch.
      for (const ch of ready) remaining.delete(ch.role);
    }
  }

  // Stage 1 — synchronous pre-invocation prep. Resolves the agent, checks the
  // input_contract against actual upstream output types, enforces the per-chair
  // budget, and gathers everything the invocation needs. Throws synchronously
  // for BudgetExhausted / programming-level errors so they propagate UNWRAPPED.
  interface PreparedChair {
    chair: Chair;
    phaseName: string;
    agent: Agent;
    primitive: Agent["primitives"][number];
    domain_type: string;
    inputs: OutputRecord[];
    skills: readonly SkillRecord[];
  }

  function prepareChair(chair: Chair, phaseName: string): PreparedChair {
    const agent = standard.agents.find((a) => a.slug === chair.agent_slug);
    if (!agent) throw new RuntimeError(`phase "${phaseName}" chair "${chair.role}" references unknown agent "${chair.agent_slug}"`);
    const primitive = agent.primitives[0];
    if (!primitive) throw new RuntimeError(`agent "${agent.slug}" declares no primitive`);
    const domain_type = agent.output_types[0];
    if (!domain_type) throw new RuntimeError(`agent "${agent.slug}" declares no output_type`);

    // Gather upstream inputs. When the chair declares depends_on, use the
    // OutputRecords of those specific roles. When it doesn't (legacy / no-deps
    // chair), fall back to the legacy behavior — all prior outputs whose
    // domain_type this agent's input_types declares it consumes. This keeps
    // runtime.test.ts (which uses legacy `{name, agent}` phases) working.
    let inputs: OutputRecord[];
    if (chair.depends_on.length > 0) {
      inputs = [];
      for (const dep of chair.depends_on) {
        const rec = producedByRole.get(dep);
        if (!rec) {
          throw new RuntimeError(`chair "${chair.role}" depends_on "${dep}" which has not been produced`);
        }
        inputs.push(rec);
      }
    } else {
      inputs = produced.filter((o) => agent.input_types.includes(o.domain_type));
    }

    // Runtime input_contract check: every type the chair declares it expects
    // on input must be present among the domain_types of its actual upstream
    // inputs. Empty input_contract skips the check.
    if (chair.input_contract.length > 0) {
      const upstreamTypes = new Set(inputs.map((o) => o.domain_type));
      for (const need of chair.input_contract) {
        if (!upstreamTypes.has(need)) {
          throw new RuntimeError(
            `chair "${chair.role}" input_contract requires "${need}" but upstream outputs only provide [${[...upstreamTypes].join(",")}]`,
          );
        }
      }
    }

    // Resolve this agent's skill bindings (slugs) against the genome's skills
    // map. Unknown slugs surface as a missing Skills layer in the prompt.
    const skills = resolveSkills(agent.skill_slugs, deps.skills);

    // BUDGET CHECK — pre-invocation. Synchronous so BudgetExhausted (and a
    // TypeError thrown from JSON.stringify on a circular gig_input) propagate
    // unwrapped to the caller rather than being aggregated as a chair failure.
    if (budget) {
      const cost = computeAppendCost({ agent, phase: phaseName, inputs, gig_input: gigInput }, budget.base_cost, budget.k);
      if (budget.balance < cost) {
        budget.agent_state = "depleted";
        budget.depleted_agent = agent.slug;
        budget.depleted_at = new Date().toISOString();
        throw new BudgetExhausted(agent.slug, budget.balance, cost, budget);
      }
      budget.spent += cost;
      budget.balance = budget.opening - budget.spent + budget.credit;
    }

    return { chair, phaseName, agent, primitive, domain_type, inputs, skills };
  }

  // Stage 2 — actual invocation + post-invocation output_contract check + write.
  // Errors here ARE aggregated by Promise.allSettled and surfaced as a phase-
  // level RuntimeError naming every failing chair role.
  async function invokeAndWriteChair(p: PreparedChair): Promise<OutputRecord> {
    const { chair, phaseName, agent, primitive, domain_type, inputs, skills } = p;
    const data = await deps.invoke({ agent, phase: phaseName, inputs, gig_input: gigInput, skills });

    // Runtime output_contract check: every type the chair promised to produce
    // must be covered by the bound agent's declared output_types. Empty
    // output_contract is already rejected at compose time; this is the runtime
    // mirror (a hand-rolled Standard literal could still ship an empty one).
    if (chair.output_contract.length > 0) {
      const producedTypes = new Set(agent.output_types);
      for (const promised of chair.output_contract) {
        if (!producedTypes.has(promised)) {
          throw new RuntimeError(
            `chair "${chair.role}" output_contract promises "${promised}" but agent "${agent.slug}" produced types [${agent.output_types.join(",")}]`,
          );
        }
      }
    }

    // Write the typed output (outputs.write validates data vs the domain schema).
    const rec = deps.outputs.write({
      core_type: PRIMITIVE_OUTPUT_TYPE[primitive],
      domain_type,
      domain: agent.domain ?? standard.domain,
      gig_id,
      agent_slug: agent.slug,
      phase: phaseName,
      primitive,
      data,
      input_refs: inputs.map((i) => i.id),
    });

    // Provenance: this output is derived_from each upstream input it consumed.
    for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", primitive);
    return rec;
  }

  const genome_hash = genomeHash(standard);
  // Content-address each output (not its random UUID) so the fingerprint is
  // reproducible: an honest replay of the same outputs recomputes the same
  // hashes, while changed content shifts them. See outputContentHash.
  const output_hashes = produced.map((p) => outputContentHash(p));

  // 5th-class evals: when the standard declares eval_slugs, run each against
  // the produced outputs and collect the scores. A score of 1.0 means the
  // eval's contract holds; 0.0 means it doesn't. v0 wire is intentionally
  // narrow — score is keyed presence; richer eval engines can subclass.
  const eval_scores: Record<string, number> = {};
  for (const slug of standard.eval_slugs ?? []) {
    eval_scores[slug] = scoreEval(slug, produced, deps.evals);
  }

  const run_fingerprint = runFingerprint({
    genome_hash,
    model_version: deps.model_version ?? "unknown",
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores,
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

  const result: GigResult = { gig_id, standard_slug: standard.slug, genome_hash, run_fingerprint, outputs: produced, eval_scores, status: "complete" };
  if (budget) result.budget_state = budget;
  return result;
}

// v0 eval-scorer: a minimal scan over the produced outputs. The named eval is
// looked up by slug (no shared genome handle in the runtime today), so we use
// a deterministic per-slug shape:
//   * default: 1.0 if any output exists, else 0.0
// Future builders should grow this into a real eval engine that reads the eval
// file's `asserts`/`on_type`/scoring function and applies it.
/**
 * Real (deterministic) eval judge. Resolves the eval by slug, then:
 *   - unresolvable slug → 0.0 (can't attest a contract that isn't defined)
 *   - `on_type` declared but not produced → 0.0 (the target wasn't made)
 *   - `non_empty_fields` declared → 1.0 iff every named field is present + non-empty
 *     in EVERY produced output of `on_type`, else 0.0
 *   - no structured predicate → presence of a typed target is the (weaker) contract
 * Deterministic by design: eval_scores feed run_fingerprint, so the judge must not
 * depend on the model (an LLM-as-judge would make replay non-reproducible).
 */
function scoreEval(slug: string, produced: readonly OutputRecord[], evals?: ReadonlyMap<string, EvalRecord>): number {
  const ev = evals?.get(slug);
  if (!ev) return 0.0;
  const onType = typeof ev["on_type"] === "string" ? (ev["on_type"] as string) : undefined;
  const targets = onType ? produced.filter((o) => o.domain_type === onType) : produced;
  if (targets.length === 0) return 0.0;
  const fields = Array.isArray(ev["non_empty_fields"]) ? (ev["non_empty_fields"] as string[]) : [];
  if (fields.length > 0) {
    const allHold = targets.every((o) => {
      const data = o.data as Record<string, unknown> | undefined;
      return fields.every((f) => isNonEmptyValue(data?.[f]));
    });
    return allHold ? 1.0 : 0.0;
  }
  return 1.0;
}

function isNonEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true; // numbers, booleans — present counts
}
