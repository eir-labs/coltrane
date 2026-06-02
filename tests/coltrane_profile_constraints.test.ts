// Spec §8: Coltrane's Own Profile + 11 Key Constraints
// TDD red phase — tests fail to compile until src/ implements the contract.
//
// Profile fixture per spec §8 table.
// Constraints per spec §8 "Key Constraints" bullet list (11 items).
//
// All assertions reference spec terms only; no metaphor.

import { describe, it, expect } from "vitest";

// Imports from src/ — these will fail until src/ implements the contract
import {
  ColtraneProfile,
  loadColtraneProfile,
  validateProfile,
  Constraint,
  resolveType,
  resolveTypeResult,
  estimateCost,
  designSession,
  designSessionResult,
  proactiveProposal,
  proposalApproval,
  agentPermissions,
  customerAccessGrant,
  credentialStore,
  standardExecution,
} from "../src";

// ============================================================================
// Profile shape (§8 table)
// ============================================================================

describe("§8 coltrane profile shape", () => {
  it("slug is exactly 'coltrane'", () => {
    const p = loadColtraneProfile();
    expect(p.slug).toBe("coltrane");
  });

  it("primitives are full chain in spec order", () => {
    const p = loadColtraneProfile();
    expect(p.primitives).toEqual(["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"]);
  });

  it("input_types match spec", () => {
    const p = loadColtraneProfile();
    expect(p.input_types).toEqual(["goal", "company-context", "execution-history"]);
  });

  it("output_types match spec (six)", () => {
    const p = loadColtraneProfile();
    expect(p.output_types).toEqual([
      "domain-type-definition",
      "agent-definition",
      "standard-definition",
      "execution-plan",
      "design-rationale",
      "improvement-proposal",
    ]);
  });

  it("domain is 'coltrane-meta'", () => {
    const p = loadColtraneProfile();
    expect(p.domain).toBe("coltrane-meta");
  });

  it("model_tier is 'premium'", () => {
    const p = loadColtraneProfile();
    expect(p.model_tier).toBe("premium");
  });

  it("max_tool_calls is 100", () => {
    const p = loadColtraneProfile();
    expect(p.max_tool_calls).toBe(100);
  });

  it("max_token_budget is $5.00", () => {
    const p = loadColtraneProfile();
    expect(p.max_token_budget).toBe(5.00);
  });
});

// ============================================================================
// Constraint 1: never execute a standard without presenting the design first
// (unless auto-approve is on)
// ============================================================================

