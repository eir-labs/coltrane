import type { ChangeClass } from "./type_versioning.js";
import { zodToMcpProps, AgentSchema, StandardSchema, SkillSchema, DomainTypeSchema } from "./genome_schema.js";

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

// A property value is either a bare JSON-schema type name (the common case) or a full schema
// fragment — needed for fields that are honestly nullable, e.g. a measurement the engine has no
// data to compute (#238). Declaring those as plain "number" is the same lie as returning 1.0.
const obj = (props: Record<string, string | object>) => ({
  type: "object" as const,
  properties: Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === "string" ? { type: v } : v]),
  ),
});
const nullable = (type: string) => ({ type: [type, "null"] });

// Select named fields from a generated prop map (preserving their derived JSON types).
const pickProps = (src: Record<string, string>, keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k] as string]));

// type_register's surface is the AUTHORED projection of DomainTypeSchema (the single source) — field
// types are generated, so they can't drift from the schema; version/status are server-assigned (not
// authored), and `reason` is approval metadata. (type_extend is an extension DELTA — fields_to_add is
// not a restatement of the type record — so there's nothing to derive there.)
const DT_AUTHORED = pickProps(zodToMcpProps(DomainTypeSchema), ["slug", "extends", "domain", "schema", "required_fields"]);

export const MCP_TOOLS: readonly MCPToolDef[] = [
  { slug: "type_resolve",                  category: "understand", input_schema: obj({ core_type: "string", domain: "string", semantic_description: "string", required_fields: "array" }), output_schema: obj({ action: "string", candidates: "array", recommendation: "object" }) },
  { slug: "type_browse",                   category: "understand", input_schema: obj({ domain: "string", extends: "string", min_usage: "number", status: "string" }), output_schema: obj({ types: "array", stats: "object" }) },
  { slug: "tool_registry_browse",          category: "understand", input_schema: obj({ category: "string", usage_min: "number", unused_since: "string" }), output_schema: obj({ tools: "array", usage_stats: "array", dependency_map: "object" }) },
  { slug: "output_query",                  category: "understand", input_schema: obj({ domain_type: "string", gig_id: "string", agent_slug: "string", data_filter: "object" }), output_schema: obj({ outputs: "array", total_count: "number" }) },
  { slug: "output_trace",                  category: "understand", input_schema: obj({ output_id: "string", direction: "string", max_depth: "number" }), output_schema: obj({ graph: "object", root_signals: "array", terminal_outputs: "array" }) },
  { slug: "charter_read",          category: "understand", input_schema: obj({ company_id: "string" }), output_schema: obj({ products: "array", goals: "array", pain_points: "array", tech_stack: "array", access_grants: "array" }) },
  // #217 — advertised contract == handler. The five filters src/server.ts actually reads, and
  // the two keys it actually returns. The old {company_id, domain} in / {gigs,
  // performance_summary} out overlapped the handler in neither direction, so a client
  // following the surface got an UNFILTERED DUMP of the audit trail and then looked for a key
  // that was never returned.
  { slug: "execution_history_read",        category: "understand", input_schema: obj({ gig_id: "string", standard_slug: "string", genome_hash: "string", after: "string", before: "string" }), output_schema: obj({ executions: "array", count: "number" }) },
  { slug: "access_grant_check",            category: "understand", input_schema: obj({ company_id: "string", resource_uri: "string", required_permissions: "array" }), output_schema: obj({ granted: "boolean", missing_permissions: "array", expires_in: "number" }) },

  { slug: "type_register",                 category: "build", input_schema: obj({ ...DT_AUTHORED, reason: "string" }), output_schema: obj({ registered: "boolean", domain_type_id: "string", version: "number" }) },
  { slug: "type_extend",                   category: "build", input_schema: obj({ slug: "string", domain: "string", fields_to_add: "object", reason: "string" }), output_schema: obj({ new_version: "number", changelog_entry: "string" }) },
  { slug: "agent_define",                  category: "build", input_schema: obj(zodToMcpProps(AgentSchema)), output_schema: obj({ agent_profile_id: "string", validation_result: "object" }) },
  { slug: "agent_evolve",                  category: "build", input_schema: obj({ slug: "string", changes: "object", reason: "string", evidence: "object" }), output_schema: obj({ new_version: "number", cascade_check: "object" }) },
  { slug: "standard_compose",              category: "build", input_schema: obj(zodToMcpProps(StandardSchema)), output_schema: obj({ standard_id: "string", validation_result: "object" }) },
  // #239 — `basis`/`sample_size` say WHERE the estimate came from (a measured mean of real runs,
  // the standard's real structure, or a per-slug guess). estimated_duration_ms is the key the
  // handler actually returns; the old `estimated_duration` was never present on a response.
  { slug: "standard_simulate",             category: "build", input_schema: obj({ standard_slug: "string", mock_input: "object", depth: "string" }), output_schema: obj({ phases: "array", estimated_cost: "number", estimated_duration_ms: "number", basis: "string", sample_size: "number" }) },
  // #237 — `depth` is read now (and rejected when unrecognized); the response echoes the depth
  // the run actually took, so "I ran a cheap iteration" is verifiable rather than assumed.
  { slug: "gig_dispatch",                  category: "run", input_schema: obj({ standard_slug: "string", input: "object", depth: "string", company_id: "string", wait: "boolean" }), output_schema: obj({ gig_id: "string", status: "string", depth: "string", manifest: "object" }) },
  { slug: "gig_monitor",                   category: "run", input_schema: obj({ gig_id: "string" }), output_schema: obj({ status: "string", phases_complete: "number", current_phase: "string", chairs: "array", outputs_so_far: "array" }) },
  { slug: "gig_logs",                       category: "understand", input_schema: obj({ gig_id: "string", role: "string", type: "string", tail: "number" }), output_schema: obj({ gig_id: "string", roles: "array", count: "number", events: "array" }) },
  // #251 — `status` is the field both existing tests actually assert and it was not advertised.
  // `aborted` now means "this call delivered a cancellation to a live run", not "we looked at
  // the stores and guessed"; `cancellable` says whether this server could reach the run at all.
  { slug: "gig_abort",                     category: "run", input_schema: obj({ gig_id: "string", reason: "string" }), output_schema: obj({ status: "string", aborted: "boolean", cancellable: "boolean", cleanup_result: "object" }) },
  { slug: "output_write",                  category: "run", input_schema: obj({ core_type: "string", domain_type: "string", data: "object", input_refs: "array", refs: "array" }), output_schema: obj({ output_id: "string", validation_result: "object" }) },

  { slug: "agent_validate_pipeline",       category: "improve", input_schema: obj({ agents: "array", standard_slug: "string" }), output_schema: obj({ valid: "boolean", graph: "object", unsatisfied_inputs: "array", illegal_progressions: "array" }) },
  // #238 — success_rate and trend are NULLABLE, because the engine genuinely cannot compute
  // them (a failed gig writes no ledger row, so the denominator does not exist) and a hardcoded
  // 1.0 is a fabricated measurement presented as a measurement. The `*_basis` strings say why.
  // `cost_usd` is real settled spend off the gig rows (#195), not an output count.
  { slug: "health_check",                  category: "improve", input_schema: obj({ entity_type: "string", kind: "string", slug: "string", window: "string" }), output_schema: obj({ entity: "string", kind: "string", output_count: "number", execution_count: "number", usage: "number", success_rate: nullable("number"), success_rate_basis: "string", cost: "number", cost_usd: "number", cost_basis: "string", trend: nullable("string"), trend_basis: "string", recommendations: "array" }) },
  { slug: "system_health",                 category: "improve", input_schema: obj({ window: "string" }), output_schema: obj({ gigs_run: "number", cost: "number", type_stats: "object", agent_stats: "object", tool_stats: "object", bottlenecks: "array", budget: "object", load_errors: "array" }) },
  // genome_reload — Rob #130. Re-reads agents/standards/types/skills/evals from
  // disk and updates the live deps in place (no MCP server restart needed).
  // Returns the diff vs the prior state, plus any load_errors from the new genome.
  { slug: "genome_reload",                 category: "improve", input_schema: obj({}), output_schema: obj({ reloaded: "boolean", changes: "object", load_errors: "array" }) },
  // server_restart — Rob #N / PR #141. Picks up new server bytes after
  // npm run build without ending the Claude Code conversation. This entry
  // exists so coltrane's own introspection (tool_inspect, system_audit)
  // sees the tool — but the server itself never executes it. The relay
  // parent-process catches `tools/call server_restart` before it reaches
  // the child server, kills + respawns the child, and replies. If the
  // server-side handler below is ever reached, the relay is misconfigured
  // (typically: COLTRANE_SERVER_DIRECT=1 was set, bypassing the relay).
  { slug: "server_restart",                category: "improve", input_schema: obj({}), output_schema: obj({ restarted: "boolean", note: "string" }) },
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
  { slug: "skill_define",                  category: "build", input_schema: obj(zodToMcpProps(SkillSchema)), output_schema: obj({ skill_id: "string", content_hash: "string" }) },
  { slug: "skill_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },

  { slug: "charter_suggest_update", category: "manage_context", input_schema: obj({ company_id: "string", field: "string", current_value: "string", suggested_value: "string", evidence: "object" }), output_schema: obj({ proposal_id: "string" }) },
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
