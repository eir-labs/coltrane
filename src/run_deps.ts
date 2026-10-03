import { amendLadderFromEnv } from "./invoker_selection.js";
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
import { PLAYER_LEASE_MS } from "./lease.js";

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

/**
 * The budget a drained gig runs under, in US DOLLARS (budget-in-dollars contract, I7/F4).
 *
 * A gig that names its own dollar ceiling wins. Otherwise the drain reads `COLTRANE_DRAIN_MAX_USD`:
 *   * a positive finite number → that per-gig dollar ceiling;
 *   * absent → NO ceiling (the retired 2000 append-unit default is gone — an unattended box under a
 *     dollar ceiling is bounded by the operator's env, not by a synthetic size proxy);
 *   * anything else (not a number, zero, negative, Infinity) → REFUSE startup, naming the variable,
 *     rather than silently running with the wrong (or no) ceiling.
 *
 * Returns a { max_usd } when a ceiling applies, or {} (no enforcement) when none does — never
 * undefined, so a caller reading `.max_usd` off the result never trips on undefined.
 */
export function drainBudget(
  input: Record<string, unknown> | undefined,
  /** The claim's own ceiling in integer micro-dollars (coltrane_gigs.budget_micro_usd, #555). The
   *  hosted door strips `budget` from what it queues and the store hands this back on the claim, so it
   *  WINS: it is the gig's own ceiling. Not an integer ≥ 0 → refused rather than guessed at. */
  claimMicroUsd?: unknown,
): BudgetInput {
  if (claimMicroUsd !== undefined && claimMicroUsd !== null) {
    if (typeof claimMicroUsd !== "number" || !Number.isSafeInteger(claimMicroUsd) || claimMicroUsd < 0) {
      throw new Error(`the claim's budget_micro_usd must be a non-negative integer of micro-dollars; got ${JSON.stringify(claimMicroUsd)}`);
    }
    // Dollars only for reporting; the gate compares max_micro_usd (see BudgetInput).
    return { max_usd: claimMicroUsd / 1_000_000, max_micro_usd: claimMicroUsd };
  }
  const named = (input?.["budget"] as { max_usd?: unknown } | undefined)?.["max_usd"];
  if (typeof named === "number" && Number.isFinite(named) && named > 0) return { max_usd: named };

  const raw = process.env["COLTRANE_DRAIN_MAX_USD"];
  if (raw === undefined || raw === "") return {};
  const env = Number(raw);
  if (!Number.isFinite(env) || env <= 0) {
    throw new Error(`COLTRANE_DRAIN_MAX_USD must be a positive finite number of USD; got "${raw}"`);
  }
  return { max_usd: env };
}

/**
 * How long a single drained gig may run before it is aborted — or `undefined`: NO clock.
 *
 * A VENUE run has no run deadline. Founder's ruling, 3 Oct 2026: a run is never cut off because time
 * passed, only because a fact says it must stop — its lease is lost (the store answers that another
 * worker holds it) or can no longer be shown held (no renewal landed for a whole lease window:
 * LeaseUnverifiable, src/lease.ts), its settled spend reached its budget, or an abort door was used.
 * Duration is not the ceiling; budget is, and any per-gig time belongs to the gig's own voicing and
 * seating, not to the box. The 25-minute default this replaced was a stand-in for a thirty-minute
 * lease the store had already moved to sixty, and it aborted a seven-chair run at its last chair with
 * no cause named. COLTRANE_GIG_TIMEOUT_MS is NOT read in venue mode; the worker says so in its log
 * when it is set, rather than silently ignoring it.
 *
 * A PLAYER run (coltrane_mcp_claim) keeps a deadline, because that path holds a thirty-minute lease
 * (PLAYER_LEASE_MS) and has no renew door: its run must end inside that one lease or another player
 * claims it mid-run. Five sixths of the lease, overridable by COLTRANE_GIG_TIMEOUT_MS. The honest fix
 * there is a renew door for players, not a clock; until it exists the clock is the lease, restated.
 */
