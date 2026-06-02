// §8 — Coltrane's Own Profile + 11 Key Constraints (impl for tests/coltrane_profile_constraints.test.ts).

import type { Primitive } from "./core_types.js";

// ----------------------------------------------------------------------------
// Profile shape (§8 table)
// ----------------------------------------------------------------------------

export interface ColtraneProfile {
  slug: "coltrane";
  primitives: Primitive[];
  input_types: string[];
  output_types: string[];
  domain: "coltrane-meta";
  model_tier: "premium";
  max_tool_calls: number;
  max_token_budget: number;
}

const CANONICAL: ColtraneProfile = {
  slug: "coltrane",
  primitives: ["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"],
  input_types: ["goal", "company-context", "execution-history"],
  output_types: [
    "domain-type-definition",
    "agent-definition",
    "standard-definition",
    "execution-plan",
    "design-rationale",
    "improvement-proposal",
  ],
  domain: "coltrane-meta",
  model_tier: "premium",
  max_tool_calls: 100,
  max_token_budget: 5.0,
};

export function loadColtraneProfile(): ColtraneProfile {
  return { ...CANONICAL };
}

export interface ProfileValidationResult {
  ok: boolean;
  violations: string[];
}

export function validateProfile(p: ColtraneProfile): ProfileValidationResult {
  const violations: string[] = [];
  if (p.slug !== "coltrane") violations.push("slug_invalid");
  if (p.domain !== "coltrane-meta") violations.push("domain_invalid");
  if (p.model_tier !== "premium") violations.push("model_tier_invalid");
  if (!(p.max_tool_calls > 0)) violations.push("max_tool_calls_invalid");
  if (!(p.max_token_budget > 0)) violations.push("max_token_budget_invalid");
  if (p.primitives.length !== 6) violations.push("primitives_count_invalid");
  return { ok: violations.length === 0, violations };
}

// ----------------------------------------------------------------------------
// Constraint result shape
// ----------------------------------------------------------------------------

export type Constraint =
  | "design_not_presented"
  | "type_resolver_score_exceeds_threshold"
  | "agent_permissions_exceed_user"
  | "no_grant"
  | "path_excluded"
  | "budget_exceeded"
  | "no_estimate"
  | "too_many_new_types"
  | "too_many_new_agents"
  | "design_rationale_missing"
  | "credential_storage_forbidden"
  | "ttl_required"
  | "insufficient_evidence"
  | "self_approval_forbidden";

export interface ConstraintResult {
  ok: boolean;
  violation?: Constraint;
}

// ----------------------------------------------------------------------------
// Constraint 1: standard execution requires design presented or auto_approve
// ----------------------------------------------------------------------------

export interface StandardExecutionInput {
  standard_slug: string;
  design_presented: boolean;
  auto_approve: boolean;
}

export function standardExecution(input: StandardExecutionInput): ConstraintResult {
  if (input.design_presented || input.auto_approve) return { ok: true };
  return { ok: false, violation: "design_not_presented" };
}

// ----------------------------------------------------------------------------
// Constraint 2: type resolver threshold 80
// ----------------------------------------------------------------------------

export interface ResolveTypeInput {
  candidate: string;
  existing: string | null;
  score: number;
}

export interface ResolveTypeResult {
  action: "use_existing" | "create";
  create_allowed: boolean;
}

export function resolveType(input: ResolveTypeInput): ResolveTypeResult {
  if (input.existing && input.score >= 80) {
    return { action: "use_existing", create_allowed: false };
  }
  return { action: "create", create_allowed: true };
}

export const resolveTypeResult = resolveType;

// ----------------------------------------------------------------------------
// Constraint 3: agent permissions bounded by requesting user
// ----------------------------------------------------------------------------

export interface AgentPermissionInput {
  requested: Record<string, boolean>;
  requesting_user_grant: Record<string, boolean>;
}

export interface AgentPermissionResult {
  ok: boolean;
  exceeded: string[];
}

export function agentPermissions(input: AgentPermissionInput): AgentPermissionResult {
  const exceeded = Object.entries(input.requested)
    .filter(([k, v]) => v && !input.requesting_user_grant[k])
    .map(([k]) => k);
  return { ok: exceeded.length === 0, exceeded };
}

