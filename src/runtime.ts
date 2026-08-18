// §13/runtime — the gig executor. Walks a standard's phases, invokes each agent
// (via an INJECTED invoker so the orchestration is testable without spawning Claude),
// writes each typed output to the store (validated), links provenance (derived_from),
// and records one ledger entry with a deterministic genome_hash + a run_fingerprint
// that carries model_version + (empty, v0) eval_scores — honestly un-tempered.
import { randomUUID } from "node:crypto";
import type { Standard, Agent, Chair } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE, CORE_TYPES } from "./core_types.js";
import { executeSkillAsync } from "./skill_subprocess.js";
import { loadSkillPackage } from "./skills.js";
import { resolveModel } from "./claude_invoker.js";
import { resolveAgentGrants, type ToolProviderRegistry } from "./tool_providers.js";
import { resolveAndRealize, type Realization, type RealizationOk } from "./venue_realize.js";
import type { VenueRealizer, RealizationHandle, CredentialResolver } from "./venue_realizer.js";
import type { Venue } from "./chart.js";

// core type → the process primitive that produces it (reverse of PRIMITIVE_OUTPUT_TYPE).
// A skill-backed chair seals its output as this primitive/core when its output_contract is
// a core type.
//
// EXPORTED because `primitive` is folded into `content_sha`. Anything that has to re-derive
// what a chair WOULD have sealed — the drain reconstruction in src/worker.ts — has to arrive
// at the same primitive this seal boundary does, and a second copy of the mapping is exactly
// the drift that makes two gates on one concern answer differently.
export const CORE_TO_PRIMITIVE: Record<string, Agent["primitives"][number]> = Object.fromEntries(
  Object.entries(PRIMITIVE_OUTPUT_TYPE).map(([prim, core]) => [String(core), prim as Agent["primitives"][number]]),
);
import { sha256Hex, canonJson, canonStructuralJson, runFingerprint, outputContentHash, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import { producersSha,
  reuseCacheKey, checkReuseEntry, runIdentityMismatch, checkpointRoleKey,
  CHECKPOINT_SCHEMA_VERSION, REUSE_SCHEMA_VERSION,
  type CheckpointStore, type CheckpointRole, type GigCheckpoint,
  type ReuseStore, type ReuseEntry, type ReuseOutput, type RunIdentity, type PriorBudgetState,
} from "./reuse.js";
import type { OutputStore, OutputRecord } from "./outputs.js";
import { drainGigHeader } from "./output_mirror.js";
import { LEDGER_SCHEMA_VERSION, type Ledger, type GigUsage } from "./ledger.js";
import type { Depth } from "./pricing.js";
import type { SkillRecord, EvalRecord } from "./loader.js";
import { COLTRANE_VERSION } from "./version.js";

// What an agent invocation sees. The invoker returns the output `data` (validated
// downstream against the agent's declared output domain type). `skills` carries
// the SkillRecords the runtime resolved from this agent's skill_slugs against the
// genome's skills map — the Claude invoker uses them to emit the prompt's Skills
// layer (layer 3 of 5). Optional so hand-built ctx literals + callers that don't
// supply a skills map stay valid; buildPrompt treats absent/empty as "no layer".
export interface AgentInvocationContext {
  agent: Agent;
  phase: string;
  // The id of the gig this chair runs under. Threaded so a model chair can seal its output
  // IN-BAND: the invoker tells the agent to call `output_write({ gig_id, phase, agent_slug, … })`,
  // and that gig_id is what ties the chair's write-boundary adjudication to this run. Absent for a
  // legacy hand-rolled ctx (the text-seal path, which never sealed via output_write).
  gig_id?: string | undefined;
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
  // #250 — level 2 of the cancellation chain: the gig's signal, handed to the invocation so
  // the invoker can wire it to whatever it spawns. Without this the chair→child link has
  // nowhere to attach and a live `claude` child can only be stopped by its 10-minute wall
  // clock. Absent = an uncancellable invocation (unchanged legacy behaviour).
  signal?: AbortSignal | undefined;
  // #237 — the depth the GIG was dispatched at. Overrides the agent's static `depth_profile`
  // for this run: `depth` was advertised on gig_dispatch and silently discarded, so the
  // documented "skim first" cost practice had no mechanism behind it. Absent = the agent's
  // own profile stands.
  depth?: Depth | undefined;
  // ── the venue this chair is confined to (venue → dispatch wiring) ──────────────
  // When the gig names a venue, runGig resolves it, calls resolveAndRealize BEFORE this
  // invocation, and threads the resulting room here. The Claude invoker reads BOTH to confine
  // the spawn BY CONSTRUCTION: `--allowedTools` is narrowed to venueEffectiveTools(agent, venue)
  // (the shared oracle the compose-time R10 check uses) and the child env is the realization's
  // deny-by-default allowlist. Absent on both fields = a venue-less dispatch, unnarrowed.
  realization?: Realization | undefined;
  venue?: Venue | undefined;
  // ── the SUBSTRATE the room was realized on (substrate → spawn wiring) ──────────
  // When the gig's venue declares mcp_servers AND a VenueRealizer is supplied on RunDeps, runGig
  // realizes the SUBSTRATE (not just the policy `realization` above) and threads the resulting
  // RealizationHandle.mcpServerConfigs here — an MCP server slug → its realized transport
  // (a `docker exec` stdio config for the containerized realizer). The Claude invoker merges these
  // into the per-chair mcp-config so the spawn reaches the servers running INSIDE the room, not
  // merely the policy layer. Absent = a venue with no declared servers, or no realizer wired: the
  // spawn reaches only the deployment's base + grant-resolved servers, exactly as before.
  substrateMcpConfigs?: Readonly<Record<string, unknown>> | undefined;
  // #turn-budget — the seated chair's turn budget, threaded from the chair (exactly as `depth`
  // is). The invoker resolves `--max-turns` as ctx.turn_budget ?? agent.max_tool_calls ?? engine
  // default. Absent = the agent's own cap stands; 0 is a deliberate hard floor, not a fall-through.
  turn_budget?: number | undefined;
  // #turn-budget — the reserve turns the runtime OFFERED this chair from the gig pool, already
  // capped to min(chair.turn_reserve, pool_remaining) so the invoker cannot over-draw. The invoker
  // resolves its continuation reserve as ctx.turn_reserve ?? opts.turn_reserve. Absent = no chair
  // reserve declared (falls through to the invoker-level default); 0 = declared but the pool was dry.
  turn_reserve?: number | undefined;
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
  // #turn-budget — the operator-facing read of the gig's budget agent_state. Emitted at the single
  // reserve-draw intercept: `yielding` the moment a seated chair crosses into a granted reserve
  // draw, then `active` when it lands or `depleted` when it spends the reserve without landing. This
  // is what makes D1's biconditional observable — a gig is yielding IFF a chair is drawing reserve.
  | { type: "budget_state"; phase: string; role: string; agent_state: BudgetState["agent_state"]; pool_remaining: number }
  // ── reuse (checkpoint/resume + the chair-level cache) ───────────────────────
  // A run that skipped work must SAY which and why, live. A silent saving is
  // indistinguishable from a bug — and from a chair that quietly failed to run.
  | { type: "gig_resumed"; from_gig_id: string; roles: string[]; outputs: number }
  | {
      type: "chair_skipped"; phase: string; role: string;
      /** "resume" — restored from this gig's own checkpoint. "reuse" — a prior gig's output. */
      reason: "resume" | "reuse";
      source_gig_id: string;
      output_types: string[];
      cache_key?: string;
    }
  /** A cache entry was FOUND and refused. A silent refusal is as opaque as a silent hit. */
  | { type: "reuse_rejected"; phase: string; role: string; cache_key: string; reason: string; detail?: string }
  | { type: "gig_complete"; outputs: number }
  /** The gig reached a HUMAN chair without an approval — parked, checkpointed, waiting. */
  | { type: "gig_awaiting_approval"; phase: string; role: string }
  | { type: "gig_failed"; error: string }
  | { type: "gig_aborted"; reason: string };

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
  /**
   * The human seat's verdicts, keyed by chair role. A gig that reaches a human chair WITH
   * its approval here seals it (through the same output gate, schema-validated) and
   * continues; WITHOUT it, the gig parks as awaiting_approval. Supplied on the approving
   * resume — the sketching happens before dispatch; this is the light gate after.
   */
  approvals?: Record<string, Record<string, unknown>> | undefined;
  /** WHO approved — sealed as the approval output's agent_slug. Defaults to "human". */
  approved_by?: string | undefined;
  // Chair-selection policy (the adaptive-router seam). When present, each dispatch
  // iteration narrows the ready frontier to the policy's chosen subset instead of
  // running every ready chair in parallel. Absent = the v0 topological-parallel
  // routing, byte-identical to before this seam existed.
  selectChairs?: ChairSelector | undefined;
  /**
   * #249/#250 — the cancellation seam. Abort it and the run stops at its next checkpoint
   * (between phases and between dispatch batches) and rejects with `GigAborted`. The same
   * signal is threaded into every AgentInvocationContext, so an invoker that wires it to its
   * subprocess also stops the in-flight chair. Absent = an uncancellable run (the v0 shape).
   *
   * Skill chairs are cancellable too (#253). They used to run `spawnSync`, which blocks the
   * event loop, so an abort delivered during one was not even RECEIVED until it returned —
   * a hard uncancellable window of up to the skill's `meta.timeout_ms`, 120s by default.
   * `executeSkillAsync` spawns without blocking and SIGKILLs on the signal.
   */
  signal?: AbortSignal | undefined;
  /**
   * #237 — the depth this gig was dispatched at, threaded to every invocation so it reaches
   * the thing that actually spends. Absent = each agent's own `depth_profile` stands.
   */
  depth?: Depth | undefined;

  // ── the chart: this run is one MOVEMENT of a performance ───────────────────
  /**
   * Set by `runChart` (src/chart.ts) when this gig is a movement of an arrangement. Absent = a
   * plain single-standard run, byte-identical to every run before charts existed.
   */
  chart?: ChartRunContext | undefined;
  /**
   * Sealed records from an EARLIER MOVEMENT, offered to this run's entry chairs.
   *
   * A chart edge is a provenance edge, not a copy: the sink's entry chair consumes the source
   * movement's real `OutputRecord`s, so what it seals carries their `input_refs`/`input_shas` and
   * the chain reaches back across the movement boundary. Passing the DATA through the gig payload
   * instead would satisfy the type check and produce an output whose provenance says it came from
   * nowhere.
   *
   * Deliberately NOT folded into `produced`: a movement's manifest, ledger row and
   * `run_fingerprint` describe the work THAT MOVEMENT did. Seeds are reported separately, in
   * `GigResult.seeded_from`, so a chair consuming records this run did not produce is never silent.
   */
  seed_outputs?: readonly OutputRecord[] | undefined;

  // ── reuse a sealed output instead of re-deriving it ────────────────────────
  /**
   * Durable per-gig checkpoints. When wired, the runtime records each completed chair's sealed
   * outputs (id + content_sha + type fingerprint) after every dispatch batch, so a run that
   * dies at phase 5 can later be resumed instead of restarting from zero.
   *
   * WRITING is automatic; ACTING on it is not. That asymmetry is deliberate and it is the only
   * one that works: a checkpoint you have to opt into BEFORE the failure is a checkpoint you
   * never have. Recording a fact changes no behaviour; `resume_from` is what changes behaviour,
   * and it is explicit.
   *
   * Absent = no checkpoints written, and `resume_from` is refused.
   */
  checkpoints?: CheckpointStore | undefined;
  /**
   * Resume the named gig. The run CONTINUES that gig — same `gig_id` — rather than minting a
   * new one, because the outputs it restores already carry that id and `OutputStore.trace`
   * scopes the provenance walk to a single gig. A fresh id would truncate every restored
   * ancestor out of the chain, which is the opposite of what a resume is for.
   *
   * FAILURE POSTURE: a resume that cannot be honoured THROWS `ResumeRefused` and spends
   * nothing. It never quietly falls back to a cold run. `resume_from` is a claim about a
   * specific prior run; if the claim is false the caller is wrong about the world and needs to
   * be told. And the "harmless" alternative is not harmless: a silent cold run charges the
   * full price and returns a reply indistinguishable from a resume that worked, so the cost
   * surprise is also an UNOBSERVABLE one. Dropping the flag and re-dispatching is one call
   * away; noticing a silent $6 is not.
   */
  resume_from?: string | undefined;
  /**
   * The chair-level reuse cache. Presence IS the opt-in — the runtime never constructs one —
   * and it enables BOTH reads and writes.
   *
   * Writes are gated by the same flag on purpose. This store is cross-gig by construction, so
   * populating it is itself the decision that run A's sealed outputs may stand in for run B's
   * work. That is a decision, not a side effect of having run something. The cost is that the
   * first opted-in run only populates; the second one hits.
   *
   * FAILURE POSTURE, and it differs from resume's: a found-but-unusable entry is REPORTED and
   * the chair does the work. `reuse` names no specific prior run — "no valid entry" is a
   * normal outcome of a lookup, not a falsified premise — so the honest response is a miss,
   * loudly recorded in `GigResult.reuse.rejected`, not a dead run.
   */
  reuse?: ReuseStore | undefined;

  // ── the dispatch-preflight tool-grant guard's environment ──────────────────
  /**
   * The provider registry + mcp server configs the runtime resolves every seated agent's
   * `allowed_tools` against, at t=0 before the first chair is invoked — the IDENTICAL environment
   * `makeClaudeInvoker` spawns each chair into. When BOTH are supplied (bootstrapServerDeps supplies
   * them together, from the same source the invoker holds), runGig runs a preflight that refuses the
   * whole gig if any chair grants a tool with no provider — naming every offending (chair, agent,
   * dead tool). The invoker DOES fail closed on a dead name, but per chair at invoke time, i.e.
   * MID-PHASE, after earlier chairs already ran and spent; a tool absent from the environment must
   * be impossible to START, not merely to FINISH.
   *
   * BOTH absent = the preflight is skipped (bare/test deps), exactly as the invoker's own resolution
   * stays off until a deployment wires it. The invoker's per-chair guard remains the backstop.
   */
  toolProviders?: ToolProviderRegistry | undefined;
  mcpServerConfigs?: Readonly<Record<string, unknown>> | undefined;

  // ── the venue this gig is performed in (venue → dispatch wiring) ────────────
  /**
   * The slug of the venue that confines this gig's chairs. When set, runGig resolves it against
   * `venues` and calls `resolveAndRealize` BEFORE the first chair is invoked; ANY refusal
   * (unknown-venue, credential-breach, ceiling-empty, wildcard-door, install-digest-mismatch,
   * standing-without-cadence) fails the gig closed — nothing is sealed, no chair runs — exactly as
   * an unresolvable tool grant rejects. The resulting room is threaded onto every chair's
   * `AgentInvocationContext.realization`, so the spawn is confined by construction. Absent = a
   * venue-less dispatch, byte-identical to every run before this wire existed.
   */
  venue?: string | undefined;
  /** The venues this gig may name, slug → contract. A slug the map does not hold is a dead name and
   *  fails closed with `unknown-venue`. Absent = an empty map (any named venue is a dead name). */
  venues?: ReadonlyMap<string, Venue> | undefined;
  /** Credential CLASSES detected present in the ambient environment, handed to the realize gauntlet:
   *  any class present but NOT declared by the venue's `credential_surface` is a breach that fails
   *  the gig closed. Absent = none present (deny-by-default: an empty surface admits nothing). */
  credentialsPresent?: string[] | undefined;
  /**
   * The SUBSTRATE seam (substrate → dispatch wiring). When supplied AND the resolved venue declares
   * `mcp_servers`, runGig realizes the substrate (a real room) alongside the policy `realization`:
   * it calls `venueRealizer.realize(venue, credentialResolver, { gigId })`, threads the returned
   * handle's `mcpServerConfigs` onto every chair's `AgentInvocationContext.substrateMcpConfigs` so
   * the spawn reaches the servers running inside the room, and tears the handle down in the same
   * finally block that tears down the policy realization.
   *
   * ABSENT = the substrate is skipped entirely: a venue-named gig still runs the policy gauntlet and
   * confines its chairs by construction, exactly as before this wire existed — the room is opt-in on
   * the deployment supplying an implementation, never mandatory. The engine ships the interface
   * (src/venue_realizer.ts); the deployment supplies `dockerComposeRealizer()`/`localProcessRealizer()`
   * and tests supply the daemon-free substitute (a realizer with an injected `run` seam).
   */
  venueRealizer?: VenueRealizer | undefined;
  /**
   * How the substrate realizer binds credentials into the room. Passed as the required positional
   * `credentialResolver` argument to `venueRealizer.realize()`. Absent → `async () => ({})`, an empty
   * resolver: the interface is satisfied without a new mandatory field, and a class the resolver does
   * not supply reaches the room as an empty secret that fails at the service that reads it — the
   * direction a missing credential should fail. The deployment supplies the real resolver.
   */
  credentialResolver?: CredentialResolver | undefined;
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
  /**
   * #turn-budget — the gig-level reserve POOL, in turns: a shared quantity a budget-exhausted chair
   * draws from, capped per chair by its own `turn_reserve`. This dispatch-payload value is the
   * PRIMARY source and OVERRIDES `Standard.reserve_pool` deterministically when both are present
   * (no max, no sum). Orthogonal to `opening`/`base_cost`/`k` — those are append-units, this is
   * turns, and a draw moves `pool_remaining` only, never `spent`/`balance`. Absent → the standard
   * default, then 0 (no pool). Distinct from 0 only in that 0 could equally be an authored empty
   * pool; either way a chair reaching for a reserve finds nothing and is recorded as starved.
   */
  pool?: number;
}

/**
 * #turn-budget — one attributable draw against the gig reserve pool. `denied` marks a chair that
 * reached for a reserve an empty pool could not give — starvation is a RECORDED state, never a
 * silent no-op. `granted` is 0 on a denied draw; `pool_remaining_after` is the pool level once this
 * draw (or non-draw) settled, so the ledger reads as a monotone draw-down.
 */
export interface ReserveDraw {
  /** The drawing chair's role — the attribution the raw invoker event omits, sourced from context. */
  role: string;
  granted: number;
  pool_remaining_after: number;
  denied?: boolean;
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
  /**
   * #turn-budget — turns remaining in the gig reserve pool (Item 2). Seeded from the dispatch
   * `pool` (else `Standard.reserve_pool`, else 0), drawn down as chairs cross into reserve, never
   * negative and never re-increased in v0 (strict draw-down, no preemption). Orthogonal to the
   * append-unit ledger above: a draw moves ONLY this number.
   */
  pool_remaining: number;
  /**
   * #turn-budget — the attributable draw ledger (Item 2). One record per chair that reached for a
   * reserve, granted or denied, so a post-run reader can see who drew, how much, and what the pool
   * had left — and so a starved chair is visible rather than a silent no-op.
   */
  draws: ReserveDraw[];
}

/** One chair that did not run, and what stood in for it. */
export interface SkippedChair {
  phase: string;
  role: string;
  reason: "resume" | "reuse";
  /** The gig whose sealed output was used. Equal to this gig's id for a resume. */
  source_gig_id: string;
  output_types: string[];
  /** The content_shas served. Identical to what a fresh derivation would have sealed. */
  content_shas: string[];
  /** reuse only — the key that matched, so an operator can reason about WHY it matched. */
  cache_key?: string;
}

export interface GigResumeReport {
  from_gig_id: string;
  /** When the checkpoint this resume read was last written. */
  checkpoint_at: string;
  roles: Array<{ phase: string; role: string; output_types: string[] }>;
  outputs_restored: number;
  /**
   * What the earlier attempt(s) had spent when the checkpoint was written. Deliberately kept
   * OUT of `GigResult.usage`: #235/#236 made `usage` mean "what THIS run actually captured",
   * and widening it to "what the gig cost across attempts" would undo that. Two numbers, both
   * true, reported separately. Absent when the earlier attempt captured no usage.
   */
  prior_usage?: unknown;
}

export interface GigReuseReport {
  /** Chairs served from a prior gig's sealed output. */
  hits: Array<{ phase: string; role: string; cache_key: string; source_gig_id: string; output_types: string[] }>;
  /** Entries that were FOUND and refused. Never a silent miss — a stale entry gets a name. */
  rejected: Array<{ phase: string; role: string; cache_key: string; reason: string; detail?: string }>;
  /** Entries written this run. */
  writes: number;
  /** Entries that could not be written. Not fatal — the run is unaffected — but not silent. */
  write_errors: Array<{ phase: string; role: string; reason: string }>;
}

/**
 * What a run needs to know about being one MOVEMENT of a chart.
 *
 * Small on purpose: the runtime does not orchestrate arrangements (src/chart.ts does). It only
 * needs to stamp the right identity on what it seals, so a movement's ledger row, checkpoint and
 * fingerprint say which performance they belong to.
 */
export interface ChartRunContext {
  chart_slug: string;
  movement_id: string;
  /**
   * The arrangement's identity, folded into `run_fingerprint` in the EXACT slot that held
   * `genome_hash`. For a degenerate chart this value IS `genomeHash(standard)`, so a
   * single-standard gig's fingerprint is byte-identical to what it was before charts existed.
   */
  chart_hash: string;
  /** One movement, no edges, no gates — the single-standard gig. Keeps ids and files unchanged. */
  degenerate: boolean;
  /** The cumulative spend at this movement's boundary, recorded on the checkpoint it writes. */
  prior_budget_state?: PriorBudgetState | undefined;
}

export interface GigResult {
  gig_id: string;
  standard_slug: string;
  /** Present when this run was a movement of a chart (RunDeps.chart). */
  chart_slug?: string;
  movement_id?: string;
  genome_hash: string;
  run_fingerprint: string;
  /**
   * Records this run CONSUMED but did not produce — an earlier movement's sealed outputs, carried
   * in over a chart edge. Present only when seeds were actually read, so its absence is the claim
   * that every input this run consumed was sealed inside it.
   */
  seeded_from?: ReadonlyArray<{ gig_id: string; output_id: string; domain_type: string; content_sha: string }>;
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
  status: "complete" | "awaiting_approval";
  /** Present iff status is "awaiting_approval": the human chair the run parked at. */
  awaiting?: { phase: string; role: string };
  /** Final budget snapshot. Present only when a budget was supplied. */
  budget_state?: BudgetState;
  /** Settled model spend (#195). Present when ≥1 real model invocation ran this gig. */
  usage?: GigUsage;
  /**
   * Chairs that did not run because a sealed output stood in for them. Present only when
   * something was actually skipped — so its ABSENCE means every chair ran, and its presence
   * is the run stating plainly that part of this manifest was recalled rather than derived.
   */
  skipped?: readonly SkippedChair[];
  /** Present when this run resumed a prior attempt at the same gig. */
  resumed_from?: GigResumeReport;
  /** Present when the reuse cache was wired, whether or not anything hit. */
  reuse?: GigReuseReport;
  /**
   * The checkpoint store was wired and could not be written. The run is unaffected and
   * complete — but it is NOT resumable, and an operator who believes otherwise will find out
   * at the worst possible moment.
   */
  checkpoint_error?: string;
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
 * One dead reference the dispatch preflight caught. Four kinds, ALL knowable at t=0 from the
 * standard alone — no chair need run to see any of them:
 *
 *   tool-grant        — a seated agent grants a tool the execution environment cannot provide
 *                       (a dead name). Carries the unresolvable `tools`. GATED on a wired provider
 *                       environment (resolution stays off until a deployment supplies it).
 *   missing-skill-dir — a skill-backed chair whose skill_dir is not registered.
 *   unknown-agent     — a chair seats an agent absent from the standard's agents list.
 *   no-primitive      — a seated agent declares no primitives[0].
 *   no-output-type    — a seated agent declares no output_types[0].
 *
 * `detail` is the human-readable line; `phase`/`chair` locate it; `agent`/`tools` are present when
 * the kind carries them. One chair CAN produce two offenders (an agent with neither a primitive nor
 * an output type offends both) — each is its own row.
 */
export interface PreflightOffender {
  readonly kind: "tool-grant" | "missing-skill-dir" | "unknown-agent" | "no-primitive" | "no-output-type";
  readonly phase: string;
  readonly chair: string;
  readonly agent?: string;
  readonly tools?: readonly string[];
  readonly detail: string;
}

/**
 * A dispatch PREFLIGHT refusal: one unified t=0 sweep found one or more dead references — a grant
 * with no provider, a skill-backed chair with no skill_dir, a chair seating an unknown agent, or a
 * seated agent with no primitive / no output type. Thrown at t=0, BEFORE the first chair is invoked,
 * so a doomed gig spends ZERO model tokens — the per-chair guards (invoker grant resolution;
 * prepareChair's own throws) do not fire until that chair is prepared MID-PHASE, after earlier
 * chairs already ran and spent.
 *
 * Distinct error kind (like ResumeRefused) — it is the engine declining to start a gig it can see
 * will fail, not a crash. `offenders` names EVERY defect across every phase, not just the first, so
 * one refusal lists everything to fix rather than surfacing them one re-dispatch at a time.
 */
export class PreflightDispatchError extends Error {
  public readonly offenders: ReadonlyArray<PreflightOffender>;
  constructor(offenders: ReadonlyArray<PreflightOffender>) {
    const detail = offenders
      .map((o) => {
        const who = o.agent !== undefined ? ` (agent "${o.agent}")` : "";
        return `[${o.kind}] phase "${o.phase}" chair "${o.chair}"${who}: ${o.detail}`;
      })
      .join("; ");
    super(
      `PreflightDispatchRefused: dispatch refused before any chair ran — ${detail}. ` +
        `A tool granted in the work but absent from the execution environment has no provider (a dead name); ` +
        `register a provider or remove the grant.`,
    );
    this.name = "PreflightDispatchError";
    this.offenders = offenders;
  }
}

/**
 * A resume was requested and cannot be honoured. Thrown BEFORE any chair is prepared, so a
 * refused resume costs nothing.
 *
 * Distinct from RuntimeError because it is not a crash and not a composition defect — it is
 * the engine declining to splice two runs together. `drift` names exactly which identity
 * fields disagree, so "it refused" is never the whole answer an operator gets.
 */
export class ResumeRefused extends Error {
  public readonly gig_id: string;
  public readonly drift: readonly string[];
  constructor(gig_id: string, why: string, drift: readonly string[] = []) {
    super(
      `ResumeRefused: cannot resume gig "${gig_id}" — ${why}` +
        (drift.length > 0 ? ` [${drift.join("; ")}]` : "") +
        `. Re-dispatch without resume_from to run this cold.`,
    );
    this.name = "ResumeRefused";
    this.gig_id = gig_id;
    this.drift = drift;
  }
}

/**
 * Raised when a gig is cancelled through `RunDeps.signal` (#249). Distinct from RuntimeError
 * so a caller can tell "an operator stopped this" from "this crashed" — #251's point that a
 * killed gig surfacing as `failed` with a kill-shaped error is indistinguishable from a
 * genuine crash.
 *
 * Carries the spend accrued BEFORE the cancellation. Today abort does nothing, so the gig
 * completes and its cost IS recorded; a fix that kills children without capturing accrued
 * usage would improve cost control while regressing accounting. The dispatcher folds this
 * onto the run state so `gig_monitor` still answers "what did this cost me".
 */
export class GigAborted extends Error {
  public readonly gig_id: string;
  public readonly reason: string;
  public readonly usage: GigUsage | undefined;
  public readonly outputs: readonly OutputRecord[];
  constructor(gig_id: string, reason: string, usage: GigUsage | undefined, outputs: readonly OutputRecord[]) {
    super(`GigAborted: gig "${gig_id}" was aborted — ${reason}`);
    this.name = "GigAborted";
    this.gig_id = gig_id;
    this.reason = reason;
    this.usage = usage;
    this.outputs = outputs;
  }
}

/** The human-readable cause behind an AbortSignal, whatever shape the aborter used. */
export function abortReasonText(signal: AbortSignal): string {
  const r = signal.reason as unknown;
  if (typeof r === "string" && r.trim().length > 0) return r;
  if (r instanceof Error && r.message) return r.message;
  return "cancelled";
}

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
 * Resolve an agent's skills: the ones it CARRIES on its record, unioned with the repertoire
 * packages its `skill_slugs` name. REPORTS, never decides: it returns both what resolved and what
 * did not, and `prepareChair` decides what a miss means (fatal when the chair declared the skill
 * REQUIRED, reported otherwise).
 *
 * CARRIED-FIRST, and carried wins the slug. An agent's own definition needs no genome lookup (it
 * travels with the player into any institution), and where both a carried definition and a
 * repertoire package answer to one slug the carried one SHADOWS it — the player's own technique is
 * the one that plays, and the same slug never resolves to two skills in one prompt. A slug covered
 * by a carried definition is therefore not missing.
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
  carried?: readonly SkillRecord[] | undefined,
): { skills: readonly SkillRecord[]; missing: readonly string[] } {
  const skills: SkillRecord[] = [...(carried ?? [])];
  const carriedSlugs = new Set(skills.map((s) => s.slug));
  if (!slugs || slugs.length === 0 || !map) return { skills, missing: [] };
  const missing: string[] = [];
  for (const slug of slugs) {
    if (carriedSlugs.has(slug)) continue; // the carried definition already answered this slug
    const rec = map.get(slug);
    if (rec) skills.push(rec);
    else missing.push(slug);
  }
  return { skills, missing };
}

