import { describe, it, expect } from "vitest";
import { standardSimulate } from "../src";

const standard = {
  slug: "readiness-scan",
  version: 3,
  domain: "eirtests",
  phases: [
    { name: "sense", agent: "site-fetcher", primitives: ["SENSE"] as const },
    { name: "interpret", agent: "trust-analyst", primitives: ["INTERPRET", "JUDGE"] as const },
    { name: "report", agent: "reporter", primitives: ["CREATE"] as const },
  ],
};

describe("P6 — standard_simulate cost estimate accuracy", () => {
  it("estimate is within ±20% of actual on a known fixture", () => {
    const sim = standardSimulate({
      standard_slug: standard.slug,
      mock_input: { url: "https://example.com" },
      depth: "standard",
    });
    const actual_cost_usd = 0.95;
    const delta = Math.abs(sim.estimated_cost - actual_cost_usd) / actual_cost_usd;
    expect(delta).toBeLessThanOrEqual(0.2);
  });

  it("estimate scales linearly with depth multiplier (skim=0.5, standard=1.0, deep=2.0)", () => {
    const skim = standardSimulate({ standard_slug: standard.slug, mock_input: {}, depth: "skim" });
    const std = standardSimulate({ standard_slug: standard.slug, mock_input: {}, depth: "standard" });
    const deep = standardSimulate({ standard_slug: standard.slug, mock_input: {}, depth: "deep" });

    const ratio_skim_std = skim.estimated_cost / std.estimated_cost;
    const ratio_deep_std = deep.estimated_cost / std.estimated_cost;

    expect(ratio_skim_std).toBeCloseTo(0.5, 1);
    expect(ratio_deep_std).toBeCloseTo(2.0, 1);
  });

  it("returns phases[], estimated_cost, estimated_duration", () => {
    const sim = standardSimulate({ standard_slug: standard.slug, mock_input: {}, depth: "standard" });
    expect(sim.phases.length).toBe(standard.phases.length);
    expect(typeof sim.estimated_cost).toBe("number");
    expect(typeof sim.estimated_duration_ms).toBe("number");
    expect(sim.estimated_cost).toBeGreaterThan(0);
    expect(sim.estimated_duration_ms).toBeGreaterThan(0);
  });
});