describe("§8 constraint 1 — execute requires design presentation", () => {
  it("rejects standardExecution when design_presented=false and auto_approve=false", () => {
    const result = standardExecution({
      standard_slug: "x", design_presented: false, auto_approve: false,
    });
    expect(result.ok).toBe(false);
    expect(result.violation).toBe("design_not_presented");
  });

  it("accepts execution when design_presented=true", () => {
    const result = standardExecution({
      standard_slug: "x", design_presented: true, auto_approve: false,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts execution when auto_approve=true bypasses design check", () => {
    const result = standardExecution({
      standard_slug: "x", design_presented: false, auto_approve: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// Constraint 2: never create a new type if type_resolve scores existing >= 80
// ============================================================================

describe("§8 constraint 2 — type resolution threshold 80", () => {
  it("rejects type creation when resolver scores existing >= 80", () => {
    const r = resolveType({ candidate: "FooBar", existing: "foo-bar", score: 85 });
    expect(r.action).toBe("use_existing");
    expect(r.create_allowed).toBe(false);
  });

  it("allows type creation when no existing >= 80", () => {
    const r = resolveType({ candidate: "Novel", existing: null, score: 0 });
    expect(r.action).toBe("create");
    expect(r.create_allowed).toBe(true);
  });

  it("at exactly score=80, must use existing (>= is inclusive)", () => {
    const r = resolveType({ candidate: "X", existing: "x", score: 80 });
    expect(r.create_allowed).toBe(false);
  });

  it("at score=79, may create", () => {
    const r = resolveType({ candidate: "X", existing: "x", score: 79 });
    expect(r.create_allowed).toBe(true);
  });
});

// ============================================================================
// Constraint 3: never create agent with permissions exceeding requesting user
// ============================================================================

describe("§8 constraint 3 — agent permissions bounded by requesting user", () => {
  it("rejects agent creation when requested permissions exceed user grant", () => {
    const r = agentPermissions({
      requested: { write: true, deploy: true },
      requesting_user_grant: { write: true, deploy: false },
    });
    expect(r.ok).toBe(false);
    expect(r.exceeded).toContain("deploy");
  });

  it("accepts when requested permissions are subset of user grant", () => {
    const r = agentPermissions({
      requested: { write: false, deploy: false },
      requesting_user_grant: { write: true, deploy: true },
    });
    expect(r.ok).toBe(true);
  });
});

// ============================================================================
// Constraint 4: never touch customer code/data/infra without scoped permission
// ============================================================================

describe("§8 constraint 4 — scoped permission required for customer touch", () => {
  it("rejects when no AccessGrant exists for resource", () => {
    const r = customerAccessGrant({ resource: "repo:customer/x", scope: "src/" });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("no_grant");
  });

  it("rejects when AccessGrant scope does not cover requested path", () => {
    const r = customerAccessGrant({
      resource: "repo:customer/x",
      scope: "secrets/credentials",
      grant: { paths: ["src/**"], excluded_paths: ["secrets/**"] },
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("path_excluded");
  });

  it("accepts when scope falls within grant", () => {
    const r = customerAccessGrant({
      resource: "repo:customer/x",
      scope: "src/foo.ts",
      grant: { paths: ["src/**"], excluded_paths: [] },
    });
    expect(r.ok).toBe(true);
  });
});

// ============================================================================
// Constraint 5: always estimate cost; abort if estimate > budget
// ============================================================================

describe("§8 constraint 5 — cost estimation gating", () => {
  it("rejects execution when estimate exceeds budget", () => {
    const r = estimateCost({ estimated: 10.0, budget: 5.0 });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("budget_exceeded");
  });

  it("accepts execution when estimate is within budget", () => {
    const r = estimateCost({ estimated: 3.0, budget: 5.0 });
    expect(r.ok).toBe(true);
  });

  it("rejects when estimate is omitted (must always estimate)", () => {
    const r = estimateCost({ estimated: null, budget: 5.0 });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("no_estimate");
  });
});

// ============================================================================
// Constraint 6: max 10 new types per design session
// ============================================================================

describe("§8 constraint 6 — max 10 new types per session", () => {
  it("accepts session producing exactly 10 new types", () => {
    const r = designSession({ new_types_count: 10 });
    expect(r.ok).toBe(true);
  });

  it("rejects session producing 11 new types", () => {
    const r = designSession({ new_types_count: 11 });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("too_many_new_types");
  });
});

// ============================================================================
// Constraint 7: max 5 new agents per design session
// ============================================================================

describe("§8 constraint 7 — max 5 new agents per session", () => {
  it("accepts session producing exactly 5 new agents", () => {
    const r = designSession({ new_agents_count: 5 });
    expect(r.ok).toBe(true);
  });

  it("rejects session producing 6 new agents", () => {
    const r = designSession({ new_agents_count: 6 });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("too_many_new_agents");
  });
});

// ============================================================================
// Constraint 8: design-rationale output always included
// ============================================================================

describe("§8 constraint 8 — design-rationale required output", () => {
  it("rejects session result missing design-rationale", () => {
    const r = designSessionResult({
      outputs: ["agent-definition", "standard-definition"],
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("design_rationale_missing");
  });

  it("accepts session result including design-rationale", () => {
    const r = designSessionResult({
      outputs: ["agent-definition", "standard-definition", "design-rationale"],
    });
    expect(r.ok).toBe(true);
  });
});

// ============================================================================
// Constraint 9: never store customer credentials — TTL'd scoped tokens only
// ============================================================================

describe("§8 constraint 9 — credentials must be TTL'd scoped tokens", () => {
  it("rejects storing a raw customer credential", () => {
    const r = credentialStore({ kind: "raw_credential", value: "secret123" });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("credential_storage_forbidden");
  });

  it("accepts a scoped token with TTL", () => {
    const r = credentialStore({
      kind: "scoped_token", value: "tok_xyz", ttl_seconds: 3600, scope: "repo:read",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a scoped token without TTL", () => {
    const r = credentialStore({
      kind: "scoped_token", value: "tok_xyz", ttl_seconds: null, scope: "repo:read",
    });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("ttl_required");
  });
});

// ============================================================================
// Constraint 10: proactive proposals require >= 50 data points
// ============================================================================

describe("§8 constraint 10 — proactive proposals data-point floor", () => {
  it("rejects proposal with 49 supporting data points", () => {
    const r = proactiveProposal({ data_points: 49 });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("insufficient_evidence");
  });

  it("accepts proposal with exactly 50 supporting data points", () => {
    const r = proactiveProposal({ data_points: 50 });
    expect(r.ok).toBe(true);
  });
});

// ============================================================================
// Constraint 11: Coltrane can never approve its own proposals
// ============================================================================

describe("§8 constraint 11 — self-approval forbidden", () => {
  it("rejects approval when proposer == approver and both are coltrane", () => {
    const r = proposalApproval({ proposer: "coltrane", approver: "coltrane" });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("self_approval_forbidden");
  });

  it("accepts approval when proposer is coltrane and approver is human", () => {
    const r = proposalApproval({ proposer: "coltrane", approver: "human:eugene" });
    expect(r.ok).toBe(true);
  });

  it("rejects approval even when approver is coltrane:secondary-instance", () => {
    const r = proposalApproval({ proposer: "coltrane", approver: "coltrane:secondary" });
    expect(r.ok).toBe(false);
    expect(r.violation).toBe("self_approval_forbidden");
  });
});

// ============================================================================
// Integration: full profile validation
// ============================================================================

describe("§8 integration — validateProfile composite check", () => {
  it("returns ok=true on canonical coltrane profile", () => {
    const p = loadColtraneProfile();
    const r = validateProfile(p);
    expect(r.ok).toBe(true);
  });

  it("returns ok=false if any constraint violation is present in fixture", () => {
    const p = { ...loadColtraneProfile(), max_token_budget: -1 };
    const r = validateProfile(p);
    expect(r.ok).toBe(false);
  });
});
