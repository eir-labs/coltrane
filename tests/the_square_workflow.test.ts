import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The square — the open review venue (WO-002, Art. I). On every merge to main
// the venue dispatches square-review-v0 over the landed change-set and seals
// the verdict in daylight, under its own name. This spec pins the venue's
// constitution: it exists, it dispatches the review law and nothing else, it
// holds no credential beyond one spend-capped model key and the ephemeral
// Actions token, and it stays silent-but-honest before it is commissioned.

const ROOT = join(__dirname, "..");
const WF = join(ROOT, ".github", "workflows", "the-square.yml");

describe("the square: the open review venue", () => {
  it("the venue workflow exists", () => {
    expect(existsSync(WF)).toBe(true);
  });

  const yml = () => readFileSync(WF, "utf8");

  it("runs on the merge event (push to main) and by hand, nothing else", () => {
    const w = yml();
    expect(w).toMatch(/push:/);
    expect(w).toMatch(/branches:\s*\[main\]/);
    expect(w).toMatch(/workflow_dispatch:/);
    expect(w).not.toMatch(/pull_request/);
    expect(w).not.toMatch(/schedule:/);
  });

  it("dispatches square-review-v0 — the review law already in the genome", () => {
    expect(yml()).toMatch(/dispatch square-review-v0/);
  });

  it("speaks under its own name and may only write checks", () => {
    const w = yml();
    expect(w).toMatch(/name: the square/);
    expect(w).toMatch(/contents: read/);
    expect(w).toMatch(/checks: write/);
    expect(w).not.toMatch(/contents: write/);
  });

  it("holds exactly one named credential class: the spend-capped model key", () => {
    const w = yml();
    expect(w).toMatch(/SQUARE_ANTHROPIC_API_KEY/);
    // No other secret reference may appear — the prohibition on production-data
    // credentials in GitHub secrets is unrelaxed.
    const secretRefs = [...w.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secretRefs)).toEqual(new Set(["SQUARE_ANTHROPIC_API_KEY"]));
  });

  it("awaits its commissioning honestly: no key, no review, no failure", () => {
    const w = yml();
    expect(w).toMatch(/awaits its commissioning/);
    expect(w).toMatch(/commissioned/);
  });

  it("its hands exist: the input composer and the verdict sealer", () => {
    expect(existsSync(join(ROOT, "scripts", "the-square-input.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "the-square-verdict.mjs"))).toBe(true);
  });
});
