// A6 — recorder catches writes outside the declared scope.
// The recorder validates each post-write file-set against the AccessGrant.scope;
// any file outside scope or hitting an excluded path is flagged.
import { describe, it, expect } from "vitest";
import { validatePlanAgainstGrant, type AccessGrant } from "../src";

const grant: AccessGrant = {
  id: "g-1",
  company_id: "acme",
  resource_type: "repo",
  resource_uri: "github.com/acme/web",
  permissions: { read: true, write: true, execute: false, deploy: false },
  scope: {
    branches: ["fix/*"],
    paths: ["src/**", "tests/**"],
    excluded_paths: [".env", "secrets/**"],
    max_files_per_patch: 10,
    max_lines_per_patch: 500,
  },
  expires_at: "2099-01-01T00:00:00Z",
  requires_pr: true,
  requires_human_review: true,
  auto_revert_on_failure: true,
};

describe("A6 — recorder catches out-of-scope writes", () => {
  it("clean write: all files inside grant scope → passes", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/x.ts", "tests/api/x.test.ts"], lines_changed: 50 },
      grant,
    );
    expect(r.valid).toBe(true);
  });

  it("write hitting an excluded path (.env) → FLAGGED", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/x.ts", ".env"], lines_changed: 10 },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/excluded|env/i);
  });

  it("write in secrets/** subtree → FLAGGED via glob", () => {
    const r = validatePlanAgainstGrant(
      { files: ["secrets/aws.json"], lines_changed: 1 },
      grant,
    );
    expect(r.valid).toBe(false);
  });

  it("write outside scope paths (infra/, vendor/, etc) → FLAGGED", () => {
    for (const f of ["infra/terraform/main.tf", "vendor/lib.js", "README.md"]) {
      const r = validatePlanAgainstGrant({ files: [f], lines_changed: 5 }, grant);
      expect(r.valid, `${f} should be rejected`).toBe(false);
    }
  });

  it("write exceeding max_lines_per_patch → FLAGGED", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/big.ts"], lines_changed: 10_000 },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/max_lines/i);
  });

  it("write exceeding max_files_per_patch → FLAGGED", () => {
    const r = validatePlanAgainstGrant(
      {
        files: Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`),
        lines_changed: 100,
      },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/max_files/i);
  });

  it("structural enforcement: violation surfaces a reason string, never silently passes", () => {
    const r = validatePlanAgainstGrant(
      { files: ["nope/x.ts"], lines_changed: 1 },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason!.length).toBeGreaterThan(0);
  });
});