/**
 * The structural identity of a pipeline: the standard's phase graph plus each bound agent's
 * type surface. Deterministic across machines for a given structure.
 *
 * EXPORTED because it is the one identity a DRAINED gig carries. The sink's gig header records
 * `genome_hash` and nothing else about the run's producers, so a worker reconstructing a resume
 * from the sink (src/worker.ts) has to be able to ask "is the standard I just loaded the one
 * those outputs were sealed under" — and it must ask with this function, not a lookalike.
 */
export function genomeHash(standard: Standard): string {
  const agents = [...standard.agents]
    .map((a) => ({
      slug: a.slug,
      primitives: a.primitives,
      input_types: a.input_types,
      output_types: a.output_types,
      domain: a.domain,
    }))
    .sort((x, y) => (x.slug < y.slug ? -1 : 1));
  // canonStructuralJson, not canonJson: a field whose value states NOTHING (an empty array, an
  // absent optional, a null domain) must not be able to move a STRUCTURAL hash. 0.6.6 added two
  // `.default([])` chair fields, no standard's structure changed, and genome_hash moved for the
  // entire genome — re-keying the ledger and refusing resumes for a drift that did not exist.
  // Reaching this canonicalization moved the hash ONE final time; after it, a new schema default
  // is hash-neutral. Pinned by tests/genome_hash_stability.test.ts, which states the bump loudly.
  return sha256Hex(
    canonStructuralJson({ standard: { slug: standard.slug, domain: standard.domain, phases: standard.phases }, agents }),
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
/** EXPORTED because the chart layer asks the same question at the movement boundary — which of a
 *  source movement's sealed records does an edge of type T carry — and two layers answering "does
 *  this record satisfy this declared type" differently is the #263 defect wearing a new hat. */
export function outputSatisfiesType(output: OutputRecord, declared: string): boolean {
  if (output.domain_type === declared) return true;
  if (CORE_TYPE_SET.has(declared) && output.core_type === declared) return true;
  return false;
}

export async function runGig(
  standard: Standard,
  gigInput: Record<string, unknown>,
  deps: RunDeps,
): Promise<GigResult> {
  // A resumed run CONTINUES the gig it resumes: same id, so the restored outputs stay in-gig
  // and `OutputStore.trace` (which scopes its walk to one gig_id) still reaches them. Two ids
  // for one gig would make the provenance chain end at the resume boundary.
  if (deps.resume_from !== undefined && deps.gig_id !== undefined && deps.gig_id !== deps.resume_from) {
    throw new ResumeRefused(
      deps.resume_from,
      `the caller supplied a different gig_id ("${deps.gig_id}") — a resumed run continues the gig it resumes, it does not fork one`,
    );
  }
  const gig_id = deps.resume_from ?? deps.gig_id ?? randomUUID();
  const started_at = new Date().toISOString();
  const produced: OutputRecord[] = [];

  // Hoisted: `genome_hash` used to be computed at the very end, purely for the ledger row.
  // Both halves of reuse need it at t=0 — it is the field that decides whether two runs are
  // the same pipeline, and a gate that fires after the money is spent is not a gate.
  const genome_hash = genomeHash(standard);

  // ── VENUE → DISPATCH WIRE ──────────────────────────────────────────────────────────────────
  // When the gig names a venue, resolve + realize it ONCE, BEFORE any chair is invoked. The room is
  // an ENFORCED performance space: `resolveAndRealize` runs the ordered gauntlet (dead name, wildcard
  // door, standing-without-cadence, install-digest, credential-breach, per-seat ceiling) and returns
  // a fail-closed refusal on the first breach. A refusal ABORTS the gig here — no chair spawns,
  // nothing is sealed, no ledger row is written — exactly as an unresolvable tool grant rejects.
  // The successful room is threaded onto every chair's ctx (below) so the spawn is confined by
  // construction, and torn down at each chair's lifecycle end.
  let gigRealization: RealizationOk | undefined;
  let gigVenue: Venue | undefined;
  // The SUBSTRATE half of the wire. The policy realization above CONFINES a venue-named gig — it
  // intersects the tool ceiling and refuses a breach — but stands up no room. Without this the
  // container substrate (src/venue_realizer.ts) was unreachable from dispatch: a venue-named gig got
  // NO ROOM, only paper confinement. When the resolved venue declares mcp_servers AND a realizer is
  // wired, the substrate is realized here, ONCE, before any chair — and torn down beside the policy
  // layer in the finally block below.
  let gigSubstrate: RealizationHandle | undefined;
  if (deps.venue !== undefined) {
    const realization = resolveAndRealize(deps.venue, {
      venues: new Map(deps.venues ?? []),
      seats: standard.agents.map((agent) => ({ agent })),
      ambientEnv: {},
      ...(deps.credentialsPresent ? { credentialsPresent: deps.credentialsPresent } : {}),
      gigId: gig_id,
    });
    if (!realization.ok) {
      throw new RuntimeError(
        `venue "${deps.venue}" refused this gig fail-closed: ${realization.refusal.code} — ${realization.refusal.detail}`,
      );
    }
    gigRealization = realization;
    // realize() only returns ok once the slug resolved, so the venue is present in the map.
    gigVenue = deps.venues?.get(deps.venue);

    // Realize the SUBSTRATE only when the venue actually declares servers AND a realizer is supplied.
    // A venue with no mcp_servers has nothing to stand up (the empty room stays free), and an absent
    // realizer is the opt-out that keeps every pre-wire caller byte-identical. credentialResolver
    // defaults to an empty async resolver — realize() takes it as a required positional, so undefined
    // would throw at credential-resolution time; the empty default satisfies the interface without a
    // new mandatory field. A bring-up failure propagates like a policy refusal: no chair spawns.
    if (deps.venueRealizer && gigVenue && gigVenue.mcp_servers.length > 0) {
      gigSubstrate = await deps.venueRealizer.realize(
        gigVenue,
        deps.credentialResolver ?? (async () => ({})),
        { gigId: gig_id },
      );
    }
  }

  // Hash the gig input LAZILY. Three callers want it now (#196's provenance backfill, the
  // resume identity, and the reuse key) but a hostile or circular payload must not be
  // canonicalized on a run that never needs it — which is every run that uses none of the
  // three. Memoized, so it is computed at most once.
  let gigInputShaCache: string | undefined;
  const gigInputSha = (): string => (gigInputShaCache ??= sha256Hex(canonJson(gigInput)));

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

  // Sealed records an earlier MOVEMENT handed to this one over a chart edge (RunDeps.seed_outputs).
  // They are inputs, not products: available to entry chairs, never folded into `produced`.
  const seedRecords: readonly OutputRecord[] = deps.seed_outputs ?? [];
  const seedsConsumed = new Map<string, OutputRecord>(); // output_id → record, for the manifest

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
      if (ch.human === true && (ch.agent_slug ?? "") === "") {
        sealedByRole.set(ch.role, [ch.output_contract[0] ?? "Judgment"]);
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
          // A chart edge satisfies a declared gig input with a SEALED RECORD rather than a payload
          // key. Without this the pre-flight would refuse a correctly-arranged movement at t=0.
          if (seedRecords.some((s) => outputSatisfiesType(s, need))) continue;
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

  // #249/#250 — the cancellation checkpoint. Level 1 of the abort chain: cheap, deterministic,
  // and where MOST of the post-abort spend was going. A standard with P sequential phases could
  // burn P x DEFAULT_CHAIR_TIMEOUT_MS after gig_abort returned, because nothing between phases
  // (or between dispatch batches) ever asked whether it should still be running.
  const checkpoint = (): void => {
    if (!deps.signal?.aborted) return;
    const reason = abortReasonText(deps.signal);
    emit({ type: "gig_aborted", reason });
    // NOTE (integration): #251 reads the gig-wide `sawUsage` boolean that #235 removed in
    // favour of per-chair attribution. finalizeUsage() is its exact replacement — undefined
    // when nothing was genuinely captured — and it additionally stamps the coverage counters,
    // so an aborted gig reports "N started, M unattributed" rather than a bare total. It is
    // idempotent, which is what makes it safe on this path. No merge conflict; tsc caught it.
    throw new GigAborted(gig_id, reason, finalizeUsage(), produced);
  };

  // Budget state. When deps.budget is undefined, enforcement is OFF (back-compat).
  // When present, we track an in-memory BudgetState mirroring budget-state.json.
  // #turn-budget — the gig reserve pool opens from the dispatch payload FIRST, then the standard's
  // default, then 0. `??` (not max/sum) so the dispatch declaration wins deterministically when both
  // are present and absent stays distinct from a declared 0.
  const poolOpening = deps.budget?.pool ?? standard.reserve_pool ?? 0;
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
        pool_remaining: poolOpening,
        draws: [],
      }
    : null;
  // #turn-budget — reserve turns HELD by prepared-but-not-yet-settled chairs, the pool's mirror of
  // the append-unit `reserved` above. `prepareChair` runs synchronously for the whole ready batch
  // before any invoke, so an offer computed against `pool_remaining - poolReserved` cannot let two
  // parallel chairs over-lend the same turns. A grant converts the hold to a real draw-down; a
  // no-draw or denial releases it. Conservation therefore holds for every ordering, not by luck.
  let poolReserved = 0;
  // #232 — cost RESERVED by chairs that passed the gate but have not settled. `prepareChair`
  // runs eagerly for the whole ready batch, so the gate must see its batch siblings' holds;
  // but a hold is not spend. It converts to `spent` only when the invocation succeeds, and is
  // released (never charged) when it fails or when a later sibling trips the gate and the
  // batch is abandoned before a single invoker is called.
  let reserved = 0;

  // Resolve agent-by-slug once.
  const agentBySlug = new Map(standard.agents.map((a) => [a.slug, a]));

  // ── dispatch preflight: the UNIFIED t=0 dead-reference sweep ────────────────
  // Four defect classes are ALL knowable at t=0 from the standard alone, yet three of them were, until
  // this sweep, discovered only MID-PHASE in prepareChair — after earlier chairs already ran and spent.
  // Fold all four into ONE pass over every chair in every phase: collect every offender, throw once.
  //
  //   tool-grant        — a seated agent grants a tool with no provider (a dead name). GATED on a wired
  //                       provider environment (toolProviders + mcpServerConfigs, both present —
  //                       bootstrapServerDeps supplies them together), resolved through the same
  //                       `resolveAgentGrants` the spawn path uses, so preflight and chair resolve
  //                       against the identical environment, browser cage included. BOTH absent →
  //                       this sub-check is skipped (bare/test deps), exactly as the invoker's own
  //                       resolution stays off until a deployment wires it.
  //   missing-skill-dir — a skill-backed chair whose skill_dir is not registered (mirrors :1648).
  //   unknown-agent     — a chair seats an agent absent from the agents list (mirrors :1701).
  //   no-primitive /    — a seated agent with no primitives[0] / no output_types[0] (mirrors :1703/:1705);
  //   no-output-type      one agent can offend both, and both are reported.
  //
  // Classes 2/3/4 need NO providers — they run UNCONDITIONALLY. The mid-phase throws stay in place as
  // unreachable backstops. This refuses the whole gig, naming every offender across every phase.
  {
    const providersWired = deps.toolProviders !== undefined && deps.mcpServerConfigs !== undefined;
    const offenders: PreflightOffender[] = [];
    for (const ph of standard.phases) {
      for (const ch of ph.chairs) {
        // A skill-backed chair (skill_slug set, no agent_slug) seats no agent → its dead reference is
        // a missing skill_dir, not a tool grant. Mirror prepareChair's exact condition.
        if (ch.skill_slug && (ch.agent_slug ?? "") === "") {
          if (deps.skill_dirs?.get(ch.skill_slug) === undefined) {
            offenders.push({
              kind: "missing-skill-dir", phase: ph.name, chair: ch.role,
              detail: `is skill-backed ("${ch.skill_slug}") but no skill_dir is registered`,
            });
          }
          continue;
        }
        // A human/approval chair (no agent_slug, not skill-backed) seats no agent → nothing to check.
        const agentSlug = ch.agent_slug ?? "";
        if (agentSlug === "") continue;
        const ag = agentBySlug.get(agentSlug);
        if (!ag) {
          offenders.push({
            kind: "unknown-agent", phase: ph.name, chair: ch.role, agent: agentSlug,
            detail: `references unknown agent "${agentSlug}"`,
          });
          continue;
        }
        if (!ag.primitives[0]) {
          offenders.push({
            kind: "no-primitive", phase: ph.name, chair: ch.role, agent: ag.slug,
            detail: `seats agent "${ag.slug}" which declares no primitive`,
          });
        }
        if (!ag.output_types[0]) {
          offenders.push({
            kind: "no-output-type", phase: ph.name, chair: ch.role, agent: ag.slug,
            detail: `seats agent "${ag.slug}" which declares no output_type`,
          });
        }
        if (providersWired && ag.allowed_tools?.length) {
          const resolved = resolveAgentGrants(ag, deps.toolProviders!, deps.mcpServerConfigs!);
          if (resolved.unknown.length > 0) {
            offenders.push({
              kind: "tool-grant", phase: ph.name, chair: ch.role, agent: ag.slug, tools: resolved.unknown,
              detail: `grants unresolvable tool(s) [${resolved.unknown.join(", ")}]`,
            });
          }
        }
      }
    }
    if (offenders.length > 0) throw new PreflightDispatchError(offenders);
  }

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

  // ── reuse a sealed output instead of re-deriving it ────────────────────────────────────
  //
  // Everything a run skipped, and why. Populated by BOTH halves, because from the manifest's
  // point of view they are the same event: a chair that did not run, and the sealed output
  // that stood in for it.
  const skipped: SkippedChair[] = [];
  const reuseReport: GigReuseReport = { hits: [], rejected: [], writes: 0, write_errors: [] };
  let resumedFrom: GigResumeReport | undefined;
  let checkpointError: string | undefined;

  /**
   * What "the same run" means, computed once. See RunIdentity in src/reuse.ts for why each
   * field is here and why `run_fingerprint` is not.
   */
  /**
   * Every resolved skill's verified code_hash, slug-keyed. The code IS the producer for a
   * skill chair, and `meta.version` can stay put across a rewrite — `loadSkillPackage`
   * computes the hash from the bytes, which is what makes this honest.
   */
  const resolvedSkillHashes = (): Array<{ slug: string; code_hash: string }> => {
    const out: Array<{ slug: string; code_hash: string }> = [];
    for (const [slug, dir] of deps.skill_dirs ?? []) {
      try {
        const pkg = loadSkillPackage(dir);
        out.push({ slug, code_hash: pkg.codeHash ?? "" });
      } catch {
        // Unreadable here means unusable at dispatch too; record the absence rather than
        // silently folding nothing, so a skill that vanished moves the identity.
        out.push({ slug, code_hash: "<unreadable>" });
      }
    }
    return out;
  };

  const identity = (): RunIdentity => ({
    standard_slug: standard.slug,
    // A movement's resume gate carries the ARRANGEMENT's identity when it has one: chairs from
    // chart B consuming a movement's sealed outputs from chart A is the same splice as a moved
    // genome, one level up. Byte-identical for a degenerate chart, where chart_hash IS genome_hash.
    genome_hash: deps.chart?.chart_hash ?? genome_hash,
    // #278 review — genome_hash does NOT see an agent's identity/method/constraints/tools,
    // nor a skill's code. Those are the producer, and editing one under a stable slug is the
    // ordinary response to a bad run. Without this the resume gate accepted exactly that.
    producers_sha: producersSha({ agents: standard.agents, skills: resolvedSkillHashes() }),
    gig_input_sha: gigInputSha(),
    model_version: deps.model_version ?? "unknown",
    depth: deps.depth ?? "",
    canonical_form_version: CANONICAL_FORM_VERSION,
  });

  // Roles restored from a checkpoint: they are already sealed, so they never enter a phase's
  // `remaining` map and are never prepared, budgeted or invoked.
  const restoredRoles = new Map<string, { phase: string; records: OutputRecord[] }>();
  // The checkpoint we will WRITE, accumulated as chairs complete. Seeded from the checkpoint we
  // READ, so a second failure does not throw away the first attempt's progress — otherwise a
  // gig that failed twice would be resumable only back to the second attempt's starting point.
  const checkpointRoles = new Map<string, CheckpointRole>();
  let checkpointStartedAt = started_at;

  if (deps.resume_from !== undefined) {
    if (!deps.checkpoints) {
      throw new ResumeRefused(gig_id, "no checkpoint store is wired, so there is nothing to resume from");
    }
    let cp: GigCheckpoint | undefined;
    try {
      cp = deps.checkpoints.read(gig_id);
    } catch (e) {
      throw new ResumeRefused(gig_id, `its checkpoint could not be read — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!cp) throw new ResumeRefused(gig_id, "no checkpoint exists for it (nothing was ever recorded as complete)");
    if (cp.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new ResumeRefused(gig_id, `its checkpoint is schema v${cp.schema_version} and this engine reads v${CHECKPOINT_SCHEMA_VERSION}`);
    }
    // THE GATE. A resume into a moved genome would have chairs from genome B consuming sealed
    // outputs from genome A, and nothing in input_shas / genome_hash / run_fingerprint would
    // record that it happened — the manifest would describe a system that never existed.
    const drift = runIdentityMismatch(cp.identity, identity());
    if (drift.length > 0) {
      // DIAGNOSTIC HONESTY, not a widened resume. The genome genuinely moved, so the refusal
      // stands — but the operator's real fix is "resume from the build that wrote this", and
      // nothing told them which build that was. `engine_version` (stamped by every build since
      // this landed) names it; a checkpoint from before this field says so plainly rather than
      // crash. Lead with the version + the action; the raw before/after hashes still ride in
      // `drift` for a builder who wants them.
      const cur = identity();
      const wroteBy = cp.engine_version
        ? `coltrane ${cp.engine_version}`
        : "an earlier build (engine version unrecorded)";
      const resumeAction = cp.engine_version
        ? `Resume from a ${cp.engine_version} build, or re-dispatch cold`
        : "Resume from the matching build, or re-dispatch cold";
      throw new ResumeRefused(
        gig_id,
        `this checkpoint was written by ${wroteBy} (genome_hash ${cp.identity.genome_hash}); ` +
          `the current build is coltrane ${COLTRANE_VERSION} (genome_hash ${cur.genome_hash}). ${resumeAction}`,
        drift,
      );
    }

    const rolesInStandard = new Set(standard.phases.flatMap((p) => p.chairs.map((c) => c.role)));
    for (const r of cp.roles) {
      // Unreachable past the genome gate (roles live in `standard.phases`, which genomeHash
      // folds) — but "provably impossible" is not a reason to inject silently if it happens.
      if (!rolesInStandard.has(r.role)) {
        throw new ResumeRefused(gig_id, `its checkpoint names role "${r.role}", which this standard does not define`);
      }
      // THE SEAT'S FULL IDENTITY: (chart_slug, movement_id, role). Two movements of one chart may
      // each declare a chair named "reviewer", and restoring one movement's sealed output into the
      // other's seat would be a splice with nothing in the manifest recording it. A legacy row
      // carries no movement_id and defaults to the standard's own slug, so it still restores.
      const seatNow = checkpointRoleKey(deps.chart?.chart_slug ?? standard.slug, deps.chart?.movement_id, r.role);
      const seatThen = checkpointRoleKey(deps.chart?.chart_slug ?? standard.slug, r.movement_id, r.role);
      if (seatNow !== seatThen) {
        throw new ResumeRefused(gig_id, `its checkpoint names seat "${seatThen}" and this run is seat "${seatNow}" — a movement does not restore another movement's chair`);
      }
      const records: OutputRecord[] = [];
      for (let i = 0; i < r.output_ids.length; i++) {
        const id = r.output_ids[i]!;
        const rec = deps.outputs.get(id);
        if (!rec) {
          throw new ResumeRefused(gig_id, `its checkpoint names output "${id}" for role "${r.role}", which the output store no longer holds`);
        }
        if (rec.content_sha !== r.content_shas[i]) {
          throw new ResumeRefused(gig_id, `output "${id}" (role "${r.role}") has a different content_sha than the checkpoint recorded — the store moved under it`);
        }
        // genomeHash folds the standard and its agents; it does NOT fold the domain-type
        // registry. So a type that changed shape between attempts is invisible to the gate
        // above, and its already-sealed records would be injected into a run whose validator
        // no longer agrees with them. Same fingerprint tool the chair-level cache uses.
        const fp = deps.outputs.typeFingerprint(rec.domain_type);
        if (fp === "") {
          throw new ResumeRefused(gig_id, `the registry can no longer describe type "${rec.domain_type}" (role "${r.role}"), so its sealed output cannot be checked`);
        }
        if (fp !== r.type_fingerprints[i]) {
          throw new ResumeRefused(gig_id, `type "${rec.domain_type}" (role "${r.role}") has changed shape since that output was sealed`);
        }
        records.push(rec);
      }
      restoredRoles.set(r.role, { phase: r.phase, records });
      checkpointRoles.set(r.role, r);
    }
    checkpointStartedAt = cp.started_at;
    resumedFrom = {
      from_gig_id: gig_id,
      checkpoint_at: cp.updated_at,
      roles: cp.roles.map((r) => ({ phase: r.phase, role: r.role, output_types: [...r.domain_types] })),
      outputs_restored: [...restoredRoles.values()].reduce((n, v) => n + v.records.length, 0),
      ...(cp.prior_usage !== undefined ? { prior_usage: cp.prior_usage } : {}),
    };
    emit({
      type: "gig_resumed", from_gig_id: gig_id,
      roles: [...restoredRoles.keys()], outputs: resumedFrom.outputs_restored,
    });
  }

  /** Record a completed chair against the checkpoint we will write. */
  function noteCheckpointRole(role: string, phaseName: string, records: readonly OutputRecord[]): void {
    if (!deps.checkpoints || records.length === 0) return;
    checkpointRoles.set(role, {
      role, phase: phaseName,
      // WHICH movement's seat this is. Two movements may both declare a chair named "reviewer";
      // the composite (chart_slug, movement_id, role) is what keeps their checkpoints apart.
      ...(deps.chart ? { movement_id: deps.chart.movement_id } : {}),
      output_ids: records.map((r) => r.id),
      content_shas: records.map((r) => r.content_sha),
      domain_types: records.map((r) => r.domain_type),
      type_fingerprints: records.map((r) => deps.outputs.typeFingerprint(r.domain_type)),
      sealed_at: new Date().toISOString(),
    });
  }

  /**
   * Flush the checkpoint. Called at every dispatch-batch boundary — including BEFORE the throw
   * that a failed batch raises, so a batch whose siblings succeeded still banks them.
   *
   * Swallow-and-report: a checkpoint write that fails must not kill a run that is otherwise
   * fine (the money is already spent), but it must not be invisible either — a caller who
   * believes the run is resumable and is wrong finds out at the worst possible moment.
   */
  function saveCheckpoint(): void {
    if (!deps.checkpoints || checkpointRoles.size === 0) return;
    try {
      const prior = finalizeUsage();
      deps.checkpoints.write({
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        gig_id,
        identity: identity(),
        // The build that wrote this. When a later build's evolved schema drifts the identity,
        // this is what turns the refusal's two raw hashes into "resume from a <version> build".
        engine_version: COLTRANE_VERSION,
        started_at: checkpointStartedAt,
        updated_at: new Date().toISOString(),
        roles: [...checkpointRoles.values()],
        ...(prior ? { prior_usage: JSON.parse(JSON.stringify(prior)) as unknown } : {}),
        // The chart's cumulative spend AT THIS MOVEMENT'S BOUNDARY, so a resumed performance can
        // compare it to the envelope before spawning anything (src/chart.ts, edge case B).
        ...(deps.chart?.prior_budget_state ? { prior_budget_state: deps.chart.prior_budget_state } : {}),
      });
    } catch (e) {
      checkpointError ??= e instanceof Error ? e.message : String(e);
    }
  }

  try {

  for (const phase of standard.phases) {
    checkpoint(); // between phases — the cheapest place to stop, and the biggest saving
    emit({ type: "phase_start", phase: phase.name, roles: phase.chairs.map((c) => c.role) });

    // Per-phase DAG executor. Chairs whose `depends_on` is fully covered by
    // already-produced roles form the next dispatch-batch and run in parallel
    // via Promise.allSettled. Failures from any chair in the batch are joined
    // into a single RuntimeError naming every failing chair role. Cross-phase
    // depends_on works because `producedByRole` carries across phases.
    const remaining = new Map<string, Chair>();
    for (const ch of phase.chairs) {
      // A role restored from this gig's checkpoint never enters the frontier at all: not
      // prepared, not budgeted, not invoked. Seeding `producedByRole` here (rather than before
      // the phase loop) keeps `produced` in phase order, which the legacy no-depends_on input
      // gathering and ChairSelectionView both read.
      const restored = restoredRoles.get(ch.role);
      if (!restored) {
        remaining.set(ch.role, ch);
        continue;
      }
      producedByRole.set(ch.role, restored.records);
      produced.push(...restored.records);
      const row: SkippedChair = {
        phase: phase.name, role: ch.role, reason: "resume", source_gig_id: gig_id,
        output_types: restored.records.map((r) => r.domain_type),
        content_shas: restored.records.map((r) => r.content_sha),
      };
      skipped.push(row);
      emit({
        type: "chair_skipped", phase: phase.name, role: ch.role, reason: "resume",
        source_gig_id: gig_id, output_types: row.output_types,
      });
    }
    if (remaining.size === 0) continue; // wholly restored phase — nothing to dispatch

    while (remaining.size > 0) {
      checkpoint(); // between dispatch batches — stops the NEXT topological level from firing
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

      // ── THE HUMAN SEAT ─────────────────────────────────────────────────────────────
      // A human chair in the frontier is handled before any model dispatch. With its
      // approval supplied (deps.approvals[role]) the incumbent's verdict seals through the
      // SAME output gate as every record — schema-validated, under the approving
      // principal's name, carrying the input_shas of exactly what was approved. Without
      // it, the gig PARKS: checkpointed, honestly drained as awaiting_approval, nothing
      // hollow sealed. The sketching happens before dispatch; this gate is light.
      const humanReady = ready.filter((c) => c.human === true && (c.agent_slug ?? "") === "");
      for (const hc of humanReady) {
        const approval = deps.approvals?.[hc.role];
        if (!approval) {
          checkpoint();
          emit({ type: "gig_awaiting_approval", phase: phase.name, role: hc.role });
          // AWAITED, unlike the fire-and-forget completion drain: parking is the runtime's
          // last act before the caller (often a CLI) exits, and an in-flight fetch dies with
          // the process — which left the sink's row saying "running" about a gig that was
          // waiting on a person. Parking is not latency-critical; the truth is.
          await drainGigHeader({
            gig_id,
            standard_slug: standard.slug,
            status: "awaiting_approval",
            genome_hash,
            started_at,
            finished_at: new Date().toISOString(),
            outputs_count: produced.length,
            error: `awaiting approval at human chair "${hc.role}" (phase "${phase.name}")`,
          }).catch((de) => {
            if (process.env["COLTRANE_DRAIN_DEBUG"]) console.error(`[drain] awaiting header ${gig_id}: ${String(de)}`);
          });
          return {
            gig_id,
            standard_slug: standard.slug,
            ...(deps.chart ? { chart_slug: deps.chart.chart_slug, movement_id: deps.chart.movement_id } : {}),
            genome_hash,
            run_fingerprint: "",
            outputs: produced,
            eval_scores: {},
            status: "awaiting_approval",
            awaiting: { phase: phase.name, role: hc.role },
          };
        }
        remaining.delete(hc.role);
        const domain_type = hc.output_contract[0] ?? "Judgment";
        const core = deps.outputs.coreTypeOf(domain_type) ?? domain_type;
        const primitive = CORE_TO_PRIMITIVE[core] ?? "JUDGE";
        const approvalInputs: OutputRecord[] = hc.depends_on.flatMap((d) => producedByRole.get(d) ?? []);
        const t0 = Date.now();
        emit({ type: "chair_start", phase: phase.name, role: hc.role, producer: deps.approved_by ?? "human" });
        const rec = deps.outputs.write({
          core_type: core,
          domain_type,
          domain: standard.domain,
          gig_id,
          agent_slug: deps.approved_by ?? "human",
          from_role: hc.role,
          phase: phase.name,
          primitive,
          data: approval,
          input_refs: approvalInputs.map((i) => i.id),
          input_shas: approvalInputs.map((i) => i.content_sha),
        });
        for (const i of approvalInputs) deps.outputs.addRef(rec.id, i.id, "derived_from", primitive);
        producedByRole.set(hc.role, [rec]);
        produced.push(rec);
        emit({
          type: "chair_complete", phase: phase.name, role: hc.role, producer: deps.approved_by ?? "human",
          output_types: [domain_type], duration_ms: Date.now() - t0,
        });
      }
      ready = ready.filter((c) => !(c.human === true && (c.agent_slug ?? "") === ""));
      if (ready.length === 0) continue;

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
          noteCheckpointRole(ch.role, phase.name, r.value);
        }
      }
      // #233 — BATCH BOUNDARY is the only point at which real settled dollars can be
      // reconciled into the budget: prepareChair ran for every chair in this batch before any
      // of them was invoked, so no chair could have seen its siblings' cost. Reporting only.
      if (budget) budget.settled_usd = usage.total_cost_usd;

      // Bank progress BEFORE the failure throw below. A batch whose siblings succeeded has
      // durable outputs either way; the checkpoint is what makes them reachable next time,
      // and writing it only on the happy path would forfeit exactly the runs that need it.
      saveCheckpoint();

      if (failures.length > 0) {
        // A cancellation that reached the chair's child (level 3) surfaces here as a rejected
        // chair. Report it as the cancellation it is — not as "chair(s) failed", which is the
        // exact confusion #251 flags: a killed gig indistinguishable from a genuine crash.
        checkpoint();
        throw new RuntimeError(
          `phase "${phase.name}" aborted — chair(s) failed: ${failures.join(", ")} (${failureErrors.join(" | ")})`,
        );
      }

      // Drop completed chairs from remaining so the next iteration picks up
      // chairs unblocked by this batch.
      for (const ch of ready) remaining.delete(ch.role);
    }

    // ── EXAMINE⇄AMEND ─────────────────────────────────────────────────────────────
    // The verify seat's verdict is not the last word when the standard budgets examine
    // rounds. If a VERIFY chair in this phase sealed a FAILING verdict (the one canonical
    // fail signal every Verdict carries: pass === false), re-run the maker(s) it judged —
    // the AMEND, with the failing verdict fed back so the fix targets what actually failed —
    // and re-verify, up to max_examine_rounds, stopping the instant the verdict passes.
    // Rounds spent without a pass leave the last, failing verdict standing: the loop iterates
    // to green, it never launders red into green. depends_on chairs read their inputs from
    // producedByRole, so replacing the maker's record there is what makes the re-verify judge
    // the amended artifact rather than the original.
    const examineRounds = standard.max_examine_rounds ?? 0;
    if (examineRounds > 0) {
      const allChairs = standard.phases.flatMap((p) => p.chairs);
      const phaseNameOf = (role: string): string =>
        standard.phases.find((p) => p.chairs.some((c) => c.role === role))?.name ?? phase.name;
      const primitivesOf = (slug: string | undefined): readonly string[] =>
        standard.agents.find((a) => a.slug === slug)?.primitives ?? [];
      const dropFromProduced = (recs: readonly OutputRecord[]): void => {
        for (const r of recs) {
          const idx = produced.indexOf(r);
          if (idx >= 0) produced.splice(idx, 1);
        }
      };
      const failingVerdict = (role: string): OutputRecord | undefined =>
        (producedByRole.get(role) ?? []).find(
          (r) =>
            (deps.outputs.coreTypeOf(r.domain_type) ?? "") === "Verdict" &&
            (r.data as { pass?: boolean }).pass === false,
        );

      for (const vch of phase.chairs) {
        if (!primitivesOf(vch.agent_slug).includes("VERIFY")) continue;
        let verdict = failingVerdict(vch.role);
        if (!verdict) continue; // no verdict, or it passed — nothing to amend
        // The maker(s) to amend are the dependencies that produced the ARTIFACT this verdict
        // judged — keyed on the chair's Artifact OUTPUT, not the agent's primitive set. A
        // multi-primitive agent (e.g. one seat plans, another writes) must have only its writing
        // seat re-run; the plan is settled for the run and is not amended.
        const producesArtifact = (c: Chair): boolean => {
          const out = c.output_contract[0];
          return !!out && (deps.outputs.coreTypeOf(out) ?? "") === "Artifact";
        };
        const makers = vch.depends_on
          .map((role) => allChairs.find((c) => c.role === role))
          .filter((c): c is Chair => !!c && producesArtifact(c));
        if (makers.length === 0) continue; // nothing to re-run — a verify with no maker to amend

        for (let round = 1; round <= examineRounds && verdict; round++) {
          checkpoint();
          emit({ type: "phase_start", phase: `${phase.name}:amend#${round}`, roles: [...makers.map((m) => m.role), vch.role] });
          const feedback = verdict;
          // AMEND: each maker re-runs with the failing verdict fed in as an extra input, so
          // the seat that built the change fixes the exact thing the verify caught.
          for (const mk of makers) {
            const prep = prepareChair(mk, phaseNameOf(mk.role));
            if (!prep.inputs.includes(feedback)) prep.inputs.push(feedback);
            const recs = await invokeAndWriteChair(prep);
            dropFromProduced(producedByRole.get(mk.role) ?? []);
            producedByRole.set(mk.role, recs);
            produced.push(...recs);
            noteCheckpointRole(mk.role, phaseNameOf(mk.role), recs);
          }
          // RE-VERIFY the amended artifact.
          const vprep = prepareChair(vch, phase.name);
          const vrecs = await invokeAndWriteChair(vprep);
          dropFromProduced(producedByRole.get(vch.role) ?? []);
          producedByRole.set(vch.role, vrecs);
          produced.push(...vrecs);
          noteCheckpointRole(vch.role, phase.name, vrecs);
          if (budget) budget.settled_usd = usage.total_cost_usd;
          saveCheckpoint();
          verdict = failingVerdict(vch.role); // undefined once it passes → loop ends
        }
      }
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
    // #241 — declared skill slugs that resolved to no package. Threaded to the invocation
    // context so the prompt can never name a skill the agent does not actually hold.
    missing_skills: readonly string[];
    /** #232 — append-unit cost RESERVED for this chair at prep. Settled to `spent` only on
     *  success; released without charge otherwise. Absent when no budget is enforced. */
    cost?: number;
    /** #turn-budget — the reserve turns OFFERED this chair, min(chair.turn_reserve, pool available)
     *  at prep. Threaded onto the invocation as ctx.turn_reserve AND held against `poolReserved`
     *  until the chair's draw settles. Absent when the chair declared no `turn_reserve`. */
    reserve_offer?: number;
    /** Who the sealed record names as producer, and under which domain. Resolved at prep so
     *  the reuse key and the seal agree by construction rather than by two parallel derivations. */
    producer_slug: string;
    domain: string;
    /** Set whenever `deps.reuse` is wired — the key this chair's work hashes to, hit or miss.
     *  Kept on a miss too: it is what the post-seal cache WRITE is addressed by. */
    reuse_key?: string;
    /** Set on a HIT. Every record in it has already passed `validateWrite` and re-hashed to
     *  the content_sha the original seal produced, so `executeChair` only has to write. */
    reuse_hit?: { cache_key: string; source_gig_id: string; outputs: readonly ReuseOutput[] };
  }

  // Resolve a chair's declared output types into seal-specs (type → core → primitive).
  function outputSpecsFor(domainTypes: readonly string[], fallbackPrimitive: Agent["primitives"][number]): PreparedChair["output_specs"] {
    return domainTypes.map((dt) => {
      const core = deps.outputs.coreTypeOf(dt) ?? PRIMITIVE_OUTPUT_TYPE[fallbackPrimitive];
      const primitive = (CORE_TO_PRIMITIVE[core] ?? fallbackPrimitive) as Agent["primitives"][number];
      return { domain_type: dt, core_type: core, primitive };
    });
  }

  /**
   * Is there a prior sealed output that stands in for what this chair is about to derive?
   *
   * Runs at PREP time, before the budget gate, because a chair that will not be invoked must
   * not be charged for the context it will not consume. Returns the key on every path — a
   * miss still needs it, since the key is what the post-seal cache write is addressed by.
   *
   * A plain miss (no entry) is silent: nothing was found, there is nothing to say. An entry
   * that was FOUND and refused is always reported, on the event stream and in the manifest —
   * "the cache stopped hitting" must never be something an operator has to guess at.
   */
  function lookupReuse(a: {
    chair: Chair;
    phaseName: string;
    inputs: readonly OutputRecord[];
    output_specs: PreparedChair["output_specs"];
    agent?: Agent | undefined;
    skill_provenance?: unknown;
    skills: readonly SkillRecord[];
    producer_slug: string;
    domain: string;
  }): { key: string; hit?: { cache_key: string; source_gig_id: string; outputs: readonly ReuseOutput[] } } | undefined {
    const store = deps.reuse;
    if (!store) return undefined;
    const key = reuseCacheKey({
      standard_slug: standard.slug,
      // A chart may name one standard TWICE. Keyed on movement_id, the two instances occupy
      // separate namespaces even with byte-identical inputs — isolation by default.
      ...(deps.chart ? { chart_slug: deps.chart.chart_slug, movement_id: deps.chart.movement_id } : {}),
      phase: a.phaseName,
      chair: a.chair,
      agent: a.agent ?? null,
      ...(a.skill_provenance !== undefined ? { skill_provenance: a.skill_provenance } : {}),
      skills: a.skills.map((s) => ({
        slug: s.slug,
        version: Number((s as unknown as { version?: unknown }).version ?? 0),
        code_hash: s.code_hash ?? "",
      })),
      input_shas: a.inputs.map((i) => i.content_sha),
      gig_input_sha: gigInputSha(),
      model_version: deps.model_version ?? "unknown",
      depth: deps.depth ?? "",
      output_types: a.output_specs.map((s) => s.domain_type),
      canonical_form_version: CANONICAL_FORM_VERSION,
    });
    const reject = (reason: string, detail?: string): { key: string } => {
      reuseReport.rejected.push({ phase: a.phaseName, role: a.chair.role, cache_key: key, reason, ...(detail !== undefined ? { detail } : {}) });
      emit({ type: "reuse_rejected", phase: a.phaseName, role: a.chair.role, cache_key: key, reason, ...(detail !== undefined ? { detail } : {}) });
      return { key };
    };

    let entry: ReuseEntry | undefined;
    try {
      entry = store.get(key);
    } catch (e) {
      return reject("unreadable", e instanceof Error ? e.message : String(e));
    }
    if (!entry) return { key }; // a plain miss — free, and the status quo

    const check = checkReuseEntry(entry, (t) => deps.outputs.typeFingerprint(t));
    if (!check.ok) return reject(check.reason ?? "rejected", check.detail);

    // THE AUTHORITATIVE GUARD. Reuse must never become a way to skip a check: #243 made
    // `output_contract` a floor and #263 made `core_type` agree with the registry, and a
    // recalled output owes those invariants exactly as much as a derived one does.
    //
    // Every record is put through `validateWrite` — the SAME gate `write` runs, from the same
    // implementation — and re-hashed under THIS run's resolved core/primitive/domain. Two
    // properties fall out. First, an entry whose bytes no longer satisfy their type is
    // refused rather than injected, whatever made it stale (a genome edit the fingerprint
    // caught, an older engine's looser floor, a hand edit). Second, deciding here — before a
    // single write — is what makes a multi-output chair all-or-nothing: an entry whose second
    // record fails cannot leave its first one durable.
    for (const o of entry.outputs) {
      const spec = a.output_specs.find((s) => s.domain_type === o.domain_type);
      if (!spec) return reject("seal-rejected", `the entry carries "${o.domain_type}", which this chair does not seal`);
      const gate = deps.outputs.validateWrite({ core_type: spec.core_type, domain_type: o.domain_type, data: o.data });
      if (!gate.valid) return reject("seal-rejected", gate.reason);
      // Re-hashing proves the substitution is content-identical to what the original seal
      // produced. It is also what lets a reused run carry the same `run_fingerprint` as the
      // cold run it stands in for — the claim reuse is implicitly making.
      const sha = outputContentHash({
        core_type: spec.core_type,
        domain_type: o.domain_type,
        domain_type_version: 1,
        domain: a.domain,
        primitive: spec.primitive,
        phase: a.phaseName,
        agent_slug: a.producer_slug,
        data: o.data,
      });
      if (sha !== o.content_sha) {
        return reject("content-sha-mismatch", `re-sealing "${o.domain_type}" here yields a different content_sha than the entry recorded`);
      }
    }
    return { key, hit: { cache_key: key, source_gig_id: entry.source_gig_id, outputs: entry.outputs } };
  }

  /**
   * Offer an ENTRY chair the seeds a chart edge carried in.
   *
   * Scoped to a chair with no `depends_on`: a chair that named its upstream roles asked for those
   * specific seats, and a movement's seed is not one of them. Records enter `inputs` — so what the
   * chair seals carries their content_shas — and are recorded as consumed for the manifest.
   */
  function pullSeeds(chair: Chair, inputs: OutputRecord[], wanted: readonly string[]): void {
    if (seedRecords.length === 0 || chair.depends_on.length > 0) return;
    for (const s of seedRecords) {
      if (inputs.includes(s)) continue;
      if (!wanted.some((t) => outputSatisfiesType(s, t))) continue;
      inputs.push(s);
      seedsConsumed.set(s.id, s);
    }
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
      pullSeeds(chair, inputs, chair.input_contract);
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
      // The producer of a skill chair is its CODE, so the key must name the verified code_hash
      // — a skill whose implementation changed under a stable slug is a different producer.
      // Loaded here only when reuse is on, and a load failure degrades to "no key" (a miss)
      // rather than throwing: executeChair raises the real error a moment later, and a
      // prep-time throw would change which layer reports it.
      let skillIdentity: unknown;
      if (deps.reuse) {
        try {
          const pkg = loadSkillPackage(dir);
          skillIdentity = { slug: pkg.meta.slug, version: pkg.meta.version, code_hash: pkg.codeHash ?? "", tier: pkg.meta.permission?.tier ?? 0 };
        } catch { /* no identity → no key → no reuse for this chair */ }
      }
      const skillReuse = skillIdentity === undefined
        ? undefined
        : lookupReuse({ chair, phaseName, inputs, output_specs, skill_provenance: skillIdentity, skills: [], producer_slug: chair.skill_slug!, domain: standard.domain });
      return {
        chair, phaseName, skill_dir: dir, primitive, domain_type, output_specs, inputs,
        skills: [], missing_skills: [],
        producer_slug: chair.skill_slug!, domain: standard.domain,
        ...(skillReuse ? { reuse_key: skillReuse.key } : {}),
        ...(skillReuse?.hit ? { reuse_hit: skillReuse.hit } : {}),
      };
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
      // A chart edge's carriers are offered to the same chair on the same terms as an in-gig
      // upstream record — by type, as records, so provenance survives the movement boundary.
      pullSeeds(chair, inputs, [...chair.input_contract, ...agent.input_types]);
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
      // NOTE (integration): #245 reads a gig-level `firstPhase` binding that #244 removed
      // along with the phase-0-only pre-flight it served. Neither lane is broken alone and
      // git merges both without a conflict, so only tsc catches it. Re-derived at the use site.
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
    const { skills, missing } = resolveSkills(agent.skill_slugs, deps.skills, agent.skills);
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

    // Seal one record per type THIS CHAIR promises (#174): the output_contract is the SELECTOR,
    // not just a check — a chair bound to a multi-output agent seals only the subset it declares,
    // intersected with the agent's real outputs (so a stray contract entry can't conjure a type
    // the agent doesn't produce; the post-invocation check below still reports that mismatch).
    // Empty contract (legacy hand-rolled chair) → fall back to the agent's full output set.
    const wanted = chair.output_contract.length
      ? agent.output_types.filter((t) => chair.output_contract.includes(t))
      : agent.output_types;
    const output_specs = outputSpecsFor(wanted, primitive);
    const domain = agent.domain ?? standard.domain;

    // REUSE LOOKUP — deliberately ABOVE the budget gate. A chair served from cache consumes no
    // context, so charging it (or worse, refusing it for lack of allowance) would be the budget
    // enforcing a cost that is not going to be incurred.
    const lookup = lookupReuse({ chair, phaseName, inputs, output_specs, agent, skills, producer_slug: agent.slug, domain });

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
    if (budget && !lookup?.hit) {
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

    // #turn-budget — RESERVE OFFER. Only a chair that DECLARED a `turn_reserve` reaches for the pool;
    // one that declared none threads no ctx.turn_reserve, so the invoker's own opts-level reserve is
    // undisturbed (the #329 continuation path). When a budget is enforced the offer is capped to what
    // the pool can still lend (min(own reserve, pool_remaining - poolReserved)) and HELD; with no
    // budget there is no pool to cap against, so the declared reserve threads through directly.
    let reserveOffer: number | undefined;
    if (chair.turn_reserve !== undefined && !lookup?.hit) {
      if (budget) {
        const poolAvailable = Math.max(0, budget.pool_remaining - poolReserved);
        reserveOffer = Math.min(chair.turn_reserve, poolAvailable);
        poolReserved += reserveOffer;
      } else {
        reserveOffer = chair.turn_reserve;
      }
    }

    return {
      chair, phaseName, agent, primitive, domain_type, output_specs, inputs, skills,
      missing_skills: missing, producer_slug: agent.slug, domain,
      ...(reservedCost !== undefined ? { cost: reservedCost } : {}),
      ...(reserveOffer !== undefined ? { reserve_offer: reserveOffer } : {}),
      ...(lookup ? { reuse_key: lookup.key } : {}),
      ...(lookup?.hit ? { reuse_hit: lookup.hit } : {}),
    };
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
    // THE ROOM IS NOT TORN DOWN HERE. It used to be, in this chair-level `finally`, described as
    // "idempotent and a no-op when no venue was named". Idempotent yes; a no-op no —
    // `src/venue_realize.ts` sets `torn = true`, and `canReach()` is `!torn && egress.includes(...)`.
    // So the FIRST chair to finish closed the room's egress probe for every chair after it, and a
    // multi-chair phase ran the rest of its seats against a room already reported torn down.
    //
    // It was invisible because nothing in the run path consults `canReach` today, and because the
    // policy realization's teardown costs nothing. Neither excuse survives a realizer that does real
    // work: a container torn down after chair one is gone for chair two.
    //
    // A room's lifetime is the GIG's, not a chair's. Teardown now runs once, at the gig boundary,
    // on both the success and failure paths — see the `finally` on runGig's outer try.
  }

  async function executeChair(p: PreparedChair): Promise<OutputRecord[]> {
    const { chair, phaseName, inputs, skills, output_specs, producer_slug, domain } = p;
    const t0 = Date.now();

    // ── REUSE HIT ────────────────────────────────────────────────────────────────────────
    // Everything that could refuse this was decided at prep, before a byte was written. What
    // is left is a normal seal: the record is written through the SAME `deps.outputs.write`
    // gate a derived one crosses, into THIS gig, with THIS gig's `input_refs`/`input_shas`
    // and provenance edges. The only thing skipped is the invocation.
    //
    // No `chair_start` is emitted — the chair did not start. `chair_skipped` is a different
    // event precisely so a monitor cannot render a recall as a very fast derivation.
    if (p.reuse_hit) {
      const hit = p.reuse_hit;
      const written: OutputRecord[] = [];
      for (const o of hit.outputs) {
        const spec = output_specs.find((s) => s.domain_type === o.domain_type)!;
        const rec = deps.outputs.write({
          core_type: spec.core_type,
          domain_type: o.domain_type,
          domain,
          gig_id,
          agent_slug: producer_slug,
          from_role: chair.role,
          phase: phaseName,
          primitive: spec.primitive,
          data: o.data,
          input_refs: inputs.map((i) => i.id),
          input_shas: inputs.map((i) => i.content_sha),
          ...(o.skill_provenance ? { skill_provenance: o.skill_provenance } : {}),
          reused_from: { output_id: o.source_output_id, gig_id: hit.source_gig_id, cache_key: hit.cache_key },
        });
        for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", spec.primitive);
        written.push(rec);
      }
      const types = written.map((w) => w.domain_type);
      // #278 review — a recalled chair owes the SAME manifest row a derived one does. The
      // early return skipped the `unfulfilled_outputs` push below, so a declared-optional
      // shortfall present in the cold run vanished on the reuse hit. The engine's own comment
      // three lines from that push says a declared-optional absence "is still a fact about
      // this run", and hiding it here made a reused run's manifest quietly better than the
      // run it stands in for — while carrying an identical run_fingerprint.
      const reusedMissing = output_specs.map((sp) => sp.domain_type).filter((t) => !types.includes(t));
      if (reusedMissing.length > 0) {
        unfulfilledOutputs.push({ role: chair.role, phase: phaseName, missing: reusedMissing });
      }
      skipped.push({
        phase: phaseName, role: chair.role, reason: "reuse", source_gig_id: hit.source_gig_id,
        output_types: types, content_shas: written.map((w) => w.content_sha), cache_key: hit.cache_key,
      });
      reuseReport.hits.push({ phase: phaseName, role: chair.role, cache_key: hit.cache_key, source_gig_id: hit.source_gig_id, output_types: types });
      emit({
        type: "chair_skipped", phase: phaseName, role: chair.role, reason: "reuse",
        source_gig_id: hit.source_gig_id, output_types: types, cache_key: hit.cache_key,
      });
      return written;
    }

    const producerHint = chair.skill_slug || p.agent?.slug || chair.agent_slug || chair.role;
    emit({ type: "chair_start", phase: phaseName, role: chair.role, producer: producerHint });
    let data: Record<string, unknown>;
    // Skill-backed chairs record which skill (version + verified code_hash + tier) sealed the
    // output, so the ledger entry traces back to the exact SkillChainEvent. Undefined for agents.
    let skill_provenance: { slug: string; version: number; code_hash: string; tier: number } | undefined;

    if (p.skill_dir) {
      // SKILL-BACKED chair: run the deterministic code half in the permission cage — the
      // model is never invoked. The skill reads the merged upstream data (or the gig input
      // when it's a root chair). This is the proper fix for "an LLM should not babysit a
      // deterministic command": the command IS the chair.
      const skillInput = inputs.length > 0 ? Object.assign({}, ...inputs.map((i) => i.data)) : gigInput;
      // #253 — the ASYNC path, threaded with the run's abort signal. `executeSkill` uses
      // spawnSync, which blocks the event loop for the skill's whole timeout (120s by
      // default), so the cooperative abort chain could not run and the abort event could not
      // even be DELIVERED. `gig_abort` during a skill chair was a promise the engine could
      // not keep — #249's shape again, but a missing opportunity to kill rather than a
      // missing kill.
      const r = await executeSkillAsync(p.skill_dir, skillInput, 120_000, { signal: deps.signal });
      if (!r.ok) throw new RuntimeError(`skill chair "${chair.role}" ("${chair.skill_slug}") failed: ${r.error}`);
      data = (r.output && typeof r.output === "object" ? r.output : {}) as Record<string, unknown>;
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
      // honest record is "started, unattributed", not silence. The counter sits OUTSIDE the
      // try for the same reason: a chair killed by #250's abort still started, and still cost.
      const sink = makeUsageSink();
      startedInvocations++;
      // #turn-budget — reserve-draw interception (Items 2 & 3), all at this ONE seat so the
      // observable cannot drift. `reserveHeld` is what prepareChair offered and held against
      // `poolReserved`; `drew` records whether the chair actually crossed into its reserve; `settled`
      // guards the hold so it is converted (grant) or released (no-draw / denial) exactly once.
      const reserveHeld = p.reserve_offer ?? 0;
      let drew = false;
      let reserveSettled = false;
      const releaseHold = (): void => {
        if (reserveSettled) return;
        poolReserved -= reserveHeld;
        reserveSettled = true;
      };
      try {
        data = await deps.invoke({
          agent, phase: phaseName, gig_id, inputs, gig_input: gigInput, skills,
          missing_skills: p.missing_skills, // #241 — what did NOT resolve, so the prompt can't assert it
          output_types: output_specs.map((s) => s.domain_type), // #174 — the chair's promised subset
          // #250 level 2 + #237 — the cancellation signal and the run's depth reach the invocation
          // itself, so an invoker can kill its child and shape what it asks the model for.
          ...(deps.signal ? { signal: deps.signal } : {}),
          ...(deps.depth ? { depth: deps.depth } : {}),
          // #turn-budget — the chair's own turn budget threads through exactly as `depth` does; the
          // reserve is the pool-capped OFFER, not the raw declaration, and is present only when the
          // chair declared a reserve (so a reserve-less chair leaves the invoker's opts-level default
          // untouched — the #329 continuation path stays byte-identical).
          ...(p.chair.turn_budget !== undefined ? { turn_budget: p.chair.turn_budget } : {}),
          ...(p.reserve_offer !== undefined ? { turn_reserve: p.reserve_offer } : {}),
          // The venue → dispatch wire: thread the realized room onto the chair's ctx ONLY when a
          // venue resolved, so the invoker narrows the spawn by construction; both fields stay
          // absent otherwise (the venue-less path is unchanged).
          ...(gigRealization && gigVenue ? { realization: gigRealization, venue: gigVenue } : {}),
          // The substrate → spawn wire: when the room was actually stood up, hand the chair the
          // realized transports (docker-exec stdio configs) so the invoker points the spawn at the
          // servers INSIDE the room. Absent otherwise — the substrate-less path is unchanged.
          ...(gigSubstrate ? { substrateMcpConfigs: gigSubstrate.mcpServerConfigs } : {}),
          onEvent: (ev) => {
            sink.fold(ev);
            emit({ type: "agent_event", phase: phaseName, role: chair.role, event: ev });
            if (!budget) return;
            // A chair crossed its budget into a granted reserve. Set `yielding` (D1: one condition
            // at two scales — the gig is yielding IFF a seated chair is drawing reserve), convert the
            // held offer into a real pool draw-down, and record the attributable draw. `granted` is
            // the amount we HELD (min(own reserve, pool-at-prep)), not the event's self-report, so
            // the pool can never be lent past what it holds.
            if (ev.type === "budget_reserve_granted") {
              drew = true;
              const granted = reserveHeld;
              if (!reserveSettled) { poolReserved -= reserveHeld; reserveSettled = true; }
              budget.pool_remaining -= granted;
              budget.agent_state = "yielding";
              budget.draws.push({ role: chair.role, granted, pool_remaining_after: budget.pool_remaining });
              emit({ type: "budget_state", phase: phaseName, role: chair.role, agent_state: "yielding", pool_remaining: budget.pool_remaining });
            } else if (ev.type === "budget_reserve_denied") {
              // The chair reached for a reserve an empty pool could not give. Record the starvation
              // (never silent) and release the — necessarily zero — hold. The gig is NOT yielding: a
              // denied reach is not a draw, so the biconditional stays false.
              releaseHold();
              budget.draws.push({ role: chair.role, granted: 0, pool_remaining_after: budget.pool_remaining, denied: true });
            }
          },
        });
      } catch (e) {
        // The chair spent its reserve (and the pool) WITHOUT landing → depleted (O12/INV16). Only a
        // chair that actually drew moves to depleted; a plain failure keeps its own error semantics.
        if (budget && drew) budget.agent_state = "depleted";
        releaseHold();
        throw e;
      } finally {
        if (sink.attributed()) attributedInvocations++;
      }
      // The drawing chair LANDED within its reserve → clear yielding back to `active` (O12/INV16).
      // The gig-end success path then settles it; an idle chair that held but never drew releases here.
      if (budget && drew && budget.agent_state === "yielding") {
        budget.agent_state = "active";
        emit({ type: "budget_state", phase: phaseName, role: chair.role, agent_state: "active", pool_remaining: budget.pool_remaining });
      }
      releaseHold();
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
    }

    // Seal one record per type this chair seals. The invoker blob may be keyed by domain_type
    // (a SENSE+JUDGE agent returns { hit: {...}, verdict: {...} } → a Signal AND a Judgment from
    // one pass) OR, for a lone unkeyed output, BE the data directly. So: prefer a key matching
    // the type; for a single sealed type, fall back to the whole blob when no such key exists.
    // This keeps narrowing correct even when an over-eager invoker returns extra keys (#174) —
    // the chair seals only its promised types and reads each from its own key.
    // A keyed type may be CONDITIONAL (e.g. a verdict's provisional-draft only on FILEABLE), so a
    // missing key is skipped HERE and adjudicated below: #243 made the output_contract a floor,
    // so an absent type is an error unless the chair declares it in `optional_outputs`. (This
    // comment used to end "the downstream input_contract check fails loudly if a consumer
    // actually needed it" — that reasoning is what #243 reversed, because it holds only where a
    // consumer exists, and a terminal chair has none.) Tag each with `from_role`.
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
    // The gig-input hash is lazy and memoized at the gig level (see `gigInputSha` above) —
    // only computed when a placeholder actually resolves to it, or when resume/reuse needs it.
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
    const promised = output_specs.map((s) => s.domain_type);

    // #243 — DECIDE BEFORE SEALING. Every check that can throw now runs against resolved
    // slices while nothing has been written yet.
    //
    // The floor check used to sit AFTER the write loop, which created a failure class that did
    // not previously exist: a chair delivering part of its contract sealed those records,
    // append-flushed them to `outputs/<gig_id>.jsonl`, and only THEN threw — so the gig failed
    // with no ledger row while its partial outputs persisted. `output_query`, `output_trace`
    // and `system_health.outputs` all surface those orphans, so the two audit surfaces
    // disagree by construction and any completeness signal computed over them is describing a
    // state that cannot be reconciled. Deciding first makes a chair all-or-nothing.
    const resolved: Array<{ spec: (typeof output_specs)[number]; slice: Record<string, unknown> }> = [];
    for (const spec of output_specs) {
      const keyed = data[spec.domain_type] as Record<string, unknown> | undefined;
      const slice = keyed !== undefined && keyed !== null ? keyed : single ? data : undefined;
      if (slice === undefined || slice === null) continue;
      if (typeof slice !== "object" || slice === null) {
        throw new RuntimeError(
          `chair "${chair.role}" output "${spec.domain_type}" must be a JSON object, got ${typeof slice}`,
        );
      }
      resolved.push({ spec, slice: slice as Record<string, unknown> });
    }
    // backfillShas refuses an ambiguous provenance field. Run it over EVERY slice up front so
    // that throw also lands before the first write, rather than midway through them.
    for (const { slice } of resolved) backfillShas(slice);

    // The output_contract is a FLOOR, not merely a selector. `written.length === 0` alone let a
    // chair that promised two types and sealed one complete silently. The old in-code
    // justification — a keyed type may be conditional, and a downstream input_contract check
    // fails loudly if a consumer actually needed it — holds only WHERE A CONSUMER EXISTS. For a
    // TERMINAL chair (the gate phase, the one that emits the verdict) nothing consumes it, so
    // the promise evaporated into `status: "complete"`. The one chair whose output an operator
    // acts on was the one with no backstop.
    //
    // Conditional outputs are still legal — they now have to SAY SO, via `optional_outputs`
    // (deny-by-default: promised means required unless declared). An undeclared conditional
    // output is indistinguishable from a chair that simply failed to deliver.
    const present = new Set(resolved.map((r) => r.spec.domain_type));
    const missing = promised.filter((t) => !present.has(t));
    const optional = new Set(chair.optional_outputs ?? []);
    const missingRequired = missing.filter((t) => !optional.has(t));

    // Producing NOTHING is a different failure from dropping one promised type — "the invoker
    // returned junk" vs "one type is absent" — and collapsing them loses that distinction. But
    // it is only a FAILURE when something was actually required. A chair whose every promised
    // type is declared optional is entitled to seal nothing, and the old `written.length === 0`
    // guard fired ABOVE the floor check, which made that unexpressable. Not hypothetical:
    // patent-triage-v1's `draft` chair promises exactly one type and its intent reads "Only on
    // a FILEABLE verdict … On any other verdict, nothing." Single-output and conditional, so
    // `optional_outputs` was a no-op there until this ordering changed.
    if (resolved.length === 0 && missingRequired.length > 0) {
      throw new RuntimeError(
        `chair "${chair.role}" produced no recognized output — expected one of [${promised.join(", ")}]`,
      );
    }
    if (missingRequired.length > 0) {
      throw new RuntimeError(
        `chair "${chair.role}" did not deliver its output_contract — missing [${missingRequired.join(", ")}] ` +
          `of promised [${promised.join(", ")}]. ` +
          `If a type is legitimately conditional, declare it in the chair's optional_outputs.`,
      );
    }

    // Contract satisfied — and now the SEAL gates, still before anything is durable.
    //
    // #243 moved the contract checks ahead of the writes, which stopped a chair that
    // under-delivered from leaving orphans behind. It did not close the whole hole:
    // `write()` also validates (core agreement #263, the registry schema, the #227/#228
    // substance floor), so a chair whose SECOND output failed one of those had already
    // flushed its first to `outputs/<gig_id>.jsonl`. Same outcome by a different door —
    // sealed records belonging to a gig that failed, and two audit surfaces disagreeing by
    // construction.
    //
    // `validateWrite` is the gate `write` runs, asked as a question instead. The reuse path
    // already uses it to make a multi-output entry all-or-nothing; the derived path gets it
    // for exactly the same reason.
    for (const { spec, slice } of resolved) {
      const check = deps.outputs.validateWrite({
        core_type: spec.core_type,
        domain_type: spec.domain_type,
        data: slice,
      });
      if (!check.valid) {
        throw new RuntimeError(
          `chair "${chair.role}" cannot seal "${spec.domain_type}": ${check.reason}. ` +
            `Nothing was written — a chair's outputs are all-or-nothing.`,
        );
      }
    }

    // Only now does anything become durable.
    const written: OutputRecord[] = [];
    for (const { spec, slice } of resolved) {
      const rec = deps.outputs.write({
        core_type: spec.core_type,
        domain_type: spec.domain_type,
        domain,
        gig_id,
        agent_slug: producer_slug,
        from_role: chair.role,
        phase: phaseName,
        primitive: spec.primitive,
        data: slice,
        input_refs: inputs.map((i) => i.id),
        input_shas: inputs.map((i) => i.content_sha), // #196 — real predecessor hashes, engine-stamped
        // WHICH model produced this, resolved through the invoker's own function so the stamp
        // and the spawn cannot disagree. Absent for a skill-backed chair — no model ran, and
        // absent must mean unknown rather than "the default".
        ...(p.agent
          ? {
              model: resolveModel(p.agent.model_tier, deps.model_version),
              ...(p.agent.model_tier ? { model_tier: p.agent.model_tier } : {}),
            }
          : {}),
        skill_provenance,
      });
      for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", spec.primitive);
      written.push(rec);
    }
    // Populate the cache. Only from a DERIVED chair (a recall has nothing new to record) and
    // only when this run opted in — the store is cross-gig by construction, so writing to it
    // is the decision that this run's outputs may stand in for another's.
    //
    // A write failure is recorded, not raised: the run is complete and correct either way, and
    // killing a finished $6 gig because a cache file would not persist is the wrong trade. It
    // is still not silent — a cache nobody can write is one an operator should know about.
    if (deps.reuse && p.reuse_key && !p.reuse_hit && written.length > 0) {
      const entryOutputs: ReuseOutput[] = [];
      let cacheable = true;
      for (const w of written) {
        const fp = deps.outputs.typeFingerprint(w.domain_type);
        // An entry whose type cannot be described could never be validated on read, so it
        // would be refused there. Not writing it is the same decision, made earlier.
        if (fp === "") { cacheable = false; break; }
        entryOutputs.push({
          core_type: w.core_type, domain_type: w.domain_type, domain: w.domain,
          primitive: w.primitive, agent_slug: w.agent_slug, phase: phaseName,
          data: w.data, content_sha: w.content_sha, type_fingerprint: fp, source_output_id: w.id,
          ...(w.skill_provenance ? { skill_provenance: w.skill_provenance } : {}),
        });
      }
      if (cacheable) {
        try {
          deps.reuse.put({
            schema_version: REUSE_SCHEMA_VERSION, cache_key: p.reuse_key,
            source_gig_id: gig_id, source_role: chair.role,
            created_at: new Date().toISOString(), outputs: entryOutputs,
          });
          reuseReport.writes++;
        } catch (e) {
          reuseReport.write_errors.push({ phase: phaseName, role: chair.role, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    // A DECLARED-optional absence is still a fact about this run. Legitimising a shortfall is
    // not the same as hiding it, so it keeps its row in the manifest.
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
    // THE CHART SLOT. When this run is a movement of an arrangement, the arrangement's identity
    // folds in exactly where `genome_hash` folded — because the reproducible thing is no longer
    // "this standard's structure" but "this movement of this chart". For a degenerate chart
    // `chart_hash === genomeHash(standard)`, so a single-standard gig's fingerprint is unmoved.
    genome_hash: deps.chart?.chart_hash ?? genome_hash,
    model_version: deps.model_version ?? "unknown",
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores,
    output_hashes,
    ...(unresolved_evals.length > 0 ? { unresolved_evals } : {}),
  });

  const settledUsage = finalizeUsage();
  const gig_finished_at = new Date().toISOString();
  deps.ledger.append({
    kind: "gig",
    schema_version: LEDGER_SCHEMA_VERSION,
    // One ROW per movement, because a movement runs under its own gig id (src/chart.ts
    // `movementGigId`) — and for the degenerate chart that id IS the chart's, which is what an
    // existing single-standard reader looks up.
    entry_id: gig_id,
    gig_id,
    standard_slug: standard.slug,
    ...(deps.chart ? { chart_slug: deps.chart.chart_slug, movement_id: deps.chart.movement_id } : {}),
    genome_hash,
    run_fingerprint,
    output_hashes,
    started_at,
    finished_at: gig_finished_at,
    // settled model spend (#195) — omitted when nothing was CAPTURED (skill-only gigs, stubbed
    // invokers, or a run whose every invocation reported no usage payload). #235: an absent
    // usage block means "not captured", never "$0.00".
    ...(settledUsage ? { usage: settledUsage } : {}),
  });

  // Drain the gig HEADER to the sink (fire-and-forget, like every output before it) — the
  // stub row the drain service fabricated for FK integrity is replaced by the run's own record.
  void drainGigHeader({
    gig_id,
    standard_slug: standard.slug,
    status: "complete",
    genome_hash,
    run_fingerprint,
    started_at,
    finished_at: gig_finished_at,
    outputs_count: produced.length,
    ...(settledUsage ? { usage: { total_cost_usd: settledUsage.total_cost_usd, input_tokens: settledUsage.input_tokens, output_tokens: settledUsage.output_tokens } } : {}),
  }).catch((e) => {
    if (process.env["COLTRANE_DRAIN_DEBUG"]) console.error(`[drain] gig header ${gig_id}: ${String(e)}`);
  });

  // Cycle complete — when a budget was supplied, mark it `settled` and
  // surface the final state in the manifest. `settled` mirrors the
  // budget-state.json cycle terminal-state semantics for a closed cycle.
  if (budget) {
    budget.agent_state = "settled";
    budget.settled_usd = usage.total_cost_usd; // #233 — final reconciliation of REAL dollars
  }

  // The gig finished, so there is nothing left to resume — drop its checkpoint. Without this
  // every gig a deployment ever runs leaves a file behind forever. Only the SUCCESS path clears
  // it: a failed or aborted run's checkpoint is exactly what a later resume reads, and this line
  // is not reached on either.
  try { deps.checkpoints?.remove(gig_id); } catch { /* reclaiming disk must not fail a run that succeeded */ }

  const result: GigResult = {
    gig_id, standard_slug: standard.slug,
    ...(deps.chart ? { chart_slug: deps.chart.chart_slug, movement_id: deps.chart.movement_id } : {}),
    genome_hash, run_fingerprint, outputs: produced, eval_scores, status: "complete",
    ...(seedsConsumed.size > 0
      ? {
          seeded_from: [...seedsConsumed.values()].map((s) => ({
            gig_id: s.gig_id, output_id: s.id, domain_type: s.domain_type, content_sha: s.content_sha,
          })),
        }
      : {}),
  };
  if (settledUsage) result.usage = settledUsage;
  if (budget) result.budget_state = budget;
  if (unresolved_evals.length > 0) result.unresolved_evals = unresolved_evals;
  if (unfulfilledOutputs.length > 0) result.unfulfilled_outputs = unfulfilledOutputs;
  // Say what was skipped and why. The ABSENCE of these fields is itself a claim — that every
  // chair in this manifest ran — so they are present only when there is something to report,
  // and `reuse` is present whenever the cache was wired even if nothing hit (a zero-hit run is
  // a fact about the cache, not an absence of one).
  if (skipped.length > 0) result.skipped = skipped;
  if (resumedFrom) result.resumed_from = resumedFrom;
  if (deps.reuse) result.reuse = reuseReport;
  if (checkpointError !== undefined) result.checkpoint_error = checkpointError;
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
    let partial: ReturnType<typeof finalizeUsage>;
    if (e && typeof e === "object") {
      partial = finalizeUsage();
      if (partial) (e as Record<string, unknown>)["usage"] = partial;
      if (budget) (e as Record<string, unknown>)["budget_state"] = budget;
    }
    // The sink learns the truth either way: a failed run drains a FAILED header (same
    // fire-and-forget seam as the success path), so the queue row never sits stale on a
    // local failure. Found live: the worker's first day exposed the success-only drain.
    void drainGigHeader({
      gig_id,
      standard_slug: standard.slug,
      status: "failed",
      genome_hash,
      started_at,
      finished_at: new Date().toISOString(),
      outputs_count: produced.length,
      error: e instanceof Error ? e.message : String(e),
      ...(partial ? { usage: { total_cost_usd: partial.total_cost_usd, input_tokens: partial.input_tokens, output_tokens: partial.output_tokens } } : {}),
    }).catch((de) => {
      if (process.env["COLTRANE_DRAIN_DEBUG"]) console.error(`[drain] failed-gig header ${gig_id}: ${String(de)}`);
    });
    throw e;
  } finally {
    // ONE ROOM, ONE GIG, ONE TEARDOWN — on both paths. A room outlives every chair that sits in it
    // and dies with the run, which is what `lifecycle: ephemeral` means and what the chair-level
    // teardown this replaces could not express.
    //
    // AWAITED, because a realizer that stands up real resources returns a promise: the interface
    // already declares `Promise<void> | void`, and an unawaited teardown on the failure path means a
    // process can exit with a container still running. A leak on the path that is ALREADY going
    // badly is the worst place to have one.
    //
    // Best-effort by construction: a teardown that throws must not replace the gig's own outcome —
    // a failed teardown after a successful run would turn a good gig into a bad one, and after a
    // failed run would hide the real error behind a cleanup error. What it must never do is pass
    // silently, so it is reported on the drain-debug channel like every other best-effort seam here.
    try {
      await gigRealization?.teardown();
    } catch (te) {
      if (process.env["COLTRANE_DRAIN_DEBUG"]) {
        console.error(`[venue] teardown failed for gig ${gig_id}: ${te instanceof Error ? te.message : String(te)}`);
      }
    }
    // BOTH LAYERS ARE TORN DOWN, INDEPENDENTLY. The substrate handle (a real compose project, for the
    // container realizer) gets its OWN try/catch, NOT the policy teardown's: a shared one would let a
    // throwing substrate teardown skip the policy teardown (or vice versa), and a room that outlives
    // its gig is the leak this wire exists to close. Best-effort like the policy teardown — a throw
    // here must not replace the gig's outcome, only surface on the drain-debug channel.
    try {
      await gigSubstrate?.teardown();
    } catch (te) {
      if (process.env["COLTRANE_DRAIN_DEBUG"]) {
        console.error(`[venue] substrate teardown failed for gig ${gig_id}: ${te instanceof Error ? te.message : String(te)}`);
      }
    }
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
