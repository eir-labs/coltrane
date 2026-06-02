import { describe, it, expect } from "vitest";
import { JUST_RATIOS, ratioCents, temperedCents, comma, ratioConsonance, nearestJust } from "../src/acoustics.js";

describe("just intonation cents", () => {
  it("octave = 1200 cents", () => expect(ratioCents(JUST_RATIOS["octave"]!)).toBeCloseTo(1200, 5));
  it("just fifth ≈ 701.96 cents", () => expect(ratioCents(JUST_RATIOS["perfect5"]!)).toBeCloseTo(701.955, 2));
  it("just major third ≈ 386.31 cents", () => expect(ratioCents(JUST_RATIOS["major3"]!)).toBeCloseTo(386.314, 2));
});

describe("the comma — just minus tempered", () => {
  it("tempered fifth is exactly 700", () => expect(temperedCents(7)).toBe(700));
  it("just fifth sits ~+2 cents sharp of tempered", () => expect(comma("perfect5")).toBeCloseTo(1.955, 2));
  it("just major third is ~-13.7 cents — the syntonic comma equal-temperament spends", () =>
    expect(comma("major3")).toBeCloseTo(-13.686, 2));
});

describe("ratio consonance — a feature number, never a verdict", () => {
  it("orders octave > fifth > major3 > tritone", () => {
    const oct = ratioConsonance(JUST_RATIOS["octave"]!);
    const fifth = ratioConsonance(JUST_RATIOS["perfect5"]!);
    const third = ratioConsonance(JUST_RATIOS["major3"]!);
    const tt = ratioConsonance(JUST_RATIOS["tritone"]!);
    expect(typeof oct).toBe("number");
    expect(oct).toBeGreaterThan(fifth);
    expect(fifth).toBeGreaterThan(third);
    expect(third).toBeGreaterThan(tt);
  });
});

describe("microtonal — continuous, not snapped to 12", () => {
  it("700 cents reads nearest-just perfect5 with ~-2c deviation (the tempering)", () => {
    const r = nearestJust(700);
    expect(r.interval).toBe("perfect5");
    expect(r.deviationCents).toBeCloseTo(-1.955, 2);
  });
  it("a microtonal 705 cents keeps its deviation, not snapped", () => {
    expect(nearestJust(705).deviationCents).toBeCloseTo(3.045, 2);
  });
});
