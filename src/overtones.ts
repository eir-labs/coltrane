// Harmonic-series overtones. Each fundamental tone carries its overtone series
// — the integer multiples of its frequency that sound when it's played. This is
// what makes two notes physically consonant (their overtone series align) or
// dissonant (they don't). A SEPARATE read-channel from circle-of-fifths key-
// topology: where the circle measures KEY relationships, overtones measure
// FREQUENCY-resonance. Both belong in the tensor; neither collapses to scalar.

import { KEYS, type Key } from "./circle_of_fifths.js";

/**
 * Frequency of A4 = 440 Hz. The reference pitch for the tuning system.
 * 12-TET (twelve-tone equal temperament) places every adjacent semitone at a
 * frequency ratio of 2^(1/12) ≈ 1.05946.
 */
export const A4_HZ = 440;

const SEMITONE_RATIO = Math.pow(2, 1 / 12);

// Semitone count above C for each circle-of-fifths key (octave = 0).
// We use this to compute fundamentals: C=0, G=7, D=2, A=9, E=4, B=11, etc.
const SEMITONES_ABOVE_C: Readonly<Record<Key, number>> = {
  C: 0, G: 7, D: 2, A: 9, E: 4, B: 11,
  Gb: 6, Db: 1, Ab: 8, Eb: 3, Bb: 10, F: 5,
};

/** Fundamental frequency for a given key, tied to A4 = 440 Hz at octave 4. */
export function fundamentalHz(k: Key): number {
  const semitonesFromA4 = SEMITONES_ABOVE_C[k] - SEMITONES_ABOVE_C["A"];
  return A4_HZ * Math.pow(SEMITONE_RATIO, semitonesFromA4);
}

/**
 * Overtone series for a fundamental. Returns the first N harmonics
 * (multiples 1, 2, 3, ..., N of the fundamental frequency).
 */
export function overtoneSeries(k: Key, n: number = 8): readonly number[] {
  if (n < 1) return [];
  const f0 = fundamentalHz(k);
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(f0 * i);
  return out;
}

/**
 * Cents-distance between two frequencies. 100 cents = one semitone.
 * Used to judge how close two overtones are — perceptually, within ~25 cents
 * is heard as "the same note."
 */
export function centsDistance(hz_a: number, hz_b: number): number {
  return 1200 * Math.log2(hz_a / hz_b);
}

/**
 * How well two overtone series ALIGN. For each pair (a_i, b_j) with i,j in the
 * first N harmonics, count the pairs that fall within tolerance_cents of each
 * other. Returns a NUMBER (overlap count), not a verdict. Higher = more
 * physically-resonant; lower = more dissonant.
 *
 * Octaves count as alignment (an octave is the same note class).
 */
export function overtoneOverlap(
  a: Key,
  b: Key,
  n: number = 8,
  tolerance_cents: number = 25,
): number {
  const series_a = overtoneSeries(a, n);
  const series_b = overtoneSeries(b, n);
  let count = 0;
  for (const fa of series_a) {
    for (const fb of series_b) {
      // Fold into a single octave for the comparison (overtones repeat across octaves).
      let cents = centsDistance(fa, fb);
      while (cents > 600) cents -= 1200;
      while (cents < -600) cents += 1200;
      if (Math.abs(cents) <= tolerance_cents) count++;
    }
  }
  return count;
}

/**
 * Consonance score between two keys, by overtone overlap.
 * NOT a verdict — a feature for the tensor. The CALLER decides what threshold
 * means "consonant" vs "dissonant" — different musical traditions use different
 * thresholds (Western tonal vs jazz vs microtonal).
 */
export function overtoneConsonance(a: Key, b: Key): number {
  return overtoneOverlap(a, b);
}

/**
 * Map every key against every other key, returning a 12×12 overlap matrix.
 * Pure data — preserved as a structure, never collapsed to "one chord is
 * consonant" or similar.
 */
export function consonanceMatrix(): Readonly<Record<Key, Readonly<Record<Key, number>>>> {
  const out: Partial<Record<Key, Record<Key, number>>> = {};
  for (const a of KEYS) {
    const row: Record<Key, number> = {} as Record<Key, number>;
    for (const b of KEYS) {
      row[b] = overtoneOverlap(a, b);
    }
    out[a] = row;
  }
  return out as Record<Key, Record<Key, number>>;
}
