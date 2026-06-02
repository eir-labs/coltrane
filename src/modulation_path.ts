// The per-gig journey through 12-key space. A modulation path is the song's
// trajectory: which key it's in at each phase, what kind of move it made to get
// there. NOT collapsed to a scalar — preserved as a per-phase sequence so a
// validator can read it as one channel in a multi-channel tensor.

import {
  type Key,
  circleOfFifthsDistance,
  classifyModulation,
  type ModulationKind,
} from "./circle_of_fifths.js";

export interface PhaseStep {
  phase: string;
  key: Key;
}

export interface PathTransition {
  from_phase: string;
  to_phase: string;
  from_key: Key;
  to_key: Key;
  distance: number;
  kind: ModulationKind;
}

export interface ModulationPath {
  steps: readonly PhaseStep[];
  transitions: readonly PathTransition[];
  starts_in: Key;
  ends_in: Key;
  // tensor-shaped read: per-transition rows, NEVER a single scalar verdict.
  // a caller can fold this to a verdict by their own policy, but the path
  // itself preserves the full trajectory.
}

export class ModulationPathError extends Error {}

export function buildPath(steps: readonly PhaseStep[]): ModulationPath {
  if (steps.length === 0) {
    throw new ModulationPathError("modulation path requires at least one step");
  }
  const transitions: PathTransition[] = [];
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!;
    const b = steps[i]!;
    transitions.push({
      from_phase: a.phase,
      to_phase: b.phase,
      from_key: a.key,
      to_key: b.key,
      distance: circleOfFifthsDistance(a.key, b.key),
      kind: classifyModulation(a.key, b.key),
    });
  }
  return {
    steps,
    transitions,
    starts_in: steps[0]!.key,
    ends_in: steps[steps.length - 1]!.key,
  };
}

/**
 * Lawful-only: every transition is either stay or lawful (no jarring jumps).
 * Used by the validation tensor as ONE channel-read — not a global verdict.
 */
export function isLawful(path: ModulationPath): boolean {
  return path.transitions.every((t) => t.kind !== "jarring");
}

/**
 * Count jarring transitions. Returned as a number, not a boolean, so a
 * validator can weight it inside a tensor instead of collapsing to pass/fail.
 */
export function jarringCount(path: ModulationPath): number {
  return path.transitions.filter((t) => t.kind === "jarring").length;
}

/**
 * Total distance traveled along the trajectory. Sum of per-step circle-of-fifths
 * distances. NOT a verdict — a feature for the validation tensor.
 */
export function totalTravel(path: ModulationPath): number {
  return path.transitions.reduce((acc, t) => acc + t.distance, 0);
}

/**
 * Did the path return to its starting key (closed loop)? Cadence-shaped:
 * a song that resolves to where it began. Feature, not verdict.
 */
export function returnsHome(path: ModulationPath): boolean {
  return path.starts_in === path.ends_in;
}
