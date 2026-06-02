import { describe, it, expect } from "vitest";
import {
  buildPath,
  ModulationPathError,
  isLawful,
  jarringCount,
  totalTravel,
  returnsHome,
} from "../src";

describe("buildPath", () => {
  it("rejects empty step list", () => {
    expect(() => buildPath([])).toThrow(ModulationPathError);
  });

  it("single-step path has no transitions", () => {
    const p = buildPath([{ phase: "sense", key: "C" }]);
    expect(p.transitions).toHaveLength(0);
    expect(p.starts_in).toBe("C");
    expect(p.ends_in).toBe("C");
  });

  it("computes transitions with distance + kind for each phase pair", () => {
    const p = buildPath([
      { phase: "sense", key: "C" },
      { phase: "interpret", key: "G" },
      { phase: "judge", key: "D" },
    ]);
    expect(p.transitions).toHaveLength(2);
    expect(p.transitions[0]).toMatchObject({
      from_key: "C", to_key: "G", distance: 1, kind: "lawful",
    });
    expect(p.transitions[1]).toMatchObject({
      from_key: "G", to_key: "D", distance: 1, kind: "lawful",
    });
  });
});

describe("isLawful — lawful-only filter", () => {
  it("true when every transition is stay or lawful", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
      { phase: "c", key: "G" },
      { phase: "d", key: "D" },
    ]);
    expect(isLawful(p)).toBe(true);
  });

  it("false on any jarring transition", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "Gb" },
    ]);
    expect(isLawful(p)).toBe(false);
  });
});

describe("jarringCount — feature, not verdict", () => {
  it("returns a number reflecting how many jarring jumps occurred", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "Gb" },
      { phase: "c", key: "D" },
      { phase: "d", key: "Ab" },
    ]);
    expect(jarringCount(p)).toBe(3);
  });

  it("zero on a fully lawful path", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
      { phase: "c", key: "D" },
    ]);
    expect(jarringCount(p)).toBe(0);
  });
});

describe("totalTravel — sum of distances", () => {
  it("zero for a single-step path", () => {
    expect(totalTravel(buildPath([{ phase: "a", key: "C" }]))).toBe(0);
  });

  it("sums circle-of-fifths distances across transitions", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
      { phase: "c", key: "D" },
    ]);
    expect(totalTravel(p)).toBe(2);
  });
});

describe("returnsHome — cadence-shaped", () => {
  it("true when starts_in === ends_in", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
      { phase: "c", key: "C" },
    ]);
    expect(returnsHome(p)).toBe(true);
  });

  it("false when path ends in a different key", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
    ]);
    expect(returnsHome(p)).toBe(false);
  });
});

describe("path preserves rather than collapses", () => {
  it("the path object itself is the tensor row — full sequence + transitions both retained", () => {
    const p = buildPath([
      { phase: "a", key: "C" },
      { phase: "b", key: "G" },
    ]);
    expect(p.steps.length).toBe(2);
    expect(p.transitions.length).toBe(1);
  });

  it("multiple channels can be combined externally; this module returns ONE channel's read in full", () => {
    const p = buildPath([{ phase: "a", key: "C" }, { phase: "b", key: "G" }]);
    expect(p).toHaveProperty("steps");
    expect(p).toHaveProperty("transitions");
    expect(p).toHaveProperty("starts_in");
    expect(p).toHaveProperty("ends_in");
  });
});
