import { describe, it, expect } from "vitest";
import {
  validatePlanAgainstGrant,
  exposedTools,
  type AccessGrant,
  type Phase,
} from "../src";

const grant: AccessGrant = {
  id: "g-1",
  company_id: "acme",
  resource_type: "repo",
  resource_uri: "github.com/acme/web",
  permissions: { read: true, write: true, execute: false, deploy: false },
  scope: {
    branches: ["fix/*", "eir/*"],
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

describe("Plan validation against AccessGrant", () => {
  it("accepts a plan whose files are inside the scoped paths", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/auth.ts", "tests/api/auth.test.ts"], lines_changed: 120 },
      grant,
    );
    expect(r.valid).toBe(true);
  });

  it("rejects a plan that touches an excluded path", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/auth.ts", ".env"], lines_changed: 30 },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/excluded/i);
  });

  it("rejects a plan that touches a path outside the scope", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/auth.ts", "infra/terraform/main.tf"], lines_changed: 40 },
      grant,
    );
    expect(r.valid).toBe(false);
  });

  it("rejects a plan exceeding max_files_per_patch", () => {
    const files = Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`);
    const r = validatePlanAgainstGrant({ files, lines_changed: 100 }, grant);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/max_files/i);
  });

  it("rejects a plan exceeding max_lines_per_patch", () => {
    const r = validatePlanAgainstGrant(
      { files: ["src/api/auth.ts"], lines_changed: 600 },
      grant,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/max_lines/i);
  });
});

describe("Phase-based tool exposure", () => {
  const agentAllowed = ["url_scan", "file_read", "file_write", "shell_exec"];

  it("during SENSE: only read tools exposed", () => {
    const r = exposedTools({ phase: "SENSE" satisfies Phase, agent_allowed: agentAllowed, grant });
    expect(r).not.toContain("file_write");
    expect(r).not.toContain("shell_exec");
    expect(r).toContain("url_scan");
  });

  it("during CREATE: write tools exposed only within scoped paths", () => {
    const r = exposedTools({ phase: "CREATE" satisfies Phase, agent_allowed: agentAllowed, grant });
    expect(r).toContain("file_write");
  });

  it("deploy tools are never exposed unless grant.permissions.deploy", () => {
    const r = exposedTools({
      phase: "CREATE" satisfies Phase,
      agent_allowed: [...agentAllowed, "deploy"],
      grant,
    });
    expect(r).not.toContain("deploy");
  });

  it("intersection of agent.allowed_tools AND grant.permissions AND phase rules", () => {
    const r = exposedTools({
      phase: "SENSE" satisfies Phase,
      agent_allowed: ["file_read"],
      grant: { ...grant, permissions: { ...grant.permissions, read: false } },
    });
    expect(r).not.toContain("file_read");
  });
});
