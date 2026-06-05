import type { ChangeClass } from "./type_versioning.js";

export type MCPCategory =
  | "understand"
  | "build"
  | "run"
  | "improve"
  | "manage_context";

export interface MCPToolDef {
  slug: string;
  category: MCPCategory;
  input_schema: object;
  output_schema: object;
}

const obj = (props: Record<string, string>) => ({
  type: "object" as const,
  properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, { type: v }])),
});

export const MCP_TOOLS: readonly MCPToolDef[] = [
  { slug: "type_resolve",                  category: "understand", input_schema: obj({ core_type: "string", domain: "string", semantic_description: "string", required_fields: "array" }), output_schema: obj({ action: "string", candidates: "array", recommendation: "object" }) },
  { slug: "type_browse",                   category: "understand", input_schema: obj({ domain: "string", extends: "string", min_usage: "number", status: "string" }), output_schema: obj({ types: "array", stats: "object" }) },
  { slug: "tool_registry_browse",          category: "understand", input_schema: obj({ category: "string", usage_min: "number", unused_since: "string" }), output_schema: obj({ tools: "array", usage_stats: "array", dependency_map: "object" }) },
  { slug: "output_query",                  category: "understand", input_schema: obj({ domain_type: "string", gig_id: "string", agent_slug: "string", data_filter: "object" }), output_schema: obj({ outputs: "array", total_count: "number" }) },
  { slug: "output_trace",                  category: "understand", input_schema: obj({ output_id: "string", direction: "string", max_depth: "number" }), output_schema: obj({ graph: "object", root_signals: "array", terminal_outputs: "array" }) },
  { slug: "charter_read",          category: "understand", input_schema: obj({ company_id: "string" }), output_schema: obj({ products: "array", goals: "array", pain_points: "array", tech_stack: "array", access_grants: "array" }) },
  { slug: "execution_history_read",        category: "understand", input_schema: obj({ company_id: "string", domain: "string" }), output_schema: obj({ gigs: "array", performance_summary: "object" }) },
  { slug: "access_grant_check",            category: "understand", input_schema: obj({ company_id: "string", resource_uri: "string", required_permissions: "array" }), output_schema: obj({ granted: "boolean", missing_permissions: "array", expires_in: "number" }) },

  { slug: "type_register",                 category: "build", input_schema: obj({ slug: "string", extends: "string", domain: "string", schema: "object", required_fields: "array", reason: "string" }), output_schema: obj({ registered: "boolean", domain_type_id: "string", version: "number" }) },
  { slug: "type_extend",                   category: "build", input_schema: obj({ slug: "string", domain: "string", fields_to_add: "object", reason: "string" }), output_schema: obj({ new_version: "number", changelog_entry: "string" }) },
  { slug: "agent_define",                  category: "build", input_schema: obj({ slug: "string", primitives: "array", input_types: "array", output_types: "array", identity: "string", method: "string", constraints: "array", permissions: "object" }), output_schema: obj({ agent_profile_id: "string", validation_result: "object" }) },
  { slug: "agent_evolve",                  category: "build", input_schema: obj({ slug: "string", changes: "object", reason: "string", evidence: "object" }), output_schema: obj({ new_version: "number", cascade_check: "object" }) },
  { slug: "standard_compose",              category: "build", input_schema: obj({ slug: "string", domain: "string", phases: "array", depth_overrides: "object", composition_schema: "object", credits_formula: "string" }), output_schema: obj({ standard_id: "string", validation_result: "object" }) },
  { slug: "standard_simulate",             category: "build", input_schema: obj({ standard_slug: "string", mock_input: "object", depth: "string" }), output_schema: obj({ phases: "array", estimated_cost: "number", estimated_duration: "number" }) },
  // prereg_seal — the discover→define seam mechanism. Takes a draft pre-reg's
  // sealed triplet (predict, kill, apoha), validates minimum content, computes
  // sha256_pre_verdict over the canonical-JSON, writes an append-only ledger
  // entry, and returns the SEALED state. Engine: src/pre_reg.ts.
  { slug: "prereg_seal",                   category: "build", input_schema: obj({ pre_reg_id: "string", kind: "string", sealed: "object", sealed_by: "string" }), output_schema: obj({ pre_reg_id: "string", pre_reg_hash: "string", sealed_at: "string", kind: "string", sealed_by: "string" }) },

  { slug: "gig_dispatch",                  category: "run", input_schema: obj({ standard_slug: "string", input: "object", depth: "string", company_id: "string" }), output_schema: obj({ gig_id: "string", manifest: "object" }) },
  { slug: "gig_monitor",                   category: "run", input_schema: obj({ gig_id: "string" }), output_schema: obj({ status: "string", phases_complete: "number", current_agent: "string", outputs_so_far: "array" }) },
  { slug: "gig_abort",                     category: "run", input_schema: obj({ gig_id: "string", reason: "string" }), output_schema: obj({ aborted: "boolean", cleanup_result: "object" }) },
  { slug: "output_write",                  category: "run", input_schema: obj({ core_type: "string", domain_type: "string", data: "object", input_refs: "array", refs: "array" }), output_schema: obj({ output_id: "string", validation_result: "object" }) },

  { slug: "agent_validate_pipeline",       category: "improve", input_schema: obj({ agents: "array", standard_slug: "string" }), output_schema: obj({ valid: "boolean", graph: "object", unsatisfied_inputs: "array", illegal_progressions: "array" }) },
  { slug: "health_check",                  category: "improve", input_schema: obj({ entity_type: "string", slug: "string", window: "string" }), output_schema: obj({ usage: "number", success_rate: "number", cost: "number", trend: "string", recommendations: "array" }) },
  { slug: "system_health",                 category: "improve", input_schema: obj({ window: "string" }), output_schema: obj({ gigs_run: "number", cost: "number", type_stats: "object", agent_stats: "object", tool_stats: "object", bottlenecks: "array", budget: "object" }) },
  { slug: "system_audit",                  category: "improve", input_schema: obj({ scope: "string", check: "string" }), output_schema: obj({ findings: "array" }) },
  { slug: "proposal_create",               category: "improve", input_schema: obj({ change_type: "string", target: "string", changes: "object", reason: "string", evidence: "object" }), output_schema: obj({ proposal_id: "string", cascade_impact: "object" }) },
  { slug: "tool_propose",                  category: "improve", input_schema: obj({ slug: "string", type: "string", spec: "object", reason: "string" }), output_schema: obj({ proposal_id: "string" }) },
  // tool_register — close the propose→register loop. Adds a slug to the live
  // tool registry so subsequent agent_define calls can grant scope to it.
  // Without this, propose-only governance is half-built: there is no path to
  // legitimately admit a tool, and the rejection gate becomes a permanent block.
  { slug: "tool_register",                 category: "improve", input_schema: obj({ slug: "string", type: "string", spec: "object", category: "string" }), output_schema: obj({ registered: "boolean", slug: "string" }) },
  { slug: "tool_deprecate_propose",        category: "improve", input_schema: obj({ slug: "string", reason: "string", usage_stats: "object" }), output_schema: obj({ proposal_id: "string", affected_agents: "array" }) },
  { slug: "capability_research",           category: "improve", input_schema: obj({ need: "string", context: "object" }), output_schema: obj({ approaches: "array", mcp_options: "array", recommendation: "object" }) },
  { slug: "session_review_write",          category: "improve", input_schema: obj({ gig_id: "string", output_id: "string", agent_slug: "string", agent_version: "number", quality_score: "number", quality_scores: "object", domain: "string", notes: "string" }), output_schema: obj({ review_id: "string", recorded: "boolean" }) },
  { slug: "learning_synthesize",           category: "improve", input_schema: obj({ agent_slug: "string", min_reviews: "number", since: "string", auto_propose: "boolean" }), output_schema: obj({ agent_slug: "string", review_count: "number", evidence_sufficient: "boolean", summary: "object", proposal_id: "string" }) },

  { slug: "agent_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "standard_promote",              category: "build", input_schema: obj({ slug: "string", status: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "skill_define",                  category: "build", input_schema: obj({ slug: "string", domain: "string", md: "string" }), output_schema: obj({ skill_id: "string", content_hash: "string" }) },
  { slug: "skill_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },

  { slug: "charter_suggest_update", category: "manage_context", input_schema: obj({ company_id: "string", field: "string", current_value: "string", suggested_value: "string", evidence: "object" }), output_schema: obj({ proposal_id: "string" }) },

  { slug: "lever_tensor_compute_cover", category: "build", input_schema: obj({ tasks: "array", k_object_dimension: "number", failure_library: "object" }), output_schema: obj({ K_minimal: "number", cover_complete: "boolean", umbra_remaining: "array", permutation_assignment: "array", transverse_score: "number" }) },
];

// Lifecycle promotion order — forward-only. agent/standard share the same chain;
// skill includes the explicit `testing` step before active.
export const AGENT_STATUS_ORDER: readonly string[] = ["draft", "review", "approved", "active", "retired"];
export const STANDARD_STATUS_ORDER: readonly string[] = ["draft", "active", "retired"];
export const SKILL_STATUS_ORDER: readonly string[] = ["draft", "testing", "active", "retired"];

export class PromotionError extends Error {}

/** Validate a forward-only transition through the given status chain. Throws on
 * unknown current/target or any backward/sideways move. Idempotent (current = target). */
export function checkPromotion(current: string, target: string, order: readonly string[]): void {
  const ci = order.indexOf(current);
  const ti = order.indexOf(target);
  if (ci < 0) throw new PromotionError(`unknown current status "${current}"`);
  if (ti < 0) throw new PromotionError(`unknown target status "${target}"`);
  if (ti < ci) throw new PromotionError(`cannot promote backwards: ${current} → ${target}`);
}

const ALWAYS_APPROVAL = new Set([
  "tool_propose",
  "tool_deprecate_propose",
  "charter_suggest_update",
]);

const APPROVAL_IF_BREAKING = new Set(["type_register", "type_extend"]);

export interface ApprovalQuery {
  slug: string;
  change_class: ChangeClass | null;
  target_kind: string | null;
}

export function requiresApproval(q: ApprovalQuery): boolean {
  if (ALWAYS_APPROVAL.has(q.slug)) return true;
  if (APPROVAL_IF_BREAKING.has(q.slug)) return q.change_class === "breaking";
  if (q.slug === "proposal_create") return q.target_kind === "permissions";
  return false;
}
