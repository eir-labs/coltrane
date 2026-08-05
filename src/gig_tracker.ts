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
  status: "running" | "complete" | "failed";
  producer?: string;          // agent slug or skill slug that ran the chair
  output_types?: string[];    // the domain types it sealed
  duration_ms?: number;
  tool_calls: string[];       // tool names the chair's child invoked (from agent_event)
  error?: string;
}

export interface GigRunState {
  gig_id: string;
  standard_slug: string;
  status: "running" | "complete" | "failed";
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
  // Settled model spend (#195), set when the run completes. Surfaced by gig_monitor so a
  // gig's actual cost/tokens are queryable by gig_id, not just persisted on the ledger.
  usage?: GigUsage;
  // #236 — the budget snapshot, set on BOTH terminal paths. The synchronous dispatch reply
  // has carried this since the budget existed (server.ts), but the async path — which is the
  // DEFAULT — dropped it either way: a completed gig never reported what it consumed, and a
  // failed one lost the reservation/settlement record along with everything else. Absent while
  // running, and absent entirely when no budget was supplied.
  budget_state?: BudgetState;
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
    case "gig_complete":
      state.outputs_count = ev.outputs;
      break;
    case "gig_failed":
      state.error = ev.error;
      break;
  }
}

// A compact one-line summary of an event for the stderr/MCP log (skips per-token noise).
export function gigEventLogLine(gig_id: string, ev: GigProgressEvent): string | null {
  const base = { t: new Date().toISOString(), gig: gig_id };
  switch (ev.type) {
    case "phase_start": return JSON.stringify({ ...base, ev: "phase_start", phase: ev.phase, chairs: ev.roles });
    case "chair_start": return JSON.stringify({ ...base, ev: "chair_start", phase: ev.phase, role: ev.role, producer: ev.producer });
    case "chair_complete": return JSON.stringify({ ...base, ev: "chair_complete", role: ev.role, sealed: ev.output_types, ms: ev.duration_ms });
    case "chair_failed": return JSON.stringify({ ...base, ev: "chair_failed", role: ev.role, error: ev.error });
    case "gig_complete": return JSON.stringify({ ...base, ev: "gig_complete", outputs: ev.outputs });
    case "gig_failed": return JSON.stringify({ ...base, ev: "gig_failed", error: ev.error });
    case "agent_event":
      // only surface tool calls live, not every assistant token
      return ev.event.type === "tool_use"
        ? JSON.stringify({ ...base, ev: "tool_use", role: ev.role, tool: ev.event.tool })
        : null;
  }
}
