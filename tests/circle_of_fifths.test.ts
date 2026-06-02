import { describe, it, expect } from "vitest";
import {
  KEYS,
  circleOfFifthsDistance,
  adjacentKeys,
  classifyModulation,
  RELATIVE_MINOR,
  MODULATION_THRESHOLD,
} from "../src";

describe("12-key topology", () => {
  it("exposes exactly 12 keys", () => {
    expect(KEYS).toHaveLength(12);
  });

  it("contains the 12 chromatic keys in fifths order", () => {
    expect([...KEYS]).toEqual([
      "C", "G", "D", "A", "E", "B",
      "Gb", "Db", "Ab", "Eb", "Bb", "F",
    ]);
  });

  it("RELATIVE_MINOR has an entry for every key", () => {
    for (const k of KEYS) {
      expect(RELATIVE_MINOR[k]).toBeDefined();
    }
  });
});

describe("circleOfFifthsDistance", () => {
  it("distance from a key to itself is 0", () => {
    for (const k of KEYS) {
      expect(circleOfFifthsDistance(k, k)).toBe(0);
    }
  });

  it("adjacent keys are distance 1 (C↔G, C↔F)", () => {
    expect(circleOfFifthsDistance("C", "G")).toBe(1);
    expect(circleOfFifthsDistance("C", "F")).toBe(1);
  });

  it("tritone-apart keys are distance 6 (max distance on the circle)", () => {
    expect(circleOfFifthsDistance("C", "Gb")).toBe(6);
  });

  it("distance is symmetric: d(a,b) = d(b,a)", () => {
    for (const a of KEYS) {
      for (const b of KEYS) {
        expect(circleOfFifthsDistance(a, b)).toBe(circleOfFifthsDistance(b, a));
      }
    }
  });

  it("distance respects the shorter path around the circle (never exceeds 6)", () => {
    for (const a of KEYS) {
      for (const b of KEYS) {
        expect(circleOfFifthsDistance(a, b)).toBeLessThanOrEqual(6);
      }
    }
  });

  it("throws on unknown key", () => {
    expect(() => circleOfFifthsDistance("H" as never, "C")).toThrow();
  });
});

describe("adjacentKeys", () => {
  it("returns exactly the two neighbors on the circle", () => {
    const adj = adjacentKeys("C");
    expect(adj).toHaveLength(2);
    expect(new Set(adj)).toEqual(new Set(["G", "F"]));
  });

  it("wraps the circle (Gb borders B and Db)", () => {
    const adj = adjacentKeys("Gb");
    expect(new Set(adj)).toEqual(new Set(["B", "Db"]));
  });
});

describe("classifyModulation", () => {
  it("same key → stay", () => {
    expect(classifyModulation("C", "C")).toBe("stay");
  });

  it("adjacent key (distance 1) → lawful", () => {
    expect(classifyModulation("C", "G")).toBe("lawful");
    expect(classifyModulation("C", "F")).toBe("lawful");
  });

  it("tritone-apart (distance 6) → jarring", () => {
    expect(classifyModulation("C", "Gb")).toBe("jarring");
  });

  it("threshold is the MODULATION_THRESHOLD constant (1) by default", () => {
    expect(MODULATION_THRESHOLD).toBe(1);
    expect(classifyModulation("C", "D")).toBe("jarring");
  });

  it("relaxed threshold widens what counts as lawful", () => {
    expect(classifyModulation("C", "D", 2)).toBe("lawful");
    expect(classifyModulation("C", "A", 2)).toBe("jarring");
  });
});
