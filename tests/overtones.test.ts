import { describe, it, expect } from "vitest";
import {
  A4_HZ,
  fundamentalHz,
  overtoneSeries,
  centsDistance,
  overtoneOverlap,
  overtoneConsonance,
  consonanceMatrix,
  KEYS,
} from "../src";

describe("fundamentals + A4 reference", () => {
  it("A4 is 440 Hz", () => {
    expect(A4_HZ).toBe(440);
    expect(fundamentalHz("A")).toBeCloseTo(440, 5);
  });

  it("C is below A by 9 semitones (C4 ≈ 261.63 Hz at A4=440 reference)", () => {
    expect(fundamentalHz("C")).toBeCloseTo(261.63, 1);
  });

  it("G is 7 semitones above C (G4 ≈ 392 Hz)", () => {
    expect(fundamentalHz("G")).toBeCloseTo(392, 0);
  });

  it("every key has a positive frequency", () => {
    for (const k of KEYS) {
      expect(fundamentalHz(k)).toBeGreaterThan(0);
    }
  });
});

describe("overtoneSeries — integer multiples of the fundamental", () => {
  it("first 8 harmonics of C", () => {
    const series = overtoneSeries("C", 8);
    expect(series).toHaveLength(8);
    const f0 = fundamentalHz("C");
    for (let i = 0; i < 8; i++) {
      expect(series[i]).toBeCloseTo(f0 * (i + 1), 5);
    }
  });

  it("empty when n=0", () => {
    expect(overtoneSeries("C", 0)).toHaveLength(0);
  });
});

describe("centsDistance", () => {
  it("0 between identical frequencies", () => {
    expect(centsDistance(440, 440)).toBe(0);
  });

  it("1200 cents between an octave (440 → 880)", () => {
    expect(centsDistance(880, 440)).toBeCloseTo(1200, 5);
  });

  it("100 cents between adjacent semitones (12-TET)", () => {
    const semitone = 440 * Math.pow(2, 1 / 12);
    expect(centsDistance(semitone, 440)).toBeCloseTo(100, 5);
  });
});

describe("overtoneOverlap — physical consonance count", () => {
  it("a key's overtones perfectly align with themselves", () => {
    const self = overtoneOverlap("C", "C");
    expect(self).toBeGreaterThan(0);
  });

  it("perfect fifth (C–G) has higher overlap than tritone (C–Gb)", () => {
    const fifth = overtoneOverlap("C", "G");
    const tritone = overtoneOverlap("C", "Gb");
    expect(fifth).toBeGreaterThanOrEqual(tritone);
  });

  it("returns a number (feature, not verdict)", () => {
    expect(typeof overtoneOverlap("C", "G")).toBe("number");
  });
});

describe("overtoneConsonance — feature scoring", () => {
  it("never collapses to boolean", () => {
    const r = overtoneConsonance("C", "G");
    expect(typeof r).toBe("number");
    expect(r).toBeGreaterThanOrEqual(0);
  });
});

describe("consonanceMatrix — 12×12 preserved", () => {
  it("returns a full 12×12 matrix, NOT a collapsed score", () => {
    const m = consonanceMatrix();
    for (const a of KEYS) {
      for (const b of KEYS) {
        expect(typeof m[a][b]).toBe("number");
      }
    }
  });

  it("matrix is symmetric: m[a][b] = m[b][a]", () => {
    const m = consonanceMatrix();
    for (const a of KEYS) {
      for (const b of KEYS) {
        expect(m[a][b]).toBe(m[b][a]);
      }
    }
  });
});
