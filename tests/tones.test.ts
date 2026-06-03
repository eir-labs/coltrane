// O17 — song-substrate core: the 12 tones, additive chords, arity, interval
// consonance, resolution. The counter-claim throughout: nothing collapses to a
// scalar verdict — resolve() returns the full tension profile + structure, one
// channel's read meant to be triangulated, never a "truth" on its own.
import { describe, it, expect } from "vitest";
import {
  TONES, N_TONES, toneName, intervalClass, intervalConsonance,
  classifyArity, chordArity, chordConsonance, chordTension, resolve,
} from "../src/tones.js";

describe("tones: the chromatic 12", () => {
  it("has exactly 12 named tones", () => {
    expect(TONES.length).toBe(12);
    expect(N_TONES).toBe(12);
    expect(toneName(0)).toBe("C");
    expect(toneName(7)).toBe("G");
    expect(toneName(12)).toBe("C"); // wraps
    expect(toneName(-1)).toBe("B"); // wraps negative
  });
});

describe("tones: interval consonance (just-intonation grounded)", () => {
  it("computes interval class symmetrically", () => {
    expect(intervalClass(0, 7)).toBe(5); // perfect fifth
    expect(intervalClass(0, 5)).toBe(5); // perfect fourth = same class
    expect(intervalClass(0, 6)).toBe(6); // tritone
    expect(intervalClass(0, 4)).toBe(4); // major third
  });
  it("orders consonance: unison > fifth > third > tritone", () => {
    expect(intervalConsonance(0, 0)).toBeGreaterThan(intervalConsonance(0, 7));
    expect(intervalConsonance(0, 7)).toBeGreaterThan(intervalConsonance(0, 4));
    expect(intervalConsonance(0, 4)).toBeGreaterThan(intervalConsonance(0, 6));
    expect(intervalConsonance(0, 6)).toBeLessThan(0.1); // tritone most dissonant
  });
});

describe("tones: arity (the monotonic…polyphonic primitives)", () => {
  it("names by tone-count", () => {
    expect(classifyArity(0)).toBe("silent");
    expect(classifyArity(1)).toBe("monotonic");
    expect(classifyArity(2)).toBe("bitonic");
    expect(classifyArity(3)).toBe("tritonic");
    expect(classifyArity(5)).toBe("pentatonic");
    expect(classifyArity(8)).toBe("polyphonic");
  });
  it("classifies a chord by its distinct tones", () => {
    expect(chordArity([0, 4, 7])).toBe("tritonic"); // major triad
    expect(chordArity([0, 0, 12])).toBe("monotonic"); // all the same pitch class
  });
});

describe("tones: chord consonance is additive over pairs", () => {
  it("a major triad is more consonant than a tone cluster", () => {
    expect(chordConsonance([0, 4, 7])).toBeGreaterThan(chordConsonance([0, 1, 2]));
  });
  it("a lone tone is maximally consonant; tension is its complement", () => {
    expect(chordConsonance([5])).toBe(1.0);
    expect(chordTension([0, 4, 7])).toBeCloseTo(1 - chordConsonance([0, 4, 7]), 10);
  });
});

describe("tones: resolution is a structured read, never a scalar verdict", () => {
  it("a V→I shape (tension drops into a consonant tonic) resolves", () => {
    const r = resolve([[0, 1, 6], [0, 4, 7]]); // dissonant → major triad
    expect(r.resolves).toBe(true);
    expect(r.tonic).toBe(0);
    expect(r.tensionDropped).toBe(true);
    expect(r.tensionProfile.length).toBe(2); // profile preserved, not collapsed
  });
  it("ending on a dissonance does NOT resolve", () => {
    const r = resolve([[0, 4, 7], [0, 1, 2]]);
    expect(r.resolves).toBe(false);
    expect(r.finalConsonance).toBeLessThan(0.6);
  });
  it("empty progression resolves to nothing, with an empty profile", () => {
    const r = resolve([]);
    expect(r.resolves).toBe(false);
    expect(r.tonic).toBeNull();
    expect(r.tensionProfile).toEqual([]);
  });
});
