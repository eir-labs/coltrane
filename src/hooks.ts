// Tool-call interception seam (#206). A generic pre/post hook around dispatchTool so a WRAPPING layer
// (a control plane) can gate, observe, or rewrite tool calls in-process — without the engine shipping
// any policy of its own. The engine provides ONLY these types + the loop in dispatchTool; it ships
// ZERO built-in hooks, no trust levels, no promotion logic. Everything opinionated lives in the
// wrapper that injects `ServerDeps.hooks`. Absent/empty hooks → dispatch is byte-identical to no seam.
//
// This is the open/commercial line: mechanism is public, gates stay private. `requiresApproval` stays
// an advisory flag the engine computes and a hook may CONSULT (via ctx.requires_approval) — never one
// the engine enforces here.
import type { ServerDeps, ToolResult } from "./server.js";

/** What a hook sees about the call it's wrapping. `args` is the CURRENT args — i.e. whatever a prior
 *  before-hook rewrote them to — so a later hook (and the impl) act on the threaded value. */
export interface ToolCallContext {
  readonly slug: string;
  readonly args: Record<string, unknown>;
  readonly deps: ServerDeps;
  /** the engine's own computed approval flag, for the hook to consult — NOT enforced by the engine. */
  readonly requires_approval: boolean;
}

/** A before-hook either lets the call proceed (optionally rewriting args) or halts it with a result.
 *  `halt` means "the call never ran": the impl, the remaining before-hooks, and ALL after-hooks are
 *  skipped, and `result` is returned verbatim. */
export type PreOutcome =
  | { action: "continue"; args?: Record<string, unknown> }
  | { action: "halt"; result: ToolResult };

/** A pre/post interceptor on dispatchTool. `name` is for diagnostics/telemetry only. A hook that
 *  throws fails the call CLOSED (a gate that errors must never let the call through). */
export interface ToolHook {
  readonly name: string;
  before?(ctx: ToolCallContext): Promise<PreOutcome> | PreOutcome;
  after?(ctx: ToolCallContext, result: ToolResult): Promise<ToolResult> | ToolResult;
}
