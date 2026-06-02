import { describe, it, expect } from "vitest";
import { checkGrantTTL } from "../src";
import type { AccessGrant } from "../src";

const baseGrant: Omit<AccessGrant, "expires_at"> = {
  id: "g-1",
  company_id: "acme",
  resource_type: "repo",
  resource_uri: "github.com/acme/web",
  permissions: { read: true, write: true, execute: false, deploy: false },
  scope: {
    branches: ["fix/*"],
    paths: ["src/**"],
    excluded_paths: [".env"],
    max_files_per_patch: 10,
    max_lines_per_patch: 500,
  },
  requires_pr: true,
  requires_human_review: true,
  auto_revert_on_failure: true,
};

const NOW = new Date("2026-05-25T18:25:00Z").getTime();

describe("A5 — AccessGrant TTL enforcement", () => {
  it("blocks execution when the grant has expired", () => {
    const grant: AccessGrant = { ...baseGrant, expires_at: "2026-05-25T18:24:59Z" };
    const r = checkGrantTTL(grant, NOW);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expir/i);
  });

  it("allows execution when the grant is still active", () => {
    const grant: AccessGrant = { ...baseGrant, expires_at: "2099-01-01T00:00:00Z" };
    const r = checkGrantTTL(grant, NOW);
    expect(r.valid).toBe(true);
  });

  it("blocks execution at the exact expiry moment", () => {
    const grant: AccessGrant = { ...baseGrant, expires_at: "2026-05-25T18:25:00Z" };
    const r = checkGrantTTL(grant, NOW);
    expect(r.valid).toBe(false);
  });

  it("reports remaining time when active", () => {
    const grant: AccessGrant = { ...baseGrant, expires_at: "2026-05-25T19:25:00Z" };
    const r = checkGrantTTL(grant, NOW);
    expect(r.valid).toBe(true);
    expect(r.remaining_ms).toBe(60 * 60 * 1000);
  });
});
