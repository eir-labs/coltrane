// Multi-voice composition: when multiple agents play together in the sim, they
// form polyphony. Each agent emits its own modulation_path (its voice). This
// module composes N voices into a polyphonic read WITHOUT collapsing them into
// one melodic line — voice independence is preserved; cross-voice coupling is
// surfaced as feature-data, never as a single verdict.

import {
  circleOfFifthsDistance,
  type Key,
} from "./circle_of_fifths.js";
import type { ModulationPath } from "./modulation_path.js";

export interface Voice {
  agent_slug: string;
  path: ModulationPath;
}

export interface ChordAtPhase {
  phase: string;
  // per-voice key at this phase (some voices may not be playing — undefined)
  voices: ReadonlyMap<string, Key>;
  // pairwise circle-of-fifths distances between voices that ARE playing
  // — preserved as a full set, NOT collapsed to a single "consonance score"
  pairwise: ReadonlyArray<{
    voice_a: string;
    voice_b: string;
    distance: number;
  }>;
}

export interface Polyphony {
  voices: readonly Voice[];
  // per-phase chord reads: voices playing + their pairwise distances.
  // every value preserved; caller folds to verdict by their own policy.
  chords: readonly ChordAtPhase[];
}

export class PolyphonyError extends Error {}

export function composeVoices(voices: readonly Voice[]): Polyphony {
  if (voices.length === 0) {
    throw new PolyphonyError("polyphony requires at least one voice");
  }

  // Collect every phase name that any voice visits.
  const phaseOrder: string[] = [];
  const seen = new Set<string>();
  for (const v of voices) {
    for (const step of v.path.steps) {
      if (!seen.has(step.phase)) {
        seen.add(step.phase);
        phaseOrder.push(step.phase);
      }
    }
  }

  // For each phase, gather which voices are playing + their pairwise distances.
  const chords: ChordAtPhase[] = phaseOrder.map((phase) => {
    const voicesAtPhase = new Map<string, Key>();
    for (const v of voices) {
      const step = v.path.steps.find((s) => s.phase === phase);
      if (step) voicesAtPhase.set(v.agent_slug, step.key);
    }
    const slugs = [...voicesAtPhase.keys()];
    const pairwise: { voice_a: string; voice_b: string; distance: number }[] = [];
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const a = slugs[i]!;
        const b = slugs[j]!;
        pairwise.push({
          voice_a: a,
          voice_b: b,
          distance: circleOfFifthsDistance(voicesAtPhase.get(a)!, voicesAtPhase.get(b)!),
        });
      }
    }
    return { phase, voices: voicesAtPhase, pairwise };
  });

  return { voices, chords };
}

/**
 * Number of voices sounding at a given phase. Feature, not verdict.
 */
export function voiceCountAtPhase(poly: Polyphony, phase: string): number {
  const chord = poly.chords.find((c) => c.phase === phase);
  return chord ? chord.voices.size : 0;
}

/**
 * Tonic-density: the n-tonic shape of the chord at a given phase.
 * monotonic (1 voice) · bitonic (2) · tritonic (3) · pentatonic (5) · polyphonic (≥6).
 * Names match Eugene's morning spec.
 */
export type TonicDensity =
  | "silence"
  | "monotonic"
  | "bitonic"
  | "tritonic"
  | "tetratonic"
  | "pentatonic"
  | "hexatonic"
  | "polyphonic";

export function tonicDensity(poly: Polyphony, phase: string): TonicDensity {
  const n = voiceCountAtPhase(poly, phase);
  if (n === 0) return "silence";
  if (n === 1) return "monotonic";
  if (n === 2) return "bitonic";
  if (n === 3) return "tritonic";
  if (n === 4) return "tetratonic";
  if (n === 5) return "pentatonic";
  if (n === 6) return "hexatonic";
  return "polyphonic";
}

/**
 * Per-phase tonic-density profile across the whole polyphonic structure.
 * Returned as an array of (phase, density) — feature data for a tensor channel.
 */
export function densityProfile(poly: Polyphony): ReadonlyArray<{ phase: string; density: TonicDensity }> {
  return poly.chords.map((c) => ({ phase: c.phase, density: tonicDensity(poly, c.phase) }));
}

/**
 * Maximum pairwise distance at a given phase. Surfaces "how dissonant" the
 * chord is in circle-of-fifths terms. A NUMBER (0..6), not a pass/fail.
 */
export function maxDissonanceAtPhase(poly: Polyphony, phase: string): number {
  const chord = poly.chords.find((c) => c.phase === phase);
  if (!chord || chord.pairwise.length === 0) return 0;
  return Math.max(...chord.pairwise.map((p) => p.distance));
}
