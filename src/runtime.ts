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
import { LEDGER_SCHEMA_VERSION, type Ledger, type GigUsage } from "./ledger.js";
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
  // #241 — the skill slugs this agent DECLARES that resolved to no package at all. Present
  // (possibly empty) whenever the runtime actually attempted resolution; ABSENT means no
  // resolution was attempted (no skills map supplied), which is not the same claim. The
  // Claude invoker reads it so the prompt never names a skill the agent does not hold.
  missing_skills?: readonly string[];
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
  | {
      type: "chair_complete"; phase: string; role: string; producer: string;
      /** types actually SEALED */
      output_types: string[];
      duration_ms: number;
      /** #243 — types the chair's output_contract PROMISED. Equal to output_types when the
       *  chair delivered everything; the difference is what `missing_output_types` names. */
      promised_output_types?: string[];
      /** #243 — promised but not sealed. Legal (conditional outputs) but never silent. */
      missing_output_types?: string[];
      /** #240 — `*_sha` fields the engine could not tie to any consumed input or the gig
       *  payload. Sealed as "" rather than guessed; listed here so the gap is visible. */
      unresolved_sha_fields?: string[];
    }
  | { type: "chair_failed"; phase: string; role: string; error: string }
  // #241 — one or more of the agent's declared skill_slugs resolved to no package. Not fatal
  // (the chair did not declare them REQUIRED), but never silent again: an unskilled run used
  // to be cryptographically identical to a skilled one — same genome_hash, run_fingerprint
  // AND content_sha — so this channel is the only place the difference is observable live.
  | { type: "skills_unresolved"; phase: string; role: string; agent: string; missing: string[] }
  | { type: "agent_event"; phase: string; role: string; event: AgentStreamEvent }
  | { type: "gig_complete"; outputs: number }
  | { type: "gig_failed"; error: string };

