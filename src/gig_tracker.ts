// Live gig state — the coltrane-layer observability the async dispatcher exposes.
//
// gig_dispatch (async) starts a gig in the background and returns its id immediately; the
// runtime fires GigProgressEvents as it walks the phase graph; this module folds those into
// a GigRunState that gig_monitor reads. State is in-memory (per server lifetime): a restart
// drops in-flight tracking — acceptable for v0, and a restart mid-gig is its own problem.

import type { GigProgressEvent, BudgetState } from "./runtime.js";
import type { GigUsage } from "./ledger.js";

export interface GigChairState {
  role: string;
  phase: string;
  /** `skipped` is its OWN status. A chair served from a checkpoint or the reuse cache did not
   *  run, and rendering it as `complete` would make a recall indistinguishable from a very
   *  fast derivation — which is the whole thing an operator watching a run needs to tell apart. */
  status: "running" | "complete" | "failed" | "skipped";
  producer?: string;          // agent slug or skill slug that ran the chair
  output_types?: string[];    // the domain types it sealed
  duration_ms?: number;
  tool_calls: string[];       // tool names the chair's child invoked (from agent_event)
  error?: string;
  /** skipped only — "resume" (this gig's own checkpoint) or "reuse" (a prior gig's output). */
  skipped_reason?: "resume" | "reuse";
  /** skipped only — the gig whose sealed output stood in for this chair. */
  source_gig_id?: string;
}

/** The outcomes a tracked gig can reach. `aborted` is first-class (#251): without it a
 *  cancelled run could only surface as `failed` carrying a kill-shaped error string —
 *  indistinguishable from a genuine crash, which is the opposite of what an operator who
 *  just cancelled it needs to see. */
export type GigStatus = "running" | "complete" | "failed" | "aborted";

export interface GigRunState {
  gig_id: string;
  standard_slug: string;
  status: GigStatus;
  started_at: string;
  finished_at?: string;
  phases_total: number;
  current_phase?: string;
  phases_seen: string[];
  chairs: Record<string, GigChairState>; // keyed by role
  outputs_count: number;
  run_fingerprint?: string;
  genome_hash?: string;
  error?: string;
  // Settled model spend (#195), set when the run completes — and, since #249, when it is
  // ABORTED. An abort that kills children without capturing accrued usage would convert a
  // recorded cost into an unrecorded one: better cost control, worse accounting.
  usage?: GigUsage;
  /** Chairs that did not run because a sealed output stood in for them (#resume/#reuse). */
  skipped_chairs?: Array<{ phase: string; role: string; reason: "resume" | "reuse"; source_gig_id: string; output_types: string[] }>;
  /** Set when this run resumed a prior attempt at the same gig. */
  resumed_from?: { gig_id: string; roles: string[]; outputs: number };
  /** Cache entries that were FOUND and refused. Surfaced so a cache that stopped hitting says why. */
  reuse_rejected?: Array<{ phase: string; role: string; reason: string; detail?: string }>;
  // #236 — the budget snapshot, set on BOTH terminal paths. The synchronous dispatch reply
  // has carried this since the budget existed (server.ts), but the async path — which is the
  // DEFAULT — dropped it either way: a completed gig never reported what it consumed, and a
  // failed one lost the reservation/settlement record along with everything else. Absent while
  // running, and absent entirely when no budget was supplied.
  budget_state?: BudgetState;
  // ── cancellation (#249/#250) ──────────────────────────────────────────────
  // The live handle. gig_abort aborts it; runGig's checkpoints read it and the invoker wires
  // it to the chair's child process. This is the ONLY object that makes a gig cancellable —
  // before it existed, gig_abort mutated state the runtime never read. Cleared on settle so a
  // retained run doesn't pin a controller (and its listeners) for the server's lifetime.
  controller?: AbortController | undefined;
  /** An operator asked for this run to stop (set even when no controller could be reached). */
  abort_requested?: boolean;
  /** Why. Surfaced by gig_monitor so `aborted` reads as a decision, not a mystery. */
  abort_reason?: string;
}

export function newGigRun(gig_id: string, standard_slug: string, phases_total: number, now: string): GigRunState {
  return {
    gig_id, standard_slug, status: "running", started_at: now,
    phases_total, phases_seen: [], chairs: {}, outputs_count: 0,
  };
}

