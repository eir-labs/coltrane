// §13/runtime — the gig executor. Walks a standard's phases, invokes each agent
// (via an INJECTED invoker so the orchestration is testable without spawning Claude),
// writes each typed output to the store (validated), links provenance (derived_from),
// and records one ledger entry with a deterministic genome_hash + a run_fingerprint
// that carries model_version + (empty, v0) eval_scores — honestly un-tempered.
import { randomUUID } from "node:crypto";
import type { Standard, Agent, Chair } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE, CORE_TYPES } from "./core_types.js";
import { executeSkill } from "./skill_subprocess.js";
import { loadSkillPackage } from "./skills.js";

// core type → the process primitive that produces it (reverse of PRIMITIVE_OUTPUT_TYPE).
// A skill-backed chair seals its output as this primitive/core when its output_contract is
// a core type.
const CORE_TO_PRIMITIVE: Record<string, Agent["primitives"][number]> = Object.fromEntries(
  Object.entries(PRIMITIVE_OUTPUT_TYPE).map(([prim, core]) => [String(core), prim as Agent["primitives"][number]]),
);
import { sha256Hex, canonJson, runFingerprint, outputContentHash, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import type { OutputStore, OutputRecord } from "./outputs.js";
import type { Ledger, GigUsage } from "./ledger.js";
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
  // The output types THIS chair seals — the chair's output_contract intersected with the
  // agent's declared outputs (#174). A multi-capability agent bound to a single-purpose chair
  // produces only the promised subset, not its whole catalogue. The Claude invoker keys its
  // Task layer on this so the model is asked for exactly these types. Absent/empty (legacy
  // hand-rolled ctx) → the invoker falls back to the agent's full output_types.
  output_types?: readonly string[];
  skills?: readonly SkillRecord[];
  // Agent-layer observability: the invoker calls this for each event the child emits
  // (stream-json: tool_use, tool_result, assistant text, result). The runtime forwards
  // them to RunDeps.onProgress tagged with phase+role so a live monitor can show what a
  // chair's child is doing without hunting its session transcript by mtime.
  onEvent?: (ev: AgentStreamEvent) => void;
}

// One parsed event from a chair's child process (a stream-json line). `type` is the
// child's event type ("assistant" | "tool_use" | "tool_result" | "result" | …); `raw`
// carries the full event for a consumer that wants more than the summary fields.
export interface AgentStreamEvent {
  type: string;
  tool?: string | undefined;      // for tool_use: the tool name
  text?: string | undefined;      // for assistant/result: any text payload
  raw?: unknown;                  // the full parsed event
}

// Coltrane-layer observability: the runtime fires one of these at each gig milestone so a
// caller (the async dispatcher) can track progress live instead of waiting for the whole
// synchronous run. agent_event re-emits a chair's child events, tagged with phase+role.
export type GigProgressEvent =
  | { type: "phase_start"; phase: string; roles: string[] }
  | { type: "chair_start"; phase: string; role: string; producer: string }
  | { type: "chair_complete"; phase: string; role: string; producer: string; output_types: string[]; duration_ms: number }
  | { type: "chair_failed"; phase: string; role: string; error: string }
  | { type: "agent_event"; phase: string; role: string; event: AgentStreamEvent }
  | { type: "gig_complete"; outputs: number }
  | { type: "gig_failed"; error: string };

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
  // Skills-as-first-class: maps a skill slug → its package directory on disk, so a
  // skill-backed chair (Chair.skill_slug) can be executed via the permission-tiered
  // subprocess instead of the model. Absent = no skill chairs resolvable. Declared
  // here; runtime routing (executeSkillChair) lands in Phase 1.
  skill_dirs?: ReadonlyMap<string, string> | undefined;
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
  // Live progress sink. Fired at each gig milestone (phase/chair/agent-event/complete) so an
  // async dispatcher can surface a running gig's state. Absent = no progress emitted (the
  // synchronous path is unaffected). Guarded best-effort — a sink that throws is swallowed
  // so observability can't fail the gig.
  onProgress?: ((ev: GigProgressEvent) => void) | undefined;
  // Pre-assigned gig id. The async dispatcher generates the id up front (to create the live
  // state entry + return it immediately) and passes it in so state and result share one id.
  // Absent = the runtime mints one (the synchronous path).
  gig_id?: string | undefined;
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
  /** Settled model spend (#195). Present when ≥1 real model invocation ran this gig. */
  usage?: GigUsage;
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

