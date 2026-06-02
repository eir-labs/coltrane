import { describe, it, expect } from "vitest";
import {
  buildPath,
  composeVoices,
  voiceCountAtPhase,
  tonicDensity,
  densityProfile,
  maxDissonanceAtPhase,
  PolyphonyError,
  type Voice,
} from "../src";

function voice(slug: string, steps: { phase: string; key: "C" | "G" | "D" | "A" | "E" | "B" | "Gb" | "Db" | "Ab" | "Eb" | "Bb" | "F" }[]): Voice {
  return { agent_slug: slug, path: buildPath(steps) };
}

describe("composeVoices", () => {
  it("rejects zero voices", () => {
    expect(() => composeVoices([])).toThrow(PolyphonyError);
  });

  it("single voice yields a monotonic chord at every phase the voice plays", () => {
    const p = composeVoices([
      voice("solo", [
        { phase: "a", key: "C" },
        { phase: "b", key: "G" },
      ]),
    ]);
    expect(p.chords).toHaveLength(2);
    expect(tonicDensity(p, "a")).toBe("monotonic");
    expect(voiceCountAtPhase(p, "a")).toBe(1);
  });

  it("two voices in the same phase yield bitonic chord", () => {
    const p = composeVoices([
      voice("v1", [{ phase: "a", key: "C" }]),
      voice("v2", [{ phase: "a", key: "G" }]),
    ]);
    expect(tonicDensity(p, "a")).toBe("bitonic");
    expect(voiceCountAtPhase(p, "a")).toBe(2);
  });
});

describe("tonic-density names match Eugene's morning spec", () => {
  it.each([
    [1, "monotonic"],
    [2, "bitonic"],
    [3, "tritonic"],
    [4, "tetratonic"],
    [5, "pentatonic"],
    [6, "hexatonic"],
    [7, "polyphonic"],
    [12, "polyphonic"],
  ] as const)("%i voices at a phase → %s", (n, expected) => {
    const voices = Array.from({ length: n }, (_, i) =>
      voice(`v${i}`, [{ phase: "a", key: "C" }]),
    );
    const p = composeVoices(voices);
    expect(tonicDensity(p, "a")).toBe(expected);
  });

  it("zero voices at a phase → silence", () => {
    const p = composeVoices([voice("v1", [{ phase: "a", key: "C" }])]);
    expect(tonicDensity(p, "ghost-phase")).toBe("silence");
  });
});

describe("pairwise distances preserved (no scalar collapse)", () => {
  it("returns the full pairwise array, not a single 'consonance score'", () => {
    const p = composeVoices([
      voice("v1", [{ phase: "a", key: "C" }]),
      voice("v2", [{ phase: "a", key: "G" }]),
      voice("v3", [{ phase: "a", key: "D" }]),
    ]);
    const chord = p.chords.find((c) => c.phase === "a")!;
    expect(chord.pairwise).toHaveLength(3); // C-G, C-D, G-D
    for (const pair of chord.pairwise) {
      expect(typeof pair.distance).toBe("number");
    }
  });

  it("maxDissonanceAtPhase surfaces the worst-distance pair (feature, not verdict)", () => {
    const p = composeVoices([
      voice("v1", [{ phase: "a", key: "C" }]),
      voice("v2", [{ phase: "a", key: "Gb" }]), // tritone
    ]);
    expect(maxDissonanceAtPhase(p, "a")).toBe(6);
  });

  it("max dissonance is 0 when only one voice plays", () => {
    const p = composeVoices([voice("v1", [{ phase: "a", key: "C" }])]);
    expect(maxDissonanceAtPhase(p, "a")).toBe(0);
  });
});

describe("densityProfile — per-phase tensor channel", () => {
  it("returns one entry per phase touched by any voice", () => {
    const p = composeVoices([
      voice("v1", [{ phase: "a", key: "C" }, { phase: "b", key: "G" }]),
      voice("v2", [{ phase: "b", key: "D" }, { phase: "c", key: "A" }]),
    ]);
    const profile = densityProfile(p);
    expect(profile.map((x) => x.phase)).toEqual(["a", "b", "c"]);
    expect(profile.find((x) => x.phase === "a")!.density).toBe("monotonic");
    expect(profile.find((x) => x.phase === "b")!.density).toBe("bitonic");
    expect(profile.find((x) => x.phase === "c")!.density).toBe("monotonic");
  });
});
