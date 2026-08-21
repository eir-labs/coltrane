/**
 * The enforcement half of `RunDeps`, assembled once so the two call sites cannot drift.
 *
 * WHY THIS EXISTS. `runGig` takes its dependencies as a bag of optionals, and every absence has a
 * defensible-looking default. Read one call site and each omission looks deliberate. Read both side
 * by side and the drain — the path that runs queued work on an unattended box — was missing nine
 * wires the server had, three of which disable a control outright:
 *
 *   budget                            `runtime.ts:1149`  absent → enforcement OFF
 *   toolProviders / mcpServerConfigs  `runtime.ts:1208`  absent → grant resolution OFF, so a dead
 *                                                        tool name reaches the spawn instead of
 *                                                        failing closed
 *   signal                                               absent → no abort wiring; nothing stops a
 *                                                        running gig
 *
 * It survived because a drained gig's ledger still records `usage` and `settled_usd` accurately. It
 * reported spend it was never bounded by, which reads like working software.
 *
 * WHAT IS NOT SHARED, AND WHY. `bootstrapServerDeps` builds `mcpServerConfigs` by reading
 * `.mcp.json` from the genome root. On the server that root is the operator's own checkout. On a
 * drain the cwd is a FRESHLY CLONED REPOSITORY — untrusted input — so sharing that function
 * wholesale would let a cloned repo declare MCP servers for the seat reading it, reintroducing
 * exactly what `--setting-sources user` was added to close. The drain therefore gets an EMPTY
 * server map: present, so resolution is on; empty, so a grant naming any server but the engine's
 * own fails closed. That is the correct posture for a box running work nobody is watching.
 */

import { MCP_TOOLS } from "./mcp.js";
import { ENGINE_MCP_SERVER, type ToolProvider, type ToolProviderRegistry } from "./tool_providers.js";
import type { BudgetInput, RunDeps } from "./runtime.js";

/**
 * Every engine tool as an in-house provider, tagged with the engine's own MCP server.
 *
 * The same construction `bootstrapServerDeps` performs, lifted out so the drain gets an identical
 * registry rather than a second one that drifts. Static — it depends on the engine's tool surface,
 * not on any genome root — which is why it is safe for a drain to build while the server-config
 * half is not.
 */
export function engineToolProviders(): ToolProviderRegistry {
  return new Map<string, ToolProvider>(
    MCP_TOOLS.map((t) => [t.slug, { tool: t.slug, kind: "in_house" as const, server: ENGINE_MCP_SERVER }]),
  );
}

/** Default ceiling for a drained gig, in append units. */
const DEFAULT_DRAIN_OPENING = 2000;

/**
 * The budget a drained gig runs under.
 *
 * On the server this comes from the DISPATCH PAYLOAD — a caller names it, and a caller who names
 * nothing gets no enforcement, which is defensible when a human is watching the reply.
 *
 * A drain has no such human. So absence means the DEFAULT here rather than "off": an unattended box
 * that can spend without limit is the one thing it must not be. A gig that names its own budget
 * still wins, because the dispatcher knows more about the work than this constant does.
 *
 * COLTRANE_DRAIN_OPENING overrides. Set it deliberately high rather than removing it — the point is
 * that a ceiling EXISTS, not that this particular number is right.
 */
export function drainBudget(input: Record<string, unknown> | undefined): BudgetInput {
  const named = (input?.["budget"] as { opening?: unknown } | undefined)?.["opening"];
  if (typeof named === "number" && Number.isFinite(named) && named > 0) return { opening: named };

  const env = Number(process.env["COLTRANE_DRAIN_OPENING"]);
  return { opening: Number.isFinite(env) && env > 0 ? env : DEFAULT_DRAIN_OPENING };
}

/**
 * How long a single drained gig may run before it is aborted.
 *
 * The store's lease is thirty minutes; a run that outlives it is working on a gig another drain may
 * already have reclaimed. Defaulting under the lease keeps one gig to one worker without needing
 * the two clocks to agree exactly.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 25 * 60 * 1000;

export function drainTimeoutMs(): number {
  const env = Number(process.env["COLTRANE_GIG_TIMEOUT_MS"]);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_DRAIN_TIMEOUT_MS;
}

/**
 * WHICH REPOSITORY THIS GIG'S WORKING TREE IS. One home for the decision, shared by every door — the
 * drain reads it as `resolveWorkingRepo(claim)` and the dispatch door as
 * `resolveWorkingRepo({ input }, args['repo_url'])`, so a change-request's repository resolves the
 * SAME way however the gig arrived.
 *
 * The order is the fix, in three tiers:
 *   1. the TYPED input `repository` — a first-class field in every code-touching standard's input
 *      contract (domain_types/change-request.json, change-context.json). The correct value was always
 *      being passed; a direct dispatch was the door that ignored it.
 *   2. an EXPLICIT repo_url argument — the dispatch door's named override, honoured beneath the typed
 *      input and above the org default so `repo_url` on gig_dispatch keeps working as a fallback.
 *   3. the org column (`claim.repo_url`) — the store's per-organization default, so existing
 *      single-repo deployments keep working unchanged.
 *
 * Null is a normal answer, not a degraded one — a standard whose contract names no repository touches
 * no tree and mints no git credential, which is already correct for research work.
 *
 * `explicitRepoUrl` has a default initializer so `Function.length === 1`: the drain calls this with one
 * argument and tests/the_repo_is_typed_input pins that arity. `claim` is typed structurally (no
 * ClaimedGig import) so this shared module keeps its no-new-dependency posture.
 */