// The one non-deterministic seam. Inject a deterministic fn in tests; the real
// Claude subprocess call in the stdio entry. The runtime around it is deterministic.
export type AgentInvoker = (
  ctx: AgentInvocationContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

// What a chair-selection policy sees when it narrows a dispatch batch: the ready
// frontier (depends_on satisfied), everything sealed so far, the live budget, and
// the standard itself. Read-only by contract — the policy decides, it never plays.
export interface ChairSelectionView {
  phase: string;
  ready: readonly Chair[];
  produced: readonly OutputRecord[];
  budget: Readonly<BudgetState> | null;
  standard: Standard;
}

// The routing-policy seam (the Étude/conductor hole). Given the ready frontier,
// return the non-empty subset to dispatch THIS iteration; unselected chairs stay
// in `remaining` and re-enter the next frontier — which is how the default
// parallel batch becomes a conducted sequence. The runtime rejects an empty or
// non-subset return (RuntimeError): a buggy policy must fail loudly, not fall
// back to the default routing and masquerade as a decision.
export type ChairSelector = (
  view: ChairSelectionView,
) => readonly Chair[] | Promise<readonly Chair[]>;

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
   * opening - spent + credit.
   *
   * The cycle is RESERVE → SETTLE (#232). At chair-prep the runtime computes
   * cost-of-append (base + k*size(input)) and compares it against
   * `balance - reserved`; short → BudgetExhausted. Passing chairs RESERVE the
   * cost. `spent` moves only when a chair's invocation SUCCEEDS, which is what
   * the contract always claimed and what the code did not do: prep runs
   * eagerly for the whole ready batch, so a batch member tripping the gate
   * used to leave every earlier member of that batch charged for work no
   * invoker ever started.
   *
   * The final BudgetState is returned in GigResult.budget_state, and is also
   * attached to a BudgetExhausted / mid-gig error so a FAILED gig can still
   * report what it cost.
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
  // Chair-selection policy (the adaptive-router seam). When present, each dispatch
  // iteration narrows the ready frontier to the policy's chosen subset instead of
  // running every ready chair in parallel. Absent = the v0 topological-parallel
  // routing, byte-identical to before this seam existed.
  selectChairs?: ChairSelector | undefined;
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
 *
 * WHAT THIS IS AND IS NOT (#233). `opening`/`spent`/`balance` are SYNTHETIC APPEND UNITS —
 * see `BudgetState.unit`. They are not dollars and were never converted to dollars; an
 * `opening: 1000` that reads like a dollar figure to an operator is a coincidence of scale.
 * The real, settled figure is `BudgetState.settled_usd`, reconciled from the model's own
 * `result` events at each batch boundary. Two honest limits on the synthetic gate:
 *
 *   1. It is a proxy for prompt size, not a price. It has no model tier, no output side, no
 *      skills/charter/schema bytes — only the agent slug, phase, consumed input CONTENT and
 *      the gig payload. It is a rate limiter on context growth, nothing more.
 *   2. A USD figure cannot gate a chair before that chair runs, because `prepareChair` runs
 *      for the WHOLE ready batch before any invocation — a chair cannot see its batch
 *      siblings' settled cost. So reconciliation happens at BATCH BOUNDARIES, and any dollar
 *      bound built on it would be a cap plus one batch of slack, never a hard stop. No such
 *      bound is wired: there is no per-chair dollar estimator, and inventing one would be
 *      guessing. `settled_usd` reports; it does not enforce.
 */
export interface BudgetInput {
  opening: number;
  /** base cost per agent invocation, in append units. Default 1. */
  base_cost?: number;
  /** per-byte multiplier on consumed-input size, in append units. Default 0.1. */
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
  /** Cost of chairs that ACTUALLY RAN AND SUCCEEDED. Reserved-but-unsettled cost is not here. */
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
  /**
   * #233 — the denomination of opening/spent/balance/base_cost/k, stated rather than assumed.
   * These are a synthetic proxy for consumed context bytes. They are NOT dollars, and nothing
   * converts between the two. Read `settled_usd` for money.
   */
  unit: "append-units";
  /**
   * #233 — REAL settled model spend for this gig so far, in USD, reconciled from the invokers'
   * own `result` events at each dispatch-batch boundary. This is the number `src/ledger.ts`
   * calls settled spend; the budget gate above never used it, even though it was live and
   * in-scope. Reporting only — see the BudgetInput docstring for why it cannot gate.
   * 0 when no invoker reported cost (stubbed invokers, skill-only gigs).
   */
  settled_usd: number;
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
  /**
   * #246 — declared eval_slugs that resolved to NO eval definition. They still appear in
   * `eval_scores` at 0.0 (back-compat: callers key off presence), but a 0.0 that means
   * "no such eval" is not the same claim as a 0.0 that means "the contract did not hold",
   * and the two used to be indistinguishable — including inside `run_fingerprint`.
   * Present only when non-empty.
   */
  unresolved_evals?: readonly string[];
  /**
   * #243 — chairs that sealed FEWER types than their output_contract promised. The runtime
   * treats output_contract as a selector, not a floor, because a keyed output can legitimately
   * be conditional. For a chair with a downstream consumer the shortfall surfaces as an
   * input_contract failure; for a TERMINAL chair nothing consumes it and the promise used to
   * evaporate into `status: "complete"`. Recording it is not enforcement — see the note at the
   * seal loop. Present only when non-empty.
   */
  unfulfilled_outputs?: ReadonlyArray<{ role: string; phase: string; missing: readonly string[] }>;
  status: "complete";
  /** Final budget snapshot. Present only when a budget was supplied. */
  budget_state?: BudgetState;
  /** Settled model spend (#195). Present when ≥1 real model invocation ran this gig. */
  usage?: GigUsage;
}

/**
 * #236 — settled spend used to be discarded on every failed gig: `usage` was written only on
 * the success path, and the async dispatcher's `.catch` set status/error and nothing else. A
 * gig that burned $6 across four chairs and died on the fifth reported zero dollars, everywhere
 * — and failed gigs are exactly the ones whose cost an operator most needs. runGig now attaches
 * the partial accounting to whatever it throws; these read it back safely.
 */
export function partialGigUsage(e: unknown): GigUsage | undefined {
  if (!e || typeof e !== "object") return undefined;
  const u = (e as Record<string, unknown>)["usage"];
  return u && typeof u === "object" ? (u as GigUsage) : undefined;
}
export function partialBudgetState(e: unknown): BudgetState | undefined {
  if (!e || typeof e !== "object") return undefined;
  const b = (e as Record<string, unknown>)["budget_state"];
  return b && typeof b === "object" ? (b as BudgetState) : undefined;
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
 * Cost-of-append for an agent invocation, in synthetic append units (see BudgetState.unit).
 * Deterministic function of the input context size — same input → same cost. Keeps cost
 * calculation inside the runtime (not the invoker) so budget enforcement cannot be spoofed by
 * a misbehaving invoker.
 *
 * #233 — this used to serialize `input_ids`: the UUIDs of the upstream outputs a chair
 * consumes, not their data. An upstream output contributed exactly 36 bytes whether it was a
 * one-line signal or a 40-page draft, so the proxy was not even monotonic in the thing that
 * drives real cost. It now measures the CONTENT the invoker actually receives.
 *
 * Still excluded, honestly: resolved skills, the agent charter, type schemas, model tier,
 * max_tool_calls, and the entire output side. This is a rate limiter on consumed context, not
 * a price. Money is `BudgetState.settled_usd`.
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
    inputs: ctx.inputs.map((i) => i.data),
    gig_input: ctx.gig_input,
  }).length;
  return base_cost + k * size_bytes;
}

// Deterministic hash over the definitions a gig touches: the standard + its agents,
// in a canonical (sorted, JCS) form. This is the reproducibility key — same defs,
// same genome_hash, regardless of model or run.
/**
 * Resolve a list of skill slugs against the genome's skills map. REPORTS, never decides:
 * it returns both what resolved and what did not, and `prepareChair` decides what a miss
 * means (fatal when the chair declared the skill REQUIRED, reported otherwise).
 *
 * The boundary (#241): a skill package that LOADS is a legitimate degradation candidate —
 * it has an identity, a version, a code_hash, and its degradation is already surfaced and
 * sealed via `degraded_reason` (src/skills.ts resolveSkill). A slug that resolves to NO
 * PACKAGE AT ALL has nothing to degrade; it is a dangling reference, exactly the shape
 * `assertToolGrantsResolvable` already fails closed on ("a granted tool with no provider
 * is a dead name") and exactly the shape `Chair.skill_slug` already hard-throws on.
 *
 * An ABSENT map means resolution was never configured (the documented v0 back-compat path)
 * — that is not evidence of a dangling binding, so `missing` stays empty.
 */
function resolveSkills(
  slugs: readonly string[] | undefined,
  map: ReadonlyMap<string, SkillRecord> | undefined,
): { skills: readonly SkillRecord[]; missing: readonly string[] } {
  if (!slugs || slugs.length === 0 || !map) return { skills: [], missing: [] };
  const skills: SkillRecord[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const rec = map.get(slug);
    if (rec) skills.push(rec);
    else missing.push(slug);
  }
  return { skills, missing };
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
  //
  // #235 — capture is now ATTRIBUTED. The old gate was one gig-wide boolean flipped by the
  // first `result` event, which could not express three real states: (1) N chairs ran and one
  // reported, (2) a `result` event carrying no usage payload at all — whose implicit zeros
  // were folded in and reported as "$0.00 spent" where the truth is "unknown", and (3) a cost
  // with no per-model breakdown. Every invocation is now counted, and an invocation that
  // reports nothing is counted as UNATTRIBUTED rather than as free.
  const usage: GigUsage = { input_tokens: 0, output_tokens: 0, total_cost_usd: 0, by_model: {} };
  let startedInvocations = 0;
  let attributedInvocations = 0;
  let byModelPartial = false;

  // One sink per chair — `onEvent` is already per-chair, so attribution is expressible at the
  // only granularity that means anything. Returns whether THIS chair ever reported usage.
  const makeUsageSink = (): { fold: (ev: AgentStreamEvent) => void; attributed: () => boolean } => {
    let saw = false;
    return {
      attributed: () => saw,
      fold(ev: AgentStreamEvent): void {
        if (ev.type !== "result") return;
        const raw = ev.raw as Record<string, unknown> | undefined;
        if (!raw) return;
        const u = raw["usage"] as Record<string, unknown> | undefined;
        const mu = raw["modelUsage"] as Record<string, Record<string, unknown>> | undefined;
        const costRaw = raw["total_cost_usd"];
        const inRaw = u?.["input_tokens"];
        const outRaw = u?.["output_tokens"];
        const hasCost = typeof costRaw === "number";
        const hasTokens = typeof inRaw === "number" || typeof outRaw === "number";
        const hasBreakdown = !!mu && Object.keys(mu).length > 0;
        // A `result` event with no usage payload at all tells us NOTHING. Folding its implicit
        // zeros in is how "not captured" became "$0.00 spent" — the single most misleading
        // number this engine could produce about money.
        if (!hasCost && !hasTokens && !hasBreakdown) return;

        usage.input_tokens += typeof inRaw === "number" ? inRaw : 0;
        usage.output_tokens += typeof outRaw === "number" ? outRaw : 0;
        usage.total_cost_usd += hasCost ? (costRaw as number) : 0;
        // Per-model breakdown keyed by the ACTUAL model id that ran (not the configured tier).
        if (hasBreakdown) {
          for (const [model, m] of Object.entries(mu)) {
            const slot = usage.by_model[model] ?? { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
            slot.input_tokens += typeof m["inputTokens"] === "number" ? (m["inputTokens"] as number) : 0;
            slot.output_tokens += typeof m["outputTokens"] === "number" ? (m["outputTokens"] as number) : 0;
            slot.cost_usd += typeof m["costUSD"] === "number" ? (m["costUSD"] as number) : 0;
            usage.by_model[model] = slot;
          }
        } else {
          // The scalars moved but `by_model` did not — the breakdown cannot sum to the total.
          byModelPartial = true;
        }
        saw = true;
      },
    };
  };

  // Stamp the coverage counters and return the usage IFF anything was genuinely captured.
  // Idempotent: called on the success path and again from the failure path (#236).
  const finalizeUsage = (): GigUsage | undefined => {
    if (attributedInvocations === 0) return undefined;
    usage.invocations = startedInvocations;
    usage.unattributed_invocations = startedInvocations - attributedInvocations;
    if (usage.unattributed_invocations > 0) usage.partial = true;
    else delete usage.partial;
    if (byModelPartial) usage.by_model_partial = true;
    else delete usage.by_model_partial;
    return usage;
  };

  // #156 — the standard's declared gig inputs. A chair reads a declared gig-input type from
  // gigInput rather than from an upstream record (composition.ts: "gig inputs are available to
  // any chair"). The payload is validated BEFORE any chair fires — a missing gig input is a
  // hard stop, so no model tokens are spent on bad input.
  const standardInputs = new Set<string>(standard.input_types ?? []);

  // Keys are the HYPHENATED type slug. `grant_requirements` vs `grant-requirements` is the
  // single most common dispatch mistake, and the caller's own keys are in scope here.
  const normalizeKey = (k: string): string => k.toLowerCase().replace(/[_\-\s]/g, "");

  /**
   * #244 — the error must blame the layer that is actually wrong. "upstream outputs only
   * provide [...]" sent the operator to inspect a pipeline that is correctly wired when the
   * real cause is a missing key in their own dispatch payload. The `fromGig` disjunction
   * knows which branch failed; this carries that knowledge into the message.
   */
  function missingGigInput(need: string, role: string, upstreamProvided?: string): RuntimeError {
    const provided = Object.keys(gigInput);
    const target = normalizeKey(need);
    const nearMiss = provided.filter((k) => k !== need && normalizeKey(k) === target);
    const unknown = provided.filter((k) => !standardInputs.has(k));
    const quoted = (ks: string[]): string => ks.map((k) => `"${k}"`).join(", ");
    const hint =
      nearMiss.length > 0
        ? ` The payload carries ${quoted(nearMiss)} — gig input keys are the hyphenated type slug, so did you mean "${need}"?`
        : provided.length === 0
          ? ` The dispatch payload is empty.`
          : ` The payload's keys are [${quoted(provided)}]${unknown.length > 0 ? `; not declared by this standard: [${quoted(unknown)}]` : ""}.`;
    const upstream =
      upstreamProvided !== undefined
        ? ` (upstream provided [${upstreamProvided}], but "${need}" is a declared gig input and must come from the dispatch payload)`
        : ` (no upstream chair produces "${need}", so it can only come from the dispatch payload)`;
    return new RuntimeError(
      `gig input missing "${need}" required by chair "${role}" (MissingGigInput)${upstream}.${hint}`,
    );
  }

  // What each role will seal — known statically from the composed standard, which is what
  // makes the pre-flight below possible at t=0.
  const sealedByRole = new Map<string, readonly string[]>();
  for (const ph of standard.phases) {
    for (const ch of ph.chairs) {
      if (ch.skill_slug && (ch.agent_slug ?? "") === "") {
        sealedByRole.set(ch.role, [ch.output_contract[0] ?? "Signal"]);
        continue;
      }
      const ag = standard.agents.find((a) => a.slug === ch.agent_slug);
      if (!ag) continue; // prepareChair reports an unknown agent_slug precisely; don't pre-empt it
      sealedByRole.set(
        ch.role,
        ch.output_contract.length ? ag.output_types.filter((t) => ch.output_contract.includes(t)) : ag.output_types,
      );
    }
  }

  // Type-name mirror of outputSatisfiesType (no record exists yet at t=0). Deliberately
  // PERMISSIVE: an unresolvable core is treated as "might satisfy", so the pre-flight can
  // only ever fire on a PROVABLE miss and can never reject a runnable gig.
  const mightSatisfy = (producedType: string, need: string): boolean => {
    if (producedType === need) return true;
    if (!CORE_TYPE_SET.has(need)) return false;
    const core = deps.outputs.coreTypeOf(producedType);
    return core === null || core === need;
  };

  // The pre-flight itself. v0 checked ONLY phase 0, and within it only `depends_on: []`
  // chairs — while its own comment promised "every entry chair" and "no model tokens are
  // spent". Both exclusions are reachable with a validly composed standard, so a real chair
  // fired and burned real money before a failure that was knowable before the gig started.
  {
    const producedByEarlierPhases: string[] = [];
    for (const ph of standard.phases) {
      const sealedThisPhase: string[] = [];
      for (const ch of ph.chairs) {
        // Mirrors prepareChair's input gathering: declared deps, else everything sealed by a
        // strictly-earlier phase (a superset of the legacy input_types filter — permissive).
        const reachable =
          ch.depends_on.length > 0
            ? ch.depends_on.flatMap((d) => sealedByRole.get(d) ?? [])
            : producedByEarlierPhases;
        for (const need of ch.input_contract) {
          if (!standardInputs.has(need)) continue;      // not a gig input — upstream's job
          if (gigInput[need] !== undefined) continue;   // supplied
          if (reachable.some((t) => mightSatisfy(t, need))) continue; // an upstream can cover it
          throw missingGigInput(need, ch.role);
        }
        sealedThisPhase.push(...(sealedByRole.get(ch.role) ?? []));
      }
      producedByEarlierPhases.push(...sealedThisPhase);
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
        unit: "append-units",
        settled_usd: 0,
      }
    : null;
  // #232 — cost RESERVED by chairs that passed the gate but have not settled. `prepareChair`
  // runs eagerly for the whole ready batch, so the gate must see its batch siblings' holds;
  // but a hold is not spend. It converts to `spent` only when the invocation succeeds, and is
  // released (never charged) when it fails or when a later sibling trips the gate and the
  // batch is abandoned before a single invoker is called.
  let reserved = 0;

  // Resolve agent-by-slug once.
  const agentBySlug = new Map(standard.agents.map((a) => [a.slug, a]));

  // Cross-phase role → output map. A chair in phase N can depends_on a chair
  // in phase 0..N-1; this map carries each completed chair's outputS by role so
  // downstream chairs can resolve their depends_on regardless of phase. A chair can
  // seal MORE than one record (one per declared output type — e.g. a SENSE+JUDGE agent
  // yields both a Signal hit and a Judgment verdict), so a role maps to a LIST; a
  // dependent receives all of a role's records and picks the type its contract needs.
  const producedByRole = new Map<string, OutputRecord[]>();

  // #243 — chairs that sealed fewer types than their output_contract promised, collected for
  // the manifest. Recording, not enforcement: see the seal loop.
  const unfulfilledOutputs: Array<{ role: string; phase: string; missing: readonly string[] }> = [];

  try {

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
      let ready: Chair[] = [];
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

      // Routing policy: when a selector is injected, it narrows the frontier to the
      // chairs to dispatch THIS iteration; the rest stay in `remaining` and re-enter
      // the next frontier. The return is validated strictly — empty or containing a
      // chair outside the frontier is a policy bug and must not pass silently.
      if (deps.selectChairs) {
        const chosen = await deps.selectChairs({
          phase: phase.name, ready, produced, budget, standard,
        });
        const readyRoles = new Set(ready.map((c) => c.role));
        if (chosen.length === 0) {
          throw new RuntimeError(`phase "${phase.name}" selectChairs returned no chairs from ready frontier [${[...readyRoles].join(", ")}]`);
        }
        const outside = chosen.filter((c) => !readyRoles.has(c.role));
        if (outside.length > 0) {
          throw new RuntimeError(
            `phase "${phase.name}" selectChairs returned chair(s) outside the ready frontier: [${outside.map((c) => c.role).join(", ")}] (ready: [${[...readyRoles].join(", ")}])`,
          );
        }
        // Dispatch the frontier's own Chair objects for the chosen roles (dedup by
        // role) — a selector echoing copies can't smuggle in a mutated chair.
        const chosenRoles = new Set(chosen.map((c) => c.role));
        ready = ready.filter((c) => chosenRoles.has(c.role));
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
      // #233 — BATCH BOUNDARY is the only point at which real settled dollars can be
      // reconciled into the budget: prepareChair ran for every chair in this batch before any
      // of them was invoked, so no chair could have seen its siblings' cost. Reporting only.
      if (budget) budget.settled_usd = usage.total_cost_usd;

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
    /** #232 — append-unit cost RESERVED for this chair at prep. Settled to `spent` only on
     *  success; released without charge otherwise. Absent when no budget is enforced. */
    cost?: number;
    // #241 — declared skill slugs that resolved to no package. Threaded to the invocation
    // context so the prompt can never name a skill the agent does not actually hold.
    missing_skills: readonly string[];
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
            const provided = inputs.map((o) => o.domain_type).join(",");
            // #244 — this disjunction knows WHICH branch failed; don't discard that.
            throw standardInputs.has(need)
              ? missingGigInput(need, chair.role, provided)
              : new RuntimeError(`chair "${chair.role}" input_contract requires "${need}" but upstream outputs only provide [${provided}]`);
          }
        }
      }
      // A skill-backed chair seals exactly one output (its deterministic code returns one blob).
      const output_specs = [{ domain_type, core_type: core, primitive }];
      return { chair, phaseName, skill_dir: dir, primitive, domain_type, output_specs, inputs, skills: [], missing_skills: [] };
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
          // #244 — when `need` is a DECLARED gig input, the cause is a missing key in the
          // caller's payload, not a mis-wired pipeline. Blaming "upstream outputs" sent the
          // operator to inspect files that are perfectly correct.
          throw standardInputs.has(need)
            ? missingGigInput(need, chair.role, provided)
            : new RuntimeError(
                `chair "${chair.role}" input_contract requires "${need}" but upstream outputs only provide [${provided}]`,
              );
        }
      }
    } else if (agent.input_types.length > 0) {
      // #245 — an EMPTY input_contract used to skip every input check, so a chair bound to an
      // agent that declares it consumes typed inputs could be invoked with `inputs: []`. The
      // agent, given nothing, invents an answer; the answer then seals with full provenance,
      // real predecessor links and `status: "complete"`. Composition cannot catch this: its
      // upstream-producer check gates on `i > 0`, and a hand-rolled Standard bypasses it
      // entirely — so the runtime is the last line of defence.
      //
      // The floor is the weakest one that still bites: AT LEAST ONE declared input_type must be
      // satisfied, by an upstream record or by the typed gig payload (#156). An agent that
      // consumes one of several alternatives is not forced to receive all of them, and an agent
      // declaring no input_types is untouched.
      const satisfied = agent.input_types.some(
        (t) => (standardInputs.has(t) && gigInput[t] !== undefined) || inputs.some((o) => outputSatisfiesType(o, t)),
      );
      // The ENTRY-CHAIR exemption, and its cost. A first-phase chair with no depends_on reads
      // from the gig payload, and a v0 standard may seed it UNTYPED — `patent-triage-v0`'s
      // `cleave` chair binds an agent declaring `invention-spec` and is fed
      // `{description: "…"}`. The runtime cannot tell that legitimate seed apart from a
      // mis-wired entry chair: both are "declared type, nothing upstream, some payload". So the
      // floor only fires for an entry chair when the payload is EMPTY — the one case where
      // nothing could have supplied the declared type by any route. Closing the rest is a
      // DEFINITION fix, not a runtime one: the standard must declare `input_types` so the seed
      // is typed (#156's mechanism, which patent-triage-v0 predates). Recorded, not guessed.
      // #245 read a gig-level `firstPhase` binding that #244 removed along with the
      // phase-0-only pre-flight it served. Re-derived at the use site.
      const entryChair = phaseName === standard.phases[0]?.name && chair.depends_on.length === 0;
      const seeded = entryChair && Object.keys(gigInput).length > 0;
      if (!satisfied && !seeded) {
        const provided = inputs.map((o) => o.domain_type).join(",");
        throw new RuntimeError(
          `chair "${chair.role}" agent "${agent.slug}" declares input_types [${agent.input_types.join(",")}] but received none of them — upstream provided [${provided}] and the gig payload supplies no matching type; refusing to invoke on an empty frontier`,
        );
      }
    }

    // Resolve this agent's skill bindings (slugs) against the genome's skills map.
    // resolveSkills REPORTS; this is where the engine DECIDES — and it decides BEFORE the
    // budget deduction below, so a dangling binding costs nothing.
    const { skills, missing } = resolveSkills(agent.skill_slugs, deps.skills);
    if (missing.length > 0) {
      // #242 — `Chair.required_skills` was validated exactly once, at compose time, as a
      // string-subset check against the agent's own declaration. A chair could declare a
      // skill REQUIRED, pass composition because the agent lists the same string, and then
      // run unskilled while sealing normally: the standard's strongest available assertion
      // about a chair's competence was enforced by nobody. There is no graceful-degradation
      // tension here — "required" means required.
      const requiredMissing = missing.filter((s) => (chair.required_skills ?? []).includes(s));
      if (requiredMissing.length > 0) {
        throw new RuntimeError(
          `phase "${phaseName}" chair "${chair.role}" requires skill(s) [${requiredMissing.join(", ")}] which resolve to no skill package — ` +
            `agent "${agent.slug}" declares the slug but nothing supplies it (a required skill with no package is a dead name; ` +
            `define the skill package or drop it from the chair's required_skills)`,
        );
      }
      // #241 — not required, so the gig lives. But it is never silent again: an unskilled run
      // used to be indistinguishable from a skilled one in the artifact, the ledger AND the diff.
      emit({ type: "skills_unresolved", phase: phaseName, role: chair.role, agent: agent.slug, missing: [...missing] });
    }

    // BUDGET GATE — pre-invocation, and a RESERVATION only (#232). Synchronous so
    // BudgetExhausted (and a TypeError thrown from JSON.stringify on a circular gig_input)
    // propagate unwrapped to the caller rather than being aggregated as a chair failure.
    //
    // The gate compares against `balance - reserved` so a batch of parallel chairs cannot each
    // spend the same balance; the hold converts to `spent` only in settleChairCost, after the
    // invoker actually returns. Before this, `spent += cost` happened HERE — so when a later
    // member of an eagerly-prepared batch tripped the gate, every earlier member was already
    // charged and `invokeAndWriteChair` then ran for nobody. The operator saw spend for work
    // that never started, and that inflated figure is what BudgetExhausted.state reported.
    let reservedCost: number | undefined;
    if (budget) {
      const cost = computeAppendCost({ agent, phase: phaseName, inputs, gig_input: gigInput }, budget.base_cost, budget.k);
      const available = budget.balance - reserved;
      if (available < cost) {
        budget.agent_state = "depleted";
        budget.depleted_agent = agent.slug;
        budget.depleted_at = new Date().toISOString();
        throw new BudgetExhausted(agent.slug, available, cost, budget);
      }
      reserved += cost;
      reservedCost = cost;
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
    return { chair, phaseName, agent, primitive, domain_type, output_specs, inputs, skills, missing_skills: missing, ...(reservedCost !== undefined ? { cost: reservedCost } : {}) };
  }

  // #232 — convert a chair's reservation into settled spend, or release it. `spent` moves ONLY
  // for a chair whose invocation actually returned, which is what the budget contract always
  // claimed. A chair that was prepared and then never invoked (its batch sibling tripped the
  // gate) never reaches here at all — so it is never charged, which is the point.
  function settleChairCost(p: PreparedChair, succeeded: boolean): void {
    if (!budget || p.cost === undefined) return;
    reserved -= p.cost;
    if (!succeeded) return;
    budget.spent += p.cost;
    budget.balance = budget.opening - budget.spent + budget.credit;
  }

  // Stage 2 — actual invocation + post-invocation output_contract check + write.
  // Errors here ARE aggregated by Promise.allSettled and surfaced as a phase-
  // level RuntimeError naming every failing chair role.
  //
  // The thin wrapper is where a chair's budget RESERVATION settles (#232): a hold becomes
  // `spent` on success and is released on failure. Both paths must run, so the accounting
  // cannot drift no matter how the chair ends.
  async function invokeAndWriteChair(p: PreparedChair): Promise<OutputRecord[]> {
    try {
      const written = await executeChair(p);
      settleChairCost(p, true);
      return written;
    } catch (e) {
      settleChairCost(p, false);
      throw e;
    }
  }

  async function executeChair(p: PreparedChair): Promise<OutputRecord[]> {
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
      // #235 — count the invocation BEFORE it runs. An invocation that dies without emitting a
      // usable `result` (the 10-minute SIGKILL bound) still happened and still cost money; the
      // honest record is "started, unattributed", not silence.
      const sink = makeUsageSink();
      startedInvocations++;
      try {
        data = await deps.invoke({
          agent, phase: phaseName, inputs, gig_input: gigInput, skills,
          missing_skills: p.missing_skills, // #241 — what did NOT resolve, so the prompt can't assert it
          output_types: output_specs.map((s) => s.domain_type), // #174 — the chair's promised subset
          onEvent: (ev) => { sink.fold(ev); emit({ type: "agent_event", phase: phaseName, role: chair.role, event: ev }); },
        });
      } finally {
        if (sink.attributed()) attributedInvocations++;
      }
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
    // A real content hash is 64 hex (optionally `sha256:`-prefixed). A `*_sha` field holding
    // anything else is a fabrication — the model can't hash its inputs, so it emits SOME sentinel,
    // and the exact wording varies run to run ("sha256:PLACEHOLDER-…", "UNSEALED:no-hash-tool-…").
    // Trigger on "not a real hash" rather than matching a known sentinel, so the backfill is robust
    // to whatever the model invents (a hardcoded-sentinel match silently no-ops on new wording).
    //
    // #240 — the resolution rule used to be "shares ANY name token, first hit wins", iterated in
    // `depends_on` order. With inputs `grant-draft` and `draft-review`, the field `draft_sha`
    // matched whichever the chair happened to name first, so a COSMETIC REORDER of a JSON array
    // silently rewrote the audit trail. The mis-attributed value is a real 64-hex content_sha of
    // a real output in the same gig: it passes REAL_SHA, passes schema validation, and looks
    // authentic to output_trace. There is no signal of any kind. That is worse than the
    // admitted fabrication it replaced — a visibly fake `sha256:PLACEHOLDER-…` at least says
    // "unknown"; this says "known" and is wrong. In a system whose value IS a byte-reproducible
    // provenance chain, the engine must not guess. It now resolves only what it can PROVE:
    // an exact type-slug match, or a single token-overlap candidate. Anything else aborts.
    const REAL_SHA = /^(sha256:)?[0-9a-f]{64}$/i;
    const norm = (s: string): string => s.replace(/[_-]+/g, "-").toLowerCase();
    // A type consumed twice with DIFFERENT content is ambiguous for the same reason a token
    // collision is — the old dedup silently kept the first, which is another first-hit-wins guess.
    const shasByType = new Map<string, Set<string>>();
    for (const inp of inputs) {
      const set = shasByType.get(inp.domain_type) ?? new Set<string>();
      set.add(inp.content_sha);
      shasByType.set(inp.domain_type, set);
    }
    // Hash the gig input lazily — only when a placeholder actually resolves to it (most outputs have
    // no *_sha fields, and a hostile/circular gig input shouldn't be canonicalized unless needed).
    let gigInputShaCache: string | undefined;
    const gigInputSha = (): string => (gigInputShaCache ??= sha256Hex(canonJson(gigInput)));
    type ShaResolution = { sha: string } | { ambiguous: string[] } | undefined;
    const resolveSha = (field: string): ShaResolution => {
      const bare = field.replace(/_sha$/i, "");
      const only = (type: string): ShaResolution => {
        const set = shasByType.get(type)!;
        // same type consumed twice with different bytes — which predecessor is meant is unknowable
        if (set.size > 1) return { ambiguous: [`${type} (×${set.size} distinct)`] };
        return { sha: [...set][0]! };
      };
      // 1. EXACT type-slug match — `grant_draft_sha` ↔ `grant-draft`. Unambiguous by construction,
      //    and it beats a partial token collision (`draft-review` also contains `draft`).
      for (const type of shasByType.keys()) if (norm(type) === norm(bare)) return only(type);
      // 2. Token overlap — accepted ONLY when exactly one consumed type matches.
      const tokens = bare.split(/[_-]/).filter(Boolean).map((t) => t.toLowerCase());
      const candidates: string[] = [];
      for (const type of shasByType.keys()) {
        const ttok = type.split(/[-_]/).map((t) => t.toLowerCase());
        if (tokens.some((t) => ttok.includes(t))) candidates.push(type);
      }
      if (candidates.length === 1) return only(candidates[0]!);
      // Sorted, not depends_on-ordered: the whole point of #240 is that nothing an operator
      // sees may depend on the order of a JSON array — including the diagnostic.
      if (candidates.length > 1) return { ambiguous: candidates.sort() };
      // 3. The gig payload — a disclosure/input field refers to the seed, not a predecessor.
      if (tokens.includes("disclosure") || tokens.includes("input")) return { sha: gigInputSha() };
      return undefined;
    };
    // The unresolved case (`?? ""`) is the same defect's benign twin: honest about having no
    // predecessor, but silent about it. It stays "" (a non-hash, so nothing downstream mistakes
    // it for provenance) and is now REPORTED on chair_complete instead of vanishing.
    const unresolvedShaFields: string[] = [];
    const backfillShas = (obj: Record<string, unknown>): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (!/_sha$/i.test(k) || typeof v !== "string" || REAL_SHA.test(v)) continue;
        const r = resolveSha(k);
        if (r && "ambiguous" in r) {
          throw new RuntimeError(
            `chair "${chair.role}" cannot stamp provenance field "${k}": it is ambiguous across the inputs this chair consumed [${r.ambiguous.join(", ")}]. The engine refuses to guess which predecessor it refers to — a wrong content_sha is indistinguishable from a right one. Name the field after exactly one consumed type (e.g. "${r.ambiguous[0]!.split(" ")[0]!.replace(/-/g, "_")}_sha").`,
          );
        }
        obj[k] = r ? r.sha : "";
        if (!r) unresolvedShaFields.push(k);
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
    // #243 — the output_contract is honored as a SELECTOR but not as a FLOOR: the guard above
    // is `written.length === 0`, not `written.length === output_specs.length`. A chair that
    // promised two types and sealed one completes silently. The in-code justification (a keyed
    // type may be conditional, and a downstream input_contract check fails loudly if a consumer
    // actually needed it) holds only WHERE A CONSUMER EXISTS — for a terminal chair, the gate
    // phase that emits the verdict, nothing consumes it and the promise evaporates into
    // `status: "complete"`. Enforcing a blanket floor would be wrong (conditional outputs are
    // intentional and there is no optionality marker on Chair to distinguish them), so this
    // RECORDS the shortfall rather than failing on it. See the report on #243 for why the
    // enforcement half needs a schema decision, not a guard.
    const sealedTypes = new Set(written.map((w) => w.domain_type));
    const missing = output_specs.map((s) => s.domain_type).filter((t) => !sealedTypes.has(t));
    if (missing.length > 0) unfulfilledOutputs.push({ role: chair.role, phase: phaseName, missing });
    emit({
      type: "chair_complete", phase: phaseName, role: chair.role, producer: producer_slug,
      output_types: written.map((w) => w.domain_type), duration_ms: Date.now() - t0,
      promised_output_types: output_specs.map((s) => s.domain_type),
      missing_output_types: missing,
      ...(unresolvedShaFields.length > 0 ? { unresolved_sha_fields: unresolvedShaFields } : {}),
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
  //
  // #246 — nothing validated eval_slugs against the loaded evals map, and scoreEval returned
  // 0.0 both for "this eval ran and its contract did not hold" and for "no eval by that name
  // exists". The two were byte-identical, INCLUDING inside run_fingerprint — so a typo'd slug
  // was baked into the reproducibility key as though a real contract had been evaluated and
  // found wanting. Same defect family as a dangling skill ref: a broken reference silently
  // degrading into a plausible-looking value instead of a named one. The score stays 0.0
  // (callers key off presence, and "can't attest a contract that isn't defined" is fair), but
  // the run now says WHICH slugs were never resolvable, and the fingerprint carries that
  // separately so the two cases cannot collide.
  const eval_scores: Record<string, number> = {};
  const unresolved_evals: string[] = [];
  for (const slug of standard.eval_slugs ?? []) {
    if (!deps.evals?.has(slug)) unresolved_evals.push(slug);
    eval_scores[slug] = scoreEval(slug, produced, deps.evals);
  }

  const run_fingerprint = runFingerprint({
    genome_hash,
    model_version: deps.model_version ?? "unknown",
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores,
    output_hashes,
    ...(unresolved_evals.length > 0 ? { unresolved_evals } : {}),
  });

  const settledUsage = finalizeUsage();
  deps.ledger.append({
    kind: "gig",
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: gig_id,
    gig_id,
    standard_slug: standard.slug,
    genome_hash,
    run_fingerprint,
    output_hashes,
    started_at,
    finished_at: new Date().toISOString(),
    // settled model spend (#195) — omitted when nothing was CAPTURED (skill-only gigs, stubbed
    // invokers, or a run whose every invocation reported no usage payload). #235: an absent
    // usage block means "not captured", never "$0.00".
    ...(settledUsage ? { usage: settledUsage } : {}),
  });

  // Cycle complete — when a budget was supplied, mark it `settled` and
  // surface the final state in the manifest. `settled` mirrors the
  // budget-state.json cycle terminal-state semantics for a closed cycle.
  if (budget) {
    budget.agent_state = "settled";
    budget.settled_usd = usage.total_cost_usd; // #233 — final reconciliation of REAL dollars
  }

  const result: GigResult = { gig_id, standard_slug: standard.slug, genome_hash, run_fingerprint, outputs: produced, eval_scores, status: "complete" };
  if (settledUsage) result.usage = settledUsage;
  if (budget) result.budget_state = budget;
  if (unresolved_evals.length > 0) result.unresolved_evals = unresolved_evals;
  if (unfulfilledOutputs.length > 0) result.unfulfilled_outputs = unfulfilledOutputs;
  emit({ type: "gig_complete", outputs: produced.length });
  return result;

  } catch (e) {
    // #236 — real dollars were spent, captured, and then thrown away on every failed gig.
    // `usage` was written only on the success path, and the async dispatcher's `.catch` set
    // status/finished_at/error and never state.usage — so a gig that burned $6 across four
    // chairs and died on the fifth reported zero dollars, everywhere, while the OUTPUTS from
    // the completed chairs persisted. The artifact survived; the record of what it cost did
    // not. Attaching the partial accounting to the error is what lets gig_monitor and a
    // synchronous caller report it. This does NOT write a ledger row — absence-of-row remains
    // the honest "un-sealed gig" signal (recorder_durability_mid_crash.spec.ts).
    if (e && typeof e === "object") {
      const partial = finalizeUsage();
      if (partial) (e as Record<string, unknown>)["usage"] = partial;
      if (budget) (e as Record<string, unknown>)["budget_state"] = budget;
    }
    throw e;
  }
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
