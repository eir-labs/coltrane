import { describe, it, expect } from "vitest";
import { songChannel, coupling, channelCoupling } from "../src/harmonic_validation.js";

describe("song channel — a tensor, not a verdict", () => {
  it("reads the song as a vector, never collapsing to a scalar", () => {
    expect(songChannel({ resolution: 0.9, tonic: 0, density: 3 })).toEqual([0.9, 0, 3]);
  });
});

describe("cross-channel coupling — the signal is coupling, never a verdict", () => {
  it("coupled channels read high coupling", () => {
    expect(coupling([1, 0, 1], [1, 0, 1])).toBeCloseTo(1, 5);
  });

  it("decoupled channels read low coupling (the illusion signature)", () => {
    expect(coupling([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it("preserves the full pairwise structure across three channels — no collapse to one truth", () => {
    const struct = channelCoupling({ score: [1, 0, 1], output: [1, 0, 1], song: [0, 1, 0] });
    expect(struct.length).toBe(3); // every pair preserved
    const songPairs = struct.filter((p) => p.pair.includes("song"));
    expect(songPairs.every((p) => p.coupling < 0.5)).toBe(true); // song decouples = illusion, surfaced not hidden
    const scoreOutput = struct.find((p) => p.pair.includes("score") && p.pair.includes("output"));
    expect(scoreOutput!.coupling).toBeCloseTo(1, 5); // the other two stay coupled
  });
});