// ----------------------------------------------------------------------------
// Constraint 4: customer access grant scope check
// ----------------------------------------------------------------------------

export interface CustomerAccessGrantInput {
  resource: string;
  scope: string;
  grant?: {
    paths: string[];
    excluded_paths: string[];
  };
}

export function customerAccessGrant(input: CustomerAccessGrantInput): ConstraintResult {
  if (!input.grant) return { ok: false, violation: "no_grant" };
  for (const excluded of input.grant.excluded_paths) {
    if (matchGlob(excluded, input.scope)) return { ok: false, violation: "path_excluded" };
  }
  for (const allowed of input.grant.paths) {
    if (matchGlob(allowed, input.scope)) return { ok: true };
  }
  return { ok: false, violation: "no_grant" };
}

function matchGlob(pattern: string, path: string): boolean {
  // crude: ** matches anything; * matches non-/; exact otherwise
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DSTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DSTAR::/g, ".*") +
      "$"
  );
  return re.test(path);
}

// ----------------------------------------------------------------------------
// Constraint 5: cost estimation gating
// ----------------------------------------------------------------------------

export interface EstimateCostInput {
  estimated: number | null;
  budget: number;
}

export function estimateCost(input: EstimateCostInput): ConstraintResult {
  if (input.estimated === null || input.estimated === undefined) {
    return { ok: false, violation: "no_estimate" };
  }
  if (input.estimated > input.budget) {
    return { ok: false, violation: "budget_exceeded" };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Constraints 6 + 7: design session caps (10 types, 5 agents)
// ----------------------------------------------------------------------------

export interface DesignSessionInput {
  new_types_count?: number;
  new_agents_count?: number;
}

export function designSession(input: DesignSessionInput): ConstraintResult {
  if (input.new_types_count !== undefined && input.new_types_count > 10) {
    return { ok: false, violation: "too_many_new_types" };
  }
  if (input.new_agents_count !== undefined && input.new_agents_count > 5) {
    return { ok: false, violation: "too_many_new_agents" };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Constraint 8: design-rationale required in session result
// ----------------------------------------------------------------------------

export interface DesignSessionResultInput {
  outputs: string[];
}

export function designSessionResult(input: DesignSessionResultInput): ConstraintResult {
  if (!input.outputs.includes("design-rationale")) {
    return { ok: false, violation: "design_rationale_missing" };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Constraint 9: credentials must be scoped tokens with TTL
// ----------------------------------------------------------------------------

export interface CredentialStoreInput {
  kind: "raw_credential" | "scoped_token";
  value: string;
  ttl_seconds?: number | null;
  scope?: string;
}

export function credentialStore(input: CredentialStoreInput): ConstraintResult {
  if (input.kind === "raw_credential") {
    return { ok: false, violation: "credential_storage_forbidden" };
  }
  if (input.kind === "scoped_token") {
    if (input.ttl_seconds === null || input.ttl_seconds === undefined) {
      return { ok: false, violation: "ttl_required" };
    }
    return { ok: true };
  }
  return { ok: false, violation: "credential_storage_forbidden" };
}

// ----------------------------------------------------------------------------
// Constraint 10: proactive proposal data-points floor
// ----------------------------------------------------------------------------

export interface ProactiveProposalInput {
  data_points: number;
}

export function proactiveProposal(input: ProactiveProposalInput): ConstraintResult {
  if (input.data_points < 50) {
    return { ok: false, violation: "insufficient_evidence" };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Constraint 11: self-approval forbidden
// ----------------------------------------------------------------------------

export interface ProposalApprovalInput {
  proposer: string;
  approver: string;
}

export function proposalApproval(input: ProposalApprovalInput): ConstraintResult {
  const proposerIsColtrane = input.proposer === "coltrane" || input.proposer.startsWith("coltrane:");
  const approverIsColtrane = input.approver === "coltrane" || input.approver.startsWith("coltrane:");
  if (proposerIsColtrane && approverIsColtrane) {
    return { ok: false, violation: "self_approval_forbidden" };
  }
  return { ok: true };
}

// AccessGrant is owned by src/access_grant.ts. No local re-definition here
// (was a duplicate that produced barrel ambiguity TS2308).