export function drainTimeoutMs(mode: "venue" | "player" = "venue"): number | undefined {
  if (mode === "venue") return undefined;
  const env = Number(process.env["COLTRANE_GIG_TIMEOUT_MS"]);
  return Number.isFinite(env) && env > 0 ? env : Math.floor((PLAYER_LEASE_MS * 5) / 6);
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
  const typed = typedInputField(claim.input, "repository");
  if (typed !== null) return typed;
  if (typeof explicitRepoUrl === "string" && explicitRepoUrl.trim().length > 0) return explicitRepoUrl;
  const orgDefault = claim.repo_url;
  return typeof orgDefault === "string" && orgDefault.trim().length > 0 ? orgDefault : null;
}

/**
 * A typed input field, read where a typed input actually arrives. A gig's `input` is keyed by TYPE
 * SLUG ({"change-request": {...}}) — the hosted dispatch refuses a bare payload as MissingGigInput —
 * so a field "in the typed input" sits one level down. The top level is read first (a bare payload,
 * a test), then each object one level down, first match. A non-string or an empty string is not a
 * value. (3 Oct 2026: `repository` had been read at the top only, and so was never reached for a
 * real dispatch; the org default answered instead.)
 */
export function typedInputField(input: unknown, field: string): string | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  if (!input || typeof input !== "object") return null;
  const top = str((input as Record<string, unknown>)[field]);
  if (top !== null) return top;
  for (const v of Object.values(input as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = str((v as Record<string, unknown>)[field]);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * THE BASE A CHANGE-SET IS MEASURED FROM — `change_set_base` on the typed input, read the same two
 * ways as `repository`. Null when the request carries none: then the seat's own base must already be
 * in the tree, or the seal refuses `base_not_in_tree`. prepareWorkspace fetches a named base into the
 * shallow clone while the gig's credential is in hand; nothing later in the run holds that credential.
 */
export function resolveChangeSetBase(claim: { input?: unknown }): string | null {
  return typedInputField(claim.input, "change_set_base");
}

/**
 * A git revision the engine will hand to git as a POSITIONAL argument. Conservative on purpose: a
 * full or abbreviated sha, a tag or branch name, `HEAD~3` — and nothing that git could read as an
 * option (a leading dash: `--depth=999999` after `origin` un-shallows the clone; `--upload-pack=…`
 * names a program), nothing with whitespace, nothing with `..` (a range, not a commit). The grade of
 * coltrane#575 found the option injection; this is the wall, at every place a base reaches git.
 */
export const SAFE_GIT_REV = /^[A-Za-z0-9][A-Za-z0-9._\/~^-]{0,255}$/;
export function isSafeGitRev(rev: string): boolean {
  return SAFE_GIT_REV.test(rev) && !rev.includes("..") && !rev.endsWith("/") && !rev.endsWith(".lock");
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
  | "tree_root"
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
  /** The commit a change-set is measured from (change_set_base on the typed input), threaded to the
   *  realizer exactly as repoUrl is, so a room's tree is prepared the same way the drain's is. */
  changeSetBase?: string | null | undefined;
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
    ...(args.changeSetBase ? { changeSetBase: args.changeSetBase } : {}),
    // The address-stamping tree (records-by-address): the directory whose git objects the seal reads
    // to stamp a red-spec's `laws` / a change-set's `changes`. Supplied per door — the server/CLI
    // name the repository root the server was bootstrapped with, the drain its working clone — and
    // threaded only when present, so a research gig that names no tree stays byte-identical and a
    // laws/changes seal with no tree_root refuses `tree_root_unknown` rather than reading process.cwd().
    ...(args.tree_root ? { tree_root: args.tree_root } : {}),
    // THE AMEND LADDER, from the deployment's environment — here, in the one assembler, so the dispatch
    // door and the drain cannot disagree about it. Absent → no key → the loop is what it was.
    ...(() => { const l = amendLadderFromEnv(process.env); return l ? { tier_ladder: l } : {}; })(),
  };
}
