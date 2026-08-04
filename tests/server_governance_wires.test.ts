// The remaining NEEDS_RUNTIME tools wired against impl that already exists in-repo
// (defineAgent, proposeAgentChange, checkGrantTTL/validatePlanAgainstGrant, the
// ledger-as-proposal-store pattern, and derivations over registry+outputs+ledger).
// No invented store. Big step, big test: every wired tool is exercised through the
// real MCP router (dispatchTool), asserting it's NOT a stub (not_implemented falsy).

import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { AgentProfile } from "../src/agent_profile.js";
import type { AccessGrant } from "../src/access_grant.js";

const findingType: DomainType = {
  slug: "finding", extends: "Judgment", domain: "eirtests",
  schema: { type: "object", properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(findingType);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

const baseProfile: AgentProfile = {
  slug: "analyst", version: 1, status: "active",
  primitives: ["INTERPRET"], input_types: ["page-model"], output_types: ["finding"],
  domain: "eirtests", identity: "you analyze", method: "look for patterns", constraints: [],
  depth_profile: "standard",
  permissions: { allowed_tools: [], disallowed_tools: [], model_tier: "standard", max_tool_calls: 10, max_token_budget: 10000, can_write_outputs: true, can_trigger_standards: false },
};

const grant: AccessGrant = {
  id: "grant-1", company_id: "co-1", resource_type: "repo", resource_uri: "github.com/x/y",
  permissions: { read: true, write: true, execute: false, deploy: false },
  scope: { branches: ["main"], paths: ["src/**"], excluded_paths: [".env"], max_files_per_patch: 5, max_lines_per_patch: 200 },
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  requires_pr: true, requires_human_review: true, auto_revert_on_failure: true,
};

describe("agent_define", () => {
  it("validates + constructs an agent through the router", async () => {
    const r = await dispatchTool("agent_define", { slug: "scout", primitives: ["SENSE"], output_types: ["page-model"], domain: "eirtests", identity: "you scan the site", method: "crawl and record page-models", constraints: [], behavioral_primitives: ["explorer", "analyst"] }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect((r.data as { agent: { slug: string } }).agent.slug).toBe("scout");
  });

  it("rejects an illegal primitive progression (CREATE with no upstream INTERPRET/PLAN)", async () => {
    const r = await dispatchTool("agent_define", { slug: "bad", primitives: ["SENSE", "CREATE"] }, makeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/upstream/);
  });
});

describe("agent_evolve", () => {
  it("classifies a permissions change as approval-required", async () => {
    const next = { ...baseProfile, permissions: { ...baseProfile.permissions, model_tier: "premium" as const } };
    const r = await dispatchTool("agent_evolve", { base: baseProfile, next }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect((r.data as { space: string }).space).toBe("permissions");
    expect(r.requires_approval).toBe(true);
  });

  it("classifies a creative-only change as no-approval", async () => {
    const next = { ...baseProfile, identity: "you analyze deeply" };
    const r = await dispatchTool("agent_evolve", { base: baseProfile, next }, makeDeps());
    expect((r.data as { space: string }).space).toBe("creative");
    expect(r.requires_approval).toBe(false);
  });
});

describe("access_grant_check", () => {
  it("reports a live grant valid", async () => {
    const r = await dispatchTool("access_grant_check", { grant }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect((r.data as { valid: boolean }).valid).toBe(true);
  });

  it("reports an expired grant invalid", async () => {
    const expired = { ...grant, expires_at: new Date(Date.now() - 1000).toISOString() };
    const r = await dispatchTool("access_grant_check", { grant: expired }, makeDeps());
    expect((r.data as { valid: boolean }).valid).toBe(false);
  });

  it("fails a plan that exceeds the grant scope", async () => {
    const r = await dispatchTool("access_grant_check", { grant, plan: { files: ["docs/x.md"], lines_changed: 10 } }, makeDeps());
    expect((r.data as { valid: boolean }).valid).toBe(false); // docs/ is outside src/**
  });
});

describe("proposal tools (ledger-backed)", () => {
  it("proposal_create records a proposal + surfaces approval for a permissions target", async () => {
    const d = makeDeps();
    const r = await dispatchTool("proposal_create", { change_type: "agent_retire", target: "analyst", target_kind: "permissions", reason: "superseded" }, d);
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect(r.requires_approval).toBe(true); // permissions-target proposals need sign-off
    expect(typeof (r.data as { proposal_id: string }).proposal_id).toBe("string");
    expect(d.ledger.query().length).toBe(1); // recorded in the ledger
  });

  it("tool_propose returns a proposal_id + requires approval", async () => {
    const r = await dispatchTool("tool_propose", { slug: "new_tool", type: "mcp", spec: {}, reason: "need it" }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.requires_approval).toBe(true);
    expect(typeof (r.data as { proposal_id: string }).proposal_id).toBe("string");
  });

  it("tool_deprecate_propose returns a proposal_id + requires approval", async () => {
    const r = await dispatchTool("tool_deprecate_propose", { slug: "old_tool", reason: "unused" }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.requires_approval).toBe(true);
    expect(typeof (r.data as { proposal_id: string }).proposal_id).toBe("string");
  });
});

describe("system_audit / system_health / health_check (derived over the stores)", () => {
  it("system_health reports live counts", async () => {
    const d = makeDeps();
    await dispatchTool("output_write", { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "a", data: { title: "x" } }, d);
    const r = await dispatchTool("system_health", {}, d);
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { types: number; outputs: number };
    expect(data.types).toBe(1);
    expect(data.outputs).toBe(1);
  });

  it("system_audit flags a registered-but-unused type", async () => {
    const r = await dispatchTool("system_audit", {}, makeDeps());
    expect(r.ok).toBe(true);
    const data = r.data as { unused_types: string[] };
    expect(data.unused_types).toContain("finding"); // registered, no outputs yet
  });

  it("health_check counts an agent's outputs", async () => {
    const d = makeDeps();
    await dispatchTool("output_write", { core_type: "Judgment", domain_type: "finding", domain: "eirtests", gig_id: "g1", agent_slug: "analyst", data: { title: "x" } }, d);
    const r = await dispatchTool("health_check", { slug: "analyst", kind: "agent" }, d);
    expect(r.ok).toBe(true);
    expect((r.data as { output_count: number }).output_count).toBe(1);
  });
});

describe("gig_abort (honest v0 semantics — synchronous gigs)", () => {
  it("reports already_complete for a gig with a ledger entry", async () => {
    const d = makeDeps();
    // Gig row in the settled #212 shape (64-hex identity, ISO timestamps, kind discriminator).
    d.ledger.append({
      kind: "gig", schema_version: 2, entry_id: "g1", gig_id: "g1", standard_slug: "scan",
      genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64), output_hashes: [],
      started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
    } as never);
    const r = await dispatchTool("gig_abort", { gig_id: "g1" }, d);
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    expect((r.data as { status: string }).status).toBe("already_complete");
  });

  it("reports not_found for an unknown gig", async () => {
    const r = await dispatchTool("gig_abort", { gig_id: "ghost" }, makeDeps());
    expect((r.data as { status: string }).status).toBe("not_found");
  });
});

describe("capability_research (real local gap-search over the genome)", () => {
  it("finds existing tool matches for a known capability", async () => {
    const r = await dispatchTool("capability_research", { query: "type" }, makeDeps());
    expect(r.ok).toBe(true);
    expect(r.not_implemented).toBeFalsy();
    const data = r.data as { existing_matches: string[]; gap: boolean };
    expect(data.existing_matches.length).toBeGreaterThan(0); // type_register/type_browse/...
    expect(data.gap).toBe(false);
  });

  it("reports a gap for an unmatched capability", async () => {
    const r = await dispatchTool("capability_research", { query: "quantum_teleport_xyzzy" }, makeDeps());
    expect((r.data as { gap: boolean }).gap).toBe(true);
  });
});