// Fold one progress event into the state (mutating). Pure w.r.t. side effects — file/stderr
// teeing is the caller's job; this only updates the queryable snapshot.
export function applyGigProgress(state: GigRunState, ev: GigProgressEvent): void {
  switch (ev.type) {
    case "phase_start":
      state.current_phase = ev.phase;
      if (!state.phases_seen.includes(ev.phase)) state.phases_seen.push(ev.phase);
      for (const role of ev.roles) {
        if (!state.chairs[role]) state.chairs[role] = { role, phase: ev.phase, status: "running", tool_calls: [] };
      }
      break;
    case "chair_start":
      state.chairs[ev.role] = { role: ev.role, phase: ev.phase, status: "running", producer: ev.producer, tool_calls: [] };
      break;
    case "agent_event": {
      const c = state.chairs[ev.role];
      if (c && ev.event.type === "tool_use" && ev.event.tool) c.tool_calls.push(ev.event.tool);
      break;
    }
    case "chair_complete": {
      const c = state.chairs[ev.role] ?? (state.chairs[ev.role] = { role: ev.role, phase: ev.phase, status: "running", tool_calls: [] });
      c.status = "complete";
      c.producer = ev.producer;
      c.output_types = ev.output_types;
      c.duration_ms = ev.duration_ms;
      state.outputs_count += ev.output_types.length;
      break;
    }
    case "chair_failed": {
      const c = state.chairs[ev.role] ?? (state.chairs[ev.role] = { role: ev.role, phase: ev.phase, status: "running", tool_calls: [] });
      c.status = "failed";
      c.error = ev.error;
      break;
    }
    case "gig_resumed":
      state.resumed_from = { gig_id: ev.from_gig_id, roles: ev.roles, outputs: ev.outputs };
      state.outputs_count += ev.outputs;
      break;
    case "chair_skipped": {
      // Not `complete`: a chair that did not run must not read as one that ran fast.
      state.chairs[ev.role] = {
        role: ev.role, phase: ev.phase, status: "skipped", tool_calls: [],
        output_types: ev.output_types, skipped_reason: ev.reason, source_gig_id: ev.source_gig_id,
      };
      (state.skipped_chairs ??= []).push({
        phase: ev.phase, role: ev.role, reason: ev.reason,
        source_gig_id: ev.source_gig_id, output_types: ev.output_types,
      });
      break;
    }
    case "reuse_rejected":
      (state.reuse_rejected ??= []).push({
        phase: ev.phase, role: ev.role, reason: ev.reason,
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      });
      break;
    case "gig_complete":
      state.outputs_count = ev.outputs;
      break;
    case "gig_failed":
      state.error = ev.error;
      break;
    case "gig_aborted":
      // A cancelled run is not a crashed run. Recording it as its own terminal status is what
      // lets gig_monitor answer "did my abort land?" instead of showing a kill-shaped error.
      state.status = "aborted";
      state.abort_reason = ev.reason;
      state.finished_at ??= new Date().toISOString();
      break;
  }
}

/**
 * Retention bound for the live-run map (#253). `gig_runs` had three call sites and no
 * `delete` — every dispatch added an entry retained for the server's lifetime, including
 * per-chair `tool_calls` arrays that grow per call.
 *
 * Only SETTLED runs are eligible: a running gig's entry holds the AbortController, so
 * pruning one would silently make that gig uncancellable — trading a memory leak for the
 * very bug #249 is about. Oldest-settled-first, so the runs an operator is most likely to
 * ask about survive. Returns how many were dropped.
 */
export const DEFAULT_GIG_RUN_RETENTION = 200;

export function pruneGigRuns(runs: Map<string, GigRunState>, max = DEFAULT_GIG_RUN_RETENTION): number {
  const settled = [...runs.values()].filter((s) => s.status !== "running");
  if (settled.length <= max) return 0;
  const at = (s: GigRunState): string => s.finished_at ?? s.started_at;
  settled.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
  const drop = settled.slice(0, settled.length - max);
  for (const s of drop) runs.delete(s.gig_id);
  return drop.length;
}

// A compact one-line summary of an event for the stderr/MCP log (skips per-token noise).
export function gigEventLogLine(gig_id: string, ev: GigProgressEvent): string | null {
  const base = { t: new Date().toISOString(), gig: gig_id };
  switch (ev.type) {
    case "phase_start": return JSON.stringify({ ...base, ev: "phase_start", phase: ev.phase, chairs: ev.roles });
    case "chair_start": return JSON.stringify({ ...base, ev: "chair_start", phase: ev.phase, role: ev.role, producer: ev.producer });
    case "chair_complete": return JSON.stringify({ ...base, ev: "chair_complete", role: ev.role, sealed: ev.output_types, ms: ev.duration_ms });
    case "chair_failed": return JSON.stringify({ ...base, ev: "chair_failed", role: ev.role, error: ev.error });
    // #241 — a dangling (non-required) skill binding. Surfaced live because an unskilled run
    // is otherwise indistinguishable from a skilled one: same genome_hash, run_fingerprint,
    // content_sha. This log line is the only place the difference shows up while it happens.
    case "skills_unresolved": return JSON.stringify({ ...base, ev: "skills_unresolved", phase: ev.phase, role: ev.role, agent: ev.agent, missing: ev.missing });
    // A run that skipped phases has to SAY SO in the live log, not only in the final manifest —
    // an operator watching a gig fly through five phases in two seconds needs to know why.
    case "gig_resumed": return JSON.stringify({ ...base, ev: "gig_resumed", from: ev.from_gig_id, roles: ev.roles, outputs: ev.outputs });
    case "chair_skipped": return JSON.stringify({ ...base, ev: "chair_skipped", phase: ev.phase, role: ev.role, why: ev.reason, from_gig: ev.source_gig_id, sealed: ev.output_types });
    case "reuse_rejected": return JSON.stringify({ ...base, ev: "reuse_rejected", phase: ev.phase, role: ev.role, reason: ev.reason, detail: ev.detail });
    case "gig_complete": return JSON.stringify({ ...base, ev: "gig_complete", outputs: ev.outputs });
    case "gig_failed": return JSON.stringify({ ...base, ev: "gig_failed", error: ev.error });
    case "gig_aborted": return JSON.stringify({ ...base, ev: "gig_aborted", reason: ev.reason });
    case "agent_event":
      // only surface tool calls live, not every assistant token
      return ev.event.type === "tool_use"
        ? JSON.stringify({ ...base, ev: "tool_use", role: ev.role, tool: ev.event.tool })
        : null;
  }
}
