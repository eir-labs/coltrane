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
import type { BudgetInput } from "./runtime.js";

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