export function resolveWorkingRepo(
  claim: { input?: unknown; repo_url?: string | null | undefined },
  explicitRepoUrl: string | undefined = undefined,
): string | null {
  const typed = (claim.input as { repository?: unknown } | undefined)?.repository;
  if (typeof typed === "string" && typed.trim().length > 0) return typed;
  if (typeof explicitRepoUrl === "string" && explicitRepoUrl.trim().length > 0) return explicitRepoUrl;
  const orgDefault = claim.repo_url;
  return typeof orgDefault === "string" && orgDefault.trim().length > 0 ? orgDefault : null;
}

/**
 * The SHARED run-deps every gig runs under, assembled once so the four call sites cannot drift.
 *
 * WHY THIS EXISTS. `runGig` takes its dependencies as a bag of optionals, and `runGig` has four call
 * sites (server.ts sync + async dispatch, worker.ts drain, chart.ts movement), each of which used to
 * hand-assemble its own body. Read one and each omission looks deliberate; read them side by side and
 * they had already diverged — a wire added to one branch was carried to the other by a comment asking
 * the next reader to remember. This function is that shared body: every door builds its run-deps from
 * here, so a wire is INHERITED, not copied by reminder.
 *
 * The fields that legitimately DIFFER per door are supplied by explicit ARGUMENT, never defaulted:
 *   · `mcpServerConfigs` — empty on the drain (a freshly cloned, untrusted repo must not declare
 *     servers for the seat reading it; see the header above) and the bootstrap map on the server. A
 *     default would silently hand one door the wrong value — the exact class of hand-carried
 *     divergence this whole change exists to eliminate — so it is a REQUIRED argument.
 *   · the venue trio (`venue`/`venues`/`venueRealizer`) and `repoUrl` — conditionally spread so an
 *     absent one is threaded to nothing, keeping the venue-less / repo-less path byte-identical.
 *
 * DOOR-SPECIFIC fields (gig_id, signal, onProgress, depth, reuse/human wiring, resume_from,
 * seed_outputs, chart, checkpoints) are NOT here: each call site spreads its own onto this result. The
 * assembler unifies exactly the wires that diverged and no more.
 */
export type AssembleRunDepsArgs = Pick<
  RunDeps,
  | "outputs"
  | "ledger"
  | "invoke"
  | "model_version"
  | "skills"
  | "skill_dirs"
  | "evals"
  | "budget"
  | "toolProviders"
  | "venue"
  | "venues"
  | "venueRealizer"
  | "placementResolver"
> & {
  /**
   * The enforcement environment, supplied per door: {} on the drain, the bootstrap map on the server
   * (which is itself `Record | undefined`). REQUIRED — the property may hold undefined but may never be
   * OMITTED, so every door states this wire at its call site rather than inheriting a silent default;
   * that omission is the exact hand-carried divergence this assembler exists to foreclose.
   */
  mcpServerConfigs: Readonly<Record<string, unknown>> | undefined;
  /** The repository this run operates on, already resolved via `resolveWorkingRepo`. Null → not threaded. */
  repoUrl?: string | null | undefined;
};

export function assembleRunDeps(args: AssembleRunDepsArgs): RunDeps {
  return {
    outputs: args.outputs,
    ledger: args.ledger,
    invoke: args.invoke,
    model_version: args.model_version,
    skills: args.skills,
    skill_dirs: args.skill_dirs,
    evals: args.evals,
    budget: args.budget,
    toolProviders: args.toolProviders,
    mcpServerConfigs: args.mcpServerConfigs,
    // The venue trio and the repository, threaded only when present so an absent one is threaded to
    // nothing — runGig's `deps.venue !== undefined` gate stays untripped and the venue-less path is
    // byte-identical.
    ...(args.venue ? { venue: args.venue } : {}),
    ...(args.venues ? { venues: args.venues } : {}),
    ...(args.venueRealizer ? { venueRealizer: args.venueRealizer } : {}),
    ...(args.placementResolver ? { placementResolver: args.placementResolver } : {}),
    ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
  };
}
