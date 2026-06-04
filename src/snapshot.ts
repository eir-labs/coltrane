/**
 * snapshot.ts — pluggable working-memory snapshot for chain windows.
 *
 * The chain (audit_chain.ts) already provides EXACT integrity: sha_seal on
 * each event, prev_sha linking the stream, verifyAuditChain reports the
 * tamper point. That's the byte-equal restoration mode.
 *
 * This module adds a SIMILARITY-AWARE snapshot mode. Given a window of
 * chain events (a working-memory state), `snapshot()` returns a Snapshot
 * carrying:
 *   - mode:        which snapshot mode produced this record
 *   - fingerprint: sha256 over the canonical stats — integrity + identity
 *   - stats:       mode-specific breakdown the distance function reads
 *
 * Two structurally-similar windows get neighbor fingerprints under the
 * mode's distance function, even when their bytes differ. Useful for
 * "have I been in a structurally-similar working state before?" queries
 * across past sessions.
 *
 * The slot is pluggable. OSS ships `cognitiveShapeV0`: counts + categorical
 * distributions over kind/surface/primitive + ts span, sha256 over the
 * canonical stats, L1 distance over the distributions. Real arithmetic
 * on real chain windows; usable today, a functioning gift.
 *
 * Eirmath plugs richer modes via the `Snapshotter` interface:
 * persistent-homology over event-adjacency, the 49-cell signature,
 * substrate-tuned spectral readings. Same slot, different snapshot
 * function, different mode tag. License gates which modes are
 * registered; the chain substrate stays identical.
 *
 * Authored by cajal under the gift-that-functions discipline.
 */

import { sha256Hex, canonJson } from "./canonical_form.js";
import type { AuditEvent } from "./audit_chain.js";

/**
 * One snapshot of one chain window. The `mode` tag distinguishes OSS
 * (cognitive-shape-v0) from eirmath plug-ins (psi-v0, etc); `fingerprint` is
 * the sha256 of the canonical stats — same stats always hash to the same
 * fingerprint, different stats hash to different fingerprints; `stats`
 * carries the breakdown the mode's distance function reads.
 */
export interface Snapshot {
  mode: string;
  fingerprint: string;
  stats: Record<string, unknown>;
}

/**
 * Contract for any snapshot mode. Implement to add a new mode.
 *
 * `mode` is the tag stored on Snapshot records — must be unique per impl.
 * `snapshot` takes a chain window (events in chain order) and returns a
 * Snapshot. `distance` defines similarity over snapshots IN THE SAME
 * MODE; cross-mode distance is not defined and must throw.
 */
export interface Snapshotter {
  readonly mode: string;
  snapshot(events: readonly AuditEvent[]): Snapshot;
  distance(a: Snapshot, b: Snapshot): number;
}

/**
 * Tally a string key into an accumulator map. Helper for distribution
 * computation; keeps the snapshot function readable.
 */
function tally(acc: Record<string, number>, key: string): void {
  acc[key] = (acc[key] || 0) + 1;
}

/**
 * cognitive-shape-v0 — the OSS reference Snapshotter.
 *
 * Captures the "cognitive shape" of a chain window: how many events, what
 * kinds (react/post/tool_call/verdict/name_event/primitive_engage), which
 * surface (head/hands), which primitives engaged, and the wall-clock span.
 *
 * Two windows with similar kind/surface/primitive distributions sit close
 * in cognitive-shape-v0 distance even if their exact bytes differ. Useful for
 * "have I been in a structurally-similar working state before?" queries.
 *
 * Eirmath snapshotters extend this with substrate-tuned topology:
 * persistent homology over event-adjacency graphs, spectral signatures,
 * the 49-cell canonical form. This impl is intentionally simple — the
 * gift functions, the substrate-tuning is the licensed unlock.
 */
export const cognitiveShapeV0: Snapshotter = {
  mode: "cognitive-shape-v0",

  snapshot(events) {
    const node_count = events.length;
    const kind_dist: Record<string, number> = {};
    const surface_dist: Record<string, number> = {};
    const primitive_dist: Record<string, number> = {};

    for (const event of events) {
      tally(kind_dist, event.kind);
      tally(surface_dist, event.surface);
      if (event.primitive) tally(primitive_dist, event.primitive);
    }

    const first = events[0];
    const last = events[events.length - 1];
    const ts_span =
      first && last ? { start: first.ts, end: last.ts } : null;

    const stats = {
      node_count,
      kind_dist,
      surface_dist,
      primitive_dist,
      ts_span,
    };

    return {
      mode: this.mode,
      fingerprint: sha256Hex(canonJson(stats)),
      stats,
    };
  },

  /**
   * L1 distance over the three categorical distributions. Sum of absolute
   * count differences across all keys present in either snapshot. Zero
   * iff distributions are identical. Mode-mismatched comparison throws —
   * distance across modes is undefined.
   */
  distance(a, b) {
    if (a.mode !== this.mode || b.mode !== this.mode) {
      throw new Error(
        `cognitiveShapeV0.distance: requires both snapshots mode=${this.mode}, got ${a.mode} / ${b.mode}`,
      );
    }
    const aStats = a.stats as {
      kind_dist: Record<string, number>;
      surface_dist: Record<string, number>;
      primitive_dist: Record<string, number>;
    };
    const bStats = b.stats as typeof aStats;

    function l1(da: Record<string, number>, db: Record<string, number>): number {
      const keys = new Set<string>([...Object.keys(da), ...Object.keys(db)]);
      let sum = 0;
      for (const k of keys) sum += Math.abs((da[k] || 0) - (db[k] || 0));
      return sum;
    }

    return (
      l1(aStats.kind_dist, bStats.kind_dist) +
      l1(aStats.surface_dist, bStats.surface_dist) +
      l1(aStats.primitive_dist, bStats.primitive_dist)
    );
  },
};

/**
 * Registry of snapshot modes available at runtime. coltrane-oss seeds
 * cognitive-shape-v0; eirmath registers additional modes via registerMode
 * once its license check passes. The chain substrate stays identical
 * regardless of which modes are registered.
 */
const MODES = new Map<string, Snapshotter>([[cognitiveShapeV0.mode, cognitiveShapeV0]]);

/**
 * Register a Snapshotter — used by eirmath plug-ins at boot to attach
 * licensed modes. Throws if the mode tag collides with an existing one.
 */
export function registerMode(snapshotter: Snapshotter): void {
  if (MODES.has(snapshotter.mode)) {
    throw new Error(`snapshot mode already registered: ${snapshotter.mode}`);
  }
  MODES.set(snapshotter.mode, snapshotter);
}

/**
 * Lookup a Snapshotter by mode tag. Throws if unknown — callers should
 * either pre-check via listModes() or catch and downgrade to the OSS
 * default.
 */
export function getMode(mode: string): Snapshotter {
  const snapshotter = MODES.get(mode);
  if (!snapshotter) {
    throw new Error(
      `unknown snapshot mode: ${mode} (available: ${[...MODES.keys()].join(", ")})`,
    );
  }
  return snapshotter;
}

/**
 * Available mode tags. Useful for callers that want to negotiate the
 * highest-fidelity mode the runtime has unlocked.
 */
export function listModes(): readonly string[] {
  return [...MODES.keys()];
}

/**
 * Convenience: snapshot a chain window using the OSS default mode. Most
 * callers just want a snapshot without picking a mode; this is the
 * no-arg-needed entry point. Eirmath callers use getMode("psi-v0").snapshot.
 */
export function snapshot(events: readonly AuditEvent[]): Snapshot {
  return cognitiveShapeV0.snapshot(events);
}