// Subtype-aware type match (docs/genome-extension.md — polymorphism). A declared
// type is satisfied by an output of the SAME domain_type (exact) OR — when the
// declared type is a CORE type — by any output whose core_type is that core (i.e.
// a domain type extending it). Domain-type declarations stay exact; only core-type
// declarations are polymorphic, so a base player written against `Interpretation`
// consumes any downstream subtype while domain contracts keep their precision.
const CORE_TYPE_SET: ReadonlySet<string> = new Set(CORE_TYPES);
function outputSatisfiesType(output: OutputRecord, declared: string): boolean {
  if (output.domain_type === declared) return true;
  if (CORE_TYPE_SET.has(declared) && output.core_type === declared) return true;
  return false;
}

export async function runGig(
  standard: Standard,
  gigInput: Record<string, unknown>,
  deps: RunDeps,
): Promise<GigResult> {
  const gig_id = deps.gig_id ?? randomUUID();
  const started_at = new Date().toISOString();
  const produced: OutputRecord[] = [];

  // #195 — settled model spend, accumulated from each agent invocation's `result` event (the
  // stream-json result carries usage + total_cost_usd + a per-model breakdown). These were
  // forwarded to onEvent but dropped; we fold them here and persist on the ledger entry. JS is
  // single-threaded, so += from the concurrent chair callbacks is race-free.
  const usage: GigUsage = { input_tokens: 0, output_tokens: 0, total_cost_usd: 0, by_model: {} };
  let sawUsage = false;
  const captureUsage = (ev: AgentStreamEvent): void => {
    if (ev.type !== "result") return;
    const raw = ev.raw as Record<string, unknown> | undefined;
    if (!raw) return;
    const u = raw["usage"] as Record<string, unknown> | undefined;
    const cost = typeof raw["total_cost_usd"] === "number" ? (raw["total_cost_usd"] as number) : 0;
    const inTok = u && typeof u["input_tokens"] === "number" ? (u["input_tokens"] as number) : 0;
    const outTok = u && typeof u["output_tokens"] === "number" ? (u["output_tokens"] as number) : 0;
    usage.input_tokens += inTok;
    usage.output_tokens += outTok;
    usage.total_cost_usd += cost;
    sawUsage = true;
    // Per-model breakdown keyed by the ACTUAL model id that ran (not the configured tier).
    const mu = raw["modelUsage"] as Record<string, Record<string, unknown>> | undefined;
    if (mu) {
      for (const [model, m] of Object.entries(mu)) {
        const slot = usage.by_model[model] ?? { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        slot.input_tokens += typeof m["inputTokens"] === "number" ? (m["inputTokens"] as number) : 0;
        slot.output_tokens += typeof m["outputTokens"] === "number" ? (m["outputTokens"] as number) : 0;
        slot.cost_usd += typeof m["costUSD"] === "number" ? (m["costUSD"] as number) : 0;
        usage.by_model[model] = slot;
      }
    }
  };

  // #156 — the standard's declared gig inputs. An entry chair (first phase, depends_on []) reads
  // its typed input_contract from gigInput; those types are satisfied by the gig payload, not an
  // upstream record. Validate the payload against every entry chair's contract BEFORE any chair
  // fires — a missing gig input is a hard stop, so no model tokens are spent on bad input.
  const standardInputs = new Set<string>(standard.input_types ?? []);
  const firstPhase = standard.phases[0];
  if (firstPhase) {
    for (const ch of firstPhase.chairs) {
      if (ch.depends_on.length > 0) continue;
      for (const need of ch.input_contract) {
        if (standardInputs.has(need) && gigInput[need] === undefined) {
          throw new RuntimeError(
            `gig input missing "${need}" required by entry chair "${ch.role}" (MissingGigInput)`,
          );
        }
      }
    }
  }

  // Best-effort progress sink — a logging/monitor sink must never break the run.
  const emit = (ev: GigProgressEvent): void => {
    try { deps.onProgress?.(ev); } catch { /* observability must not fail the gig */ }
  };

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

  // Resolve agent-by-slug once.
  const agentBySlug = new Map(standard.agents.map((a) => [a.slug, a]));

  // Cross-phase role → output map. A chair in phase N can depends_on a chair
  // in phase 0..N-1; this map carries each completed chair's outputS by role so
  // downstream chairs can resolve their depends_on regardless of phase. A chair can
  // seal MORE than one record (one per declared output type — e.g. a SENSE+JUDGE agent
  // yields both a Signal hit and a Judgment verdict), so a role maps to a LIST; a
  // dependent receives all of a role's records and picks the type its contract needs.
  const producedByRole = new Map<string, OutputRecord[]>();

  for (const phase of standard.phases) {
    emit({ type: "phase_start", phase: phase.name, roles: phase.chairs.map((c) => c.role) });

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
          emit({ type: "chair_failed", phase: phase.name, role: ch.role, error: reason });
        } else {
          producedByRole.set(ch.role, r.value);
          produced.push(...r.value);
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
    agent?: Agent;          // undefined for a skill-backed chair
    skill_dir?: string;     // set for a skill-backed chair (runs deterministic code, no model)
    primitive: Agent["primitives"][number];
    domain_type: string;
    // One spec per declared output type the chair seals. Single-output chairs have one
    // entry (the invoker blob IS its data); multi-output chairs have N (the invoker blob
    // is keyed by domain_type). Each type's core_type comes from its OWN extends, since an
    // agent's primitives and output_types are not 1:1.
    output_specs: Array<{ domain_type: string; core_type: string; primitive: Agent["primitives"][number] }>;
    inputs: OutputRecord[];
    skills: readonly SkillRecord[];
  }

  // Resolve a chair's declared output types into seal-specs (type → core → primitive).
  function outputSpecsFor(domainTypes: readonly string[], fallbackPrimitive: Agent["primitives"][number]): PreparedChair["output_specs"] {
    return domainTypes.map((dt) => {
      const core = deps.outputs.coreTypeOf(dt) ?? PRIMITIVE_OUTPUT_TYPE[fallbackPrimitive];
      const primitive = (CORE_TO_PRIMITIVE[core] ?? fallbackPrimitive) as Agent["primitives"][number];
      return { domain_type: dt, core_type: core, primitive };
    });
  }

  function prepareChair(chair: Chair, phaseName: string): PreparedChair {
    // A skill-backed chair runs the skill's deterministic code half — no agent, no model.
    if (chair.skill_slug && (chair.agent_slug ?? "") === "") {
      const dir = deps.skill_dirs?.get(chair.skill_slug);
      if (!dir) throw new RuntimeError(`phase "${phaseName}" chair "${chair.role}" is skill-backed ("${chair.skill_slug}") but no skill_dir is registered`);
      const domain_type = chair.output_contract[0] ?? "Signal";
      // Resolve the core via the registry the same way an agent chair does (outputSpecsFor):
      // output_contract[0] may be a DOMAIN type (e.g. triage-verdict → Verdict), not a bare core.
      const core = deps.outputs.coreTypeOf(domain_type) ?? "Signal";
      const primitive = CORE_TO_PRIMITIVE[core] ?? "SENSE";
      const inputs: OutputRecord[] = [];
      for (const dep of chair.depends_on) {
        const recs = producedByRole.get(dep);
        if (!recs?.length) throw new RuntimeError(`chair "${chair.role}" depends_on "${dep}" which has not been produced`);
        inputs.push(...recs);
      }
      if (chair.input_contract.length > 0) {
        for (const need of chair.input_contract) {
          // #156: a type satisfied by an upstream record OR by the gig payload (entry-chair seed).
          const fromGig = standardInputs.has(need) && gigInput[need] !== undefined;
          if (!fromGig && !inputs.some((o) => outputSatisfiesType(o, need))) {
            throw new RuntimeError(`chair "${chair.role}" input_contract requires "${need}" but upstream outputs only provide [${inputs.map((o) => o.domain_type).join(",")}]`);
          }
        }
      }
      // A skill-backed chair seals exactly one output (its deterministic code returns one blob).
      const output_specs = [{ domain_type, core_type: core, primitive }];
      return { chair, phaseName, skill_dir: dir, primitive, domain_type, output_specs, inputs, skills: [] };
    }

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
        const recs = producedByRole.get(dep);
        if (!recs?.length) {
          throw new RuntimeError(`chair "${chair.role}" depends_on "${dep}" which has not been produced`);
        }
        inputs.push(...recs);
      }
    } else {
      inputs = produced.filter((o) => agent.input_types.some((t) => outputSatisfiesType(o, t)));
    }

    // Runtime input_contract check: every type the chair declares it expects
    // on input must be satisfied by its actual upstream inputs. Subtype-aware
    // (docs/genome-extension.md): a core-type requirement is met by any domain
    // subtype extending it; a domain-type requirement stays exact. Empty skips.
    if (chair.input_contract.length > 0) {
      for (const need of chair.input_contract) {
        // #156: satisfied by an upstream record OR the gig payload (entry-chair typed seed).
        const fromGig = standardInputs.has(need) && gigInput[need] !== undefined;
        if (!fromGig && !inputs.some((o) => outputSatisfiesType(o, need))) {
          const provided = inputs.map((o) => o.domain_type).join(",");
          throw new RuntimeError(
            `chair "${chair.role}" input_contract requires "${need}" but upstream outputs only provide [${provided}]`,
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

    // Seal one record per type THIS CHAIR promises (#174): the output_contract is the SELECTOR,
    // not just a check — a chair bound to a multi-output agent seals only the subset it declares,
    // intersected with the agent's real outputs (so a stray contract entry can't conjure a type
    // the agent doesn't produce; the post-invocation check below still reports that mismatch).
    // Empty contract (legacy hand-rolled chair) → fall back to the agent's full output set.
    const wanted = chair.output_contract.length
      ? agent.output_types.filter((t) => chair.output_contract.includes(t))
      : agent.output_types;
    const output_specs = outputSpecsFor(wanted, primitive);
    return { chair, phaseName, agent, primitive, domain_type, output_specs, inputs, skills };
  }

  // Stage 2 — actual invocation + post-invocation output_contract check + write.
  // Errors here ARE aggregated by Promise.allSettled and surfaced as a phase-
  // level RuntimeError naming every failing chair role.
  async function invokeAndWriteChair(p: PreparedChair): Promise<OutputRecord[]> {
    const { chair, phaseName, inputs, skills, output_specs } = p;
    const t0 = Date.now();
    const producerHint = chair.skill_slug || p.agent?.slug || chair.agent_slug || chair.role;
    emit({ type: "chair_start", phase: phaseName, role: chair.role, producer: producerHint });
    let data: Record<string, unknown>;
    let producer_slug: string;
    let domain: string;
    // Skill-backed chairs record which skill (version + verified code_hash + tier) sealed the
    // output, so the ledger entry traces back to the exact SkillChainEvent. Undefined for agents.
    let skill_provenance: { slug: string; version: number; code_hash: string; tier: number } | undefined;

    if (p.skill_dir) {
      // SKILL-BACKED chair: run the deterministic code half in the permission cage — the
      // model is never invoked. The skill reads the merged upstream data (or the gig input
      // when it's a root chair). This is the proper fix for "an LLM should not babysit a
      // deterministic command": the command IS the chair.
      const skillInput = inputs.length > 0 ? Object.assign({}, ...inputs.map((i) => i.data)) : gigInput;
      const r = executeSkill(p.skill_dir, skillInput);
      if (!r.ok) throw new RuntimeError(`skill chair "${chair.role}" ("${chair.skill_slug}") failed: ${r.error}`);
      data = (r.output && typeof r.output === "object" ? r.output : {}) as Record<string, unknown>;
      producer_slug = chair.skill_slug!;
      domain = standard.domain;
      const pkg = loadSkillPackage(p.skill_dir);
      skill_provenance = {
        slug: pkg.meta.slug,
        version: pkg.meta.version,
        code_hash: pkg.codeHash ?? "",
        tier: pkg.meta.permission?.tier ?? 0,
      };
    } else {
      const agent = p.agent!;
      data = await deps.invoke({
        agent, phase: phaseName, inputs, gig_input: gigInput, skills,
        output_types: output_specs.map((s) => s.domain_type), // #174 — the chair's promised subset
        onEvent: (ev) => { captureUsage(ev); emit({ type: "agent_event", phase: phaseName, role: chair.role, event: ev }); },
      });
      // Runtime output_contract check: every type the chair promised must be covered by the
      // bound agent's declared output_types (compose-time mirror; a hand-rolled literal could
      // still ship a mismatch).
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
      producer_slug = agent.slug;
      domain = agent.domain ?? standard.domain;
    }

    // Seal one record per type this chair seals. The invoker blob may be keyed by domain_type
    // (a SENSE+JUDGE agent returns { hit: {...}, verdict: {...} } → a Signal AND a Judgment from
    // one pass) OR, for a lone unkeyed output, BE the data directly. So: prefer a key matching
    // the type; for a single sealed type, fall back to the whole blob when no such key exists.
    // This keeps narrowing correct even when an over-eager invoker returns extra keys (#174) —
    // the chair seals only its promised types and reads each from its own key.
    // A keyed type may be CONDITIONAL (e.g. a verdict's provisional-draft only on FILEABLE), so a
    // missing key is skipped, not an error — the downstream input_contract check fails loudly if a
    // consumer actually needed a type that wasn't produced. Tag each with `from_role`.
    // #196 — fill placeholder provenance hashes with the REAL content_sha. Agents are asked to emit
    // *_sha fields but have no hashing tool, so they fabricate sentinels (sha256:PLACEHOLDER-…); the
    // sealed record then carries fake hashes and the "byte-reproducible survival chain" is hollow.
    // The engine knows the truth: each consumed input's content_sha + the gig input's hash. Resolve a
    // placeholder `<x>_sha` field to the input whose domain_type shares a name token, or the gig input
    // for a disclosure/input field. Unresolved (e.g. a round-1 predecessor) → "" (honest: no predecessor).
    const PLACEHOLDER_SHA = /^sha256:(UNCOMPUTED-)?PLACEHOLDER/i;
    const shaByType = new Map<string, string>();
    for (const inp of inputs) if (!shaByType.has(inp.domain_type)) shaByType.set(inp.domain_type, inp.content_sha);
    // Hash the gig input lazily — only when a placeholder actually resolves to it (most outputs have
    // no *_sha fields, and a hostile/circular gig input shouldn't be canonicalized unless needed).
    let gigInputShaCache: string | undefined;
    const gigInputSha = (): string => (gigInputShaCache ??= sha256Hex(canonJson(gigInput)));
    const resolveSha = (field: string): string | undefined => {
      const tokens = field.replace(/_sha$/i, "").split(/[_-]/).filter(Boolean);
      for (const [type, sha] of shaByType) {
        const ttok = type.split(/[-_]/);
        if (tokens.some((t) => ttok.includes(t))) return sha;
      }
      if (tokens.includes("disclosure") || tokens.includes("input")) return gigInputSha();
      return undefined;
    };
    const backfillShas = (obj: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (/_sha$/i.test(k) && typeof v === "string" && PLACEHOLDER_SHA.test(v)) obj[k] = resolveSha(k) ?? "";
      }
    };

    const single = output_specs.length === 1;
    const written: OutputRecord[] = [];
    for (const spec of output_specs) {
      const keyed = data[spec.domain_type] as Record<string, unknown> | undefined;
      const slice = keyed !== undefined && keyed !== null ? keyed : single ? data : undefined;
      if (slice === undefined || slice === null) continue;
      if (typeof slice !== "object" || slice === null) {
        throw new RuntimeError(
          `chair "${chair.role}" output "${spec.domain_type}" must be a JSON object, got ${typeof slice}`,
        );
      }
      backfillShas(slice as Record<string, unknown>);
      const rec = deps.outputs.write({
        core_type: spec.core_type,
        domain_type: spec.domain_type,
        domain,
        gig_id,
        agent_slug: producer_slug,
        from_role: chair.role,
        phase: phaseName,
        primitive: spec.primitive,
        data: slice as Record<string, unknown>,
        input_refs: inputs.map((i) => i.id),
        input_shas: inputs.map((i) => i.content_sha), // #196 — real predecessor hashes, engine-stamped
        skill_provenance,
      });
      for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", spec.primitive);
      written.push(rec);
    }
    if (written.length === 0) {
      throw new RuntimeError(
        `chair "${chair.role}" produced no recognized output — expected one of [${output_specs.map((s) => s.domain_type).join(", ")}]`,
      );
    }
    emit({
      type: "chair_complete", phase: phaseName, role: chair.role, producer: producer_slug,
      output_types: written.map((w) => w.domain_type), duration_ms: Date.now() - t0,
    });
    return written;
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
    // settled model spend (#195) — omitted when no model ran (skill-only gigs / stubbed invokers).
    ...(sawUsage ? { usage } : {}),
  });

  // Cycle complete — when a budget was supplied, mark it `settled` and
  // surface the final state in the manifest. `settled` mirrors the
  // budget-state.json cycle terminal-state semantics for a closed cycle.
  if (budget) {
    budget.agent_state = "settled";
  }

  const result: GigResult = { gig_id, standard_slug: standard.slug, genome_hash, run_fingerprint, outputs: produced, eval_scores, status: "complete" };
  if (sawUsage) result.usage = usage;
  if (budget) result.budget_state = budget;
  emit({ type: "gig_complete", outputs: produced.length });
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
  // Subtype-aware (genome extension): an eval declared on a CORE type judges any domain
  // subtype filling it, same as a core-type contract — so polymorphism reaches evals too.
  const targets = onType ? produced.filter((o) => outputSatisfiesType(o, onType)) : produced;
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
