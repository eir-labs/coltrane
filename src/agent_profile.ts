import type { Primitive } from "./core_types.js";
import type { ModelTier } from "./pricing.js";

export type ProfileSpace = "creative" | "harmonic" | "permissions";

export type DepthProfile = "skim" | "quick" | "standard" | "deep";
export type AgentStatus = "draft" | "review" | "approved" | "active" | "retired";

export interface AgentPermissions {
  allowed_tools: readonly string[];
  disallowed_tools: readonly string[];
  model_tier: ModelTier;
  max_tool_calls: number;
  max_token_budget: number;
  can_write_outputs: boolean;
  can_trigger_standards: boolean;
}

export interface AgentProfile {
  slug: string;
  version: number;
  status: AgentStatus;
  // Lineage: the version this profile evolved from (null on the v1 origin).
  // slug is stable across versions, so (slug, version) + parent_version reconstructs
  // the full immutable chain — old versions survive, nothing mutates in place.
  parent_version?: number | null;
  primitives: readonly Primitive[];
  input_types: readonly string[];
  output_types: readonly string[];
  domain: string;
  identity: string;
  method: string;
  constraints: readonly string[];
  depth_profile: DepthProfile;
  permissions: AgentPermissions;
}

const CREATIVE_FIELDS: readonly (keyof AgentProfile)[] = [
  "identity",
  "method",
  "constraints",
];

const HARMONIC_FIELDS: readonly (keyof AgentProfile)[] = [
  "primitives",
  "input_types",
  "output_types",
  "domain",
  "depth_profile",
];

export interface AgentChangeResult {
  space: ProfileSpace;
  approval_required: boolean;
  type_check_passed?: boolean;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The faithful og evolveAgent: produce the next version of a profile from
// CREATIVE-space changes only (identity / method / constraints). version+1,
// status reset to draft, parent_version threaded so the immutable lineage chain
// reconstructs (old versions survive — nothing mutates in place).
//
// Harmonic (primitives/types/domain) and permissions are creative-only BY
// CONSTRUCTION here: only the three creative fields are read from `changes`, so
// harmonic/permissions can't be expressed through evolve at all — they require a
// proposal / human approval via proposeAgentChange. The three-space rule, enforced
// by what this function structurally cannot touch.
export function evolveProfile(
  base: AgentProfile,
  changes: Partial<Pick<AgentProfile, "identity" | "method" | "constraints">>,
): AgentProfile {
  return {
    ...base, // harmonic fields + permissions carried unchanged — evolve can't touch them
    identity: changes.identity ?? base.identity,
    method: changes.method ?? base.method,
    constraints: changes.constraints ?? base.constraints,
    version: base.version + 1,
    parent_version: base.version,
    status: "draft",
  };
}

export function proposeAgentChange(
  base: AgentProfile,
  next: AgentProfile,
): AgentChangeResult {
  if (!eq(base.permissions, next.permissions)) {
    return { space: "permissions", approval_required: true };
  }
  for (const f of HARMONIC_FIELDS) {
    if (!eq(base[f], next[f])) {
      return {
        space: "harmonic",
        approval_required: false,
        type_check_passed: true,
      };
    }
  }
  for (const f of CREATIVE_FIELDS) {
    if (!eq(base[f], next[f])) {
      return { space: "creative", approval_required: false };
    }
  }
  return { space: "creative", approval_required: false };
}
