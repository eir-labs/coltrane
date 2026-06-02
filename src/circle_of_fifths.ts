// 12-key topology for the song-substrate. Each key is a tonic + its scale.
// The circle of fifths arranges them in a ring where adjacent keys share 6 of
// 7 scale notes (smooth modulation) and tritone-apart keys share 1 of 7
// (jarring). This file exposes the 12 key names, their position on the circle,
// and distance helpers — pure data + arithmetic, no LLM dependency.

export const KEYS = [
  "C",
  "G",
  "D",
  "A",
  "E",
  "B",
  "Gb",
  "Db",
  "Ab",
  "Eb",
  "Bb",
  "F",
] as const;

export type Key = (typeof KEYS)[number];

const KEY_INDEX: ReadonlyMap<Key, number> = new Map(KEYS.map((k, i) => [k, i]));

/**
 * Shortest distance along the circle of fifths between two keys.
 * Returns 0..6 (6 = tritone-apart). Adjacent keys = 1.
 */
export function circleOfFifthsDistance(a: Key, b: Key): number {
  const ia = KEY_INDEX.get(a);
  const ib = KEY_INDEX.get(b);
  if (ia === undefined || ib === undefined) {
    throw new Error(`unknown key: ${ia === undefined ? a : b}`);
  }
  const raw = Math.abs(ia - ib);
  return Math.min(raw, KEYS.length - raw);
}

/**
 * Adjacent keys on the circle (one step in either direction).
 * C ↔ G, C ↔ F, etc. Smooth modulation pairs.
 */
export function adjacentKeys(k: Key): readonly Key[] {
  const i = KEY_INDEX.get(k);
  if (i === undefined) throw new Error(`unknown key: ${k}`);
  const right = KEYS[(i + 1) % KEYS.length]!;
  const left = KEYS[(i - 1 + KEYS.length) % KEYS.length]!;
  return [left, right];
}

/**
 * The relative minor for each major key (parallel by 3 fifths down).
 * Provided for completeness; the validation logic treats relative-minor
 * modulation as zero-cost (same key signature).
 */
export const RELATIVE_MINOR: Readonly<Record<Key, string>> = {
  C: "Am",
  G: "Em",
  D: "Bm",
  A: "F#m",
  E: "C#m",
  B: "G#m",
  Gb: "Ebm",
  Db: "Bbm",
  Ab: "Fm",
  Eb: "Cm",
  Bb: "Gm",
  F: "Dm",
};

/**
 * Modulation classification used by sim-verify. A jsong that moves from key A
 * to key B is "lawful" if the move is within MODULATION_THRESHOLD (default 1,
 * i.e., adjacent on the circle, including relative-minor equivalence).
 * Above the threshold = "jarring" — drift signal unless explicitly bridged.
 */
export const MODULATION_THRESHOLD = 1;

export type ModulationKind = "stay" | "lawful" | "jarring";

export function classifyModulation(from: Key, to: Key, threshold: number = MODULATION_THRESHOLD): ModulationKind {
  if (from === to) return "stay";
  const d = circleOfFifthsDistance(from, to);
  return d <= threshold ? "lawful" : "jarring";
}
