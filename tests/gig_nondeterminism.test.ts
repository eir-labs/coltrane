import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as coltrane from "../src";

describe("gig non-determinism", () => {
  it("exposes no api asserting a standard re-run reproduces its outputs", () => {
    const api = coltrane as Record<string, unknown>;
    expect(api.assertGigReproducible).toBeUndefined();
    expect(api.behaviorHash).toBeUndefined();
  });

  it("advertises no reproducible or deterministic output", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { description?: string };
    const desc = (pkg.description ?? "").toLowerCase();
    for (const claim of ["reproducible", "deterministic output", "guaranteed output"]) {
      expect(desc).not.toContain(claim);
    }
  });
});
