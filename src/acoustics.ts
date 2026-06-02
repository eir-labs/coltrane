// Acoustics depth — the layer beneath 12-TET (the overtones module). Where overtones.ts uses
// equal-temperament's 12 buckets, this carries JUST INTONATION (the pure integer ratios the
// harmonic series actually produces), the COMMA (the cents gap between just and tempered —
// what equal-temperament smears to make all 12 keys playable), and MICROTONAL reads
// (continuous cents, never bucketed). Consonance is returned as a number — a feature, never
// a boolean verdict.

// 5-limit just intonation: interval name → [numerator, denominator] of the pure ratio.
export const JUST_RATIOS: Readonly<Record<string, readonly [number, number]>> = {
  unison: [1, 1],
  minor2: [16, 15],
  major2: [9, 8],
  minor3: [6, 5],
  major3: [5, 4],
  perfect4: [4, 3],
  tritone: [45, 32],
  perfect5: [3, 2],
  minor6: [8, 5],
  major6: [5, 3],
  minor7: [9, 5],
  major7: [15, 8],
  octave: [2, 1],
};

// semitone distance for each named interval — the 12-TET position to compare against.
const SEMITONES: Readonly<Record<string, number>> = {
  unison: 0, minor2: 1, major2: 2, minor3: 3, major3: 4, perfect4: 5,
  tritone: 6, perfect5: 7, minor6: 8, major6: 9, minor7: 10, major7: 11, octave: 12,
};

// cents of a pure ratio: 1200 * log2(n/d).
export function ratioCents(ratio: readonly [number, number]): number {
  return 1200 * Math.log2(ratio[0] / ratio[1]);
}

// cents of an equal-tempered interval: 100 cents per semitone, exactly.
export function temperedCents(semitones: number): number {
  return 100 * semitones;
}

// the comma: how far the JUST interval sits from its TEMPERED neighbor, in cents.
// positive = just is sharper than tempered. (perfect5 ≈ +1.96; major3 ≈ -13.69, the
// syntonic comma equal-temperament spends to keep every key playable.)
export function comma(interval: string): number {
  const ratio = JUST_RATIOS[interval];
  const semis = SEMITONES[interval];
  if (ratio === undefined || semis === undefined) return NaN;
  return ratioCents(ratio) - temperedCents(semis);
}

// consonance of a ratio as a number — simpler ratio = more consonant (1 / Tenney-ish height).
// octave > fifth > fourth > thirds > tritone. a feature, not a verdict.
export function ratioConsonance(ratio: readonly [number, number]): number {
  return 1 / (Math.log2(ratio[0] * ratio[1]) + 1);
}

// microtonal read: given a continuous cents value (0..1200), the nearest just interval and
// the signed deviation in cents — the continuous pitch is preserved, not snapped to 12.
export function nearestJust(cents: number): { interval: string; deviationCents: number } {
  let best = "unison";
  let bestAbs = Infinity;
  for (const name of Object.keys(JUST_RATIOS)) {
    const dev = cents - ratioCents(JUST_RATIOS[name]!);
    if (Math.abs(dev) < bestAbs) {
      bestAbs = Math.abs(dev);
      best = name;
    }
  }
  return { interval: best, deviationCents: cents - ratioCents(JUST_RATIOS[best]!) };
}
