// Song-substrate CORE — the 12 chromatic tones, additive chords, arity (the
// monotonic…polyphonic primitives = tone-count), interval consonance, and
// resolution. This is ONE channel's read (the song). Per the directive: it returns
// STRUCTURE, never a scalar "truth" — the song is one vantage of three
// (score · output · song); triangulation across them lives above this module.
// Nothing here collapses to pass/fail; it emits the song-read's shape for the
// tensor to couple against the other channels.

export const TONES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const N_TONES = 12;

// A tone is a pitch class 0..11. A chord is a set of tones (sound is additive).
export type Tone = number;
export type Chord = readonly Tone[];

export function toneName(t: Tone): string {
  return TONES[((t % N_TONES) + N_TONES) % N_TONES]!;
}

// Interval class (0..6) = the symmetric semitone distance. Consonance is grounded
// in just-intonation ratios: unison/octave most consonant, tritone least.
export function intervalClass(a: Tone, b: Tone): number {
  const d = Math.abs(a - b) % N_TONES;
  return Math.min(d, N_TONES - d);
}
const IC_CONSONANCE: Readonly<Record<number, number>> = {
  0: 1.0, // unison / octave (2:1)
  5: 0.9, // perfect fifth / fourth (3:2, 4:3)
  4: 0.7, // major third / minor sixth (5:4)
  3: 0.6, // minor third / major sixth (6:5)
  2: 0.35, // major second / minor seventh
  1: 0.1, // minor second / major seventh
  6: 0.05, // tritone
};
export function intervalConsonance(a: Tone, b: Tone): number {
  return IC_CONSONANCE[intervalClass(a, b)] ?? 0;
}

// Arity = how many tones compose a voice. The named primitives (Eugene's spec)
// are the small cases; beyond pentatonic it's polyphonic.
export type Arity =
  | "silent" | "monotonic" | "bitonic" | "tritonic" | "tetratonic" | "pentatonic" | "polyphonic";
export function classifyArity(toneCount: number): Arity {
  switch (toneCount) {
    case 0: return "silent";
    case 1: return "monotonic";
    case 2: return "bitonic";
    case 3: return "tritonic";
    case 4: return "tetratonic";
    case 5: return "pentatonic";
    default: return "polyphonic";
  }
}
export function chordArity(chord: Chord): Arity {
  return classifyArity(new Set(chord.map((t) => ((t % N_TONES) + N_TONES) % N_TONES)).size);
}

// Chord consonance = the mean of pairwise interval consonances (additive over
// pairs). A lone tone is maximally consonant (nothing clashes); silence is null.
export function chordConsonance(chord: Chord): number {
  const ts = [...new Set(chord.map((t) => ((t % N_TONES) + N_TONES) % N_TONES))];
  if (ts.length <= 1) return 1.0;
  let sum = 0, pairs = 0;
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      sum += intervalConsonance(ts[i]!, ts[j]!);
      pairs++;
    }
  }
  return sum / pairs;
}

// Tension = the complement of consonance. A dissonant chord wants to resolve.
export function chordTension(chord: Chord): number {
  return 1 - chordConsonance(chord);
}

// Resolution — a STRUCTURED read of a progression, not a verdict. A progression
// "resolves" when tension drops into a consonant final chord (the V→I shape):
// the final chord is consonant AND tension fell from the penultimate to it.
export interface Resolution {
  resolves: boolean;
  tonic: Tone | null; // the root (lowest tone) of the final chord
  finalConsonance: number; // consonance of the final chord
  tensionProfile: number[]; // per-chord tension across the progression (preserved, not collapsed)
  tensionDropped: boolean; // did tension fall into the final chord?
}
const RESOLVE_CONSONANCE = 0.6; // a final chord at/above this is "at rest"
export function resolve(progression: readonly Chord[]): Resolution {
  const tensionProfile = progression.map(chordTension);
  if (progression.length === 0) {
    return { resolves: false, tonic: null, finalConsonance: 0, tensionProfile, tensionDropped: false };
  }
  const last = progression[progression.length - 1]!;
  const finalConsonance = chordConsonance(last);
  const tensionDropped = progression.length >= 2
    ? tensionProfile[tensionProfile.length - 2]! > tensionProfile[tensionProfile.length - 1]!
    : true; // a lone consonant chord is trivially at rest
  const tonic = last.length ? [...last].sort((a, b) => a - b)[0]! : null;
  return {
    resolves: finalConsonance >= RESOLVE_CONSONANCE && tensionDropped,
    tonic, finalConsonance, tensionProfile, tensionDropped,
  };
}
