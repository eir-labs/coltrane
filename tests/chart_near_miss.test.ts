// ux/12a-sketch-bugs (C) — an error that knows the answer.
//
// A movement keyed `id` instead of `movement_id` was refused with a raw Zod dump: two unrelated
// lines — "Required: movements,0,movement_id" and "Unrecognized key(s) in object: 'id'" — leaving a
// human to reconcile them. The schema already knows the expected key. This law keeps the refusal
// (the movement is STILL rejected — nothing accepted is widened) and requires the R0 detail to name
// the near-miss: that the unrecognized key `id` is the near-miss for the required key `movement_id`.
import { describe, it, expect } from "vitest";
import { composeChart, type ChartViolation } from "../src/chart.js";
import type { Standard } from "../src/composition.js";

const noStandards = (): ReadonlyMap<string, Standard> => new Map();

describe("composeChart R0 names a near-miss key (ux/12a C)", () => {
  it("a movement keyed `id` is STILL refused, and the detail names `movement_id` as the intended key", () => {
    const c = composeChart({
      // `id` where `movement_id` is required — the reported near-miss.
      chart: { slug: "near", movements: [{ id: "m0", standard_slug: "s" }] } as never,
      standards: noStandards(),
    });

    // Still refused — R0 fires exactly as before; the movement is not accepted.
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect([...new Set(c.violations.map((v: ChartViolation) => v.rule))]).toEqual(["R0"]);

    // The detail LINKS the two keys — not merely that `movement_id` appears somewhere in a raw dump.
    const detail = c.violations[0]!.detail;
    expect(detail).toContain("movement_id");
    expect(detail).toContain('"id"');
    expect(detail).toMatch(/near-miss|did you mean/i);
    // And the phrasing puts the unrecognized key together with the required one it resembles.
    expect(detail).toMatch(/"id"[\s\S]*movement_id|movement_id[\s\S]*"id"/);
  });

  it("a wholly-unrelated unrecognized key is NOT dressed up as a near-miss", () => {
    const c = composeChart({
      chart: { slug: "junk", movements: [{ movement_id: "m0", standard_slug: "s", nope: 1 }] } as never,
      standards: noStandards(),
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect([...new Set(c.violations.map((v: ChartViolation) => v.rule))]).toEqual(["R0"]);
    // `nope` is not a suffix of any required key, so no near-miss phrasing is invented.
    expect(c.violations[0]!.detail).not.toMatch(/near-miss|did you mean/i);
  });
});
