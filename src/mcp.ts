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
// authored). (type_extend is an extension DELTA — fields_to_add is not a restatement of the type
// record — so there's nothing to derive there.)
//
// `reason` used to be appended here as "approval metadata" and was read by nothing: the only
// handlers that read args["reason"] are proposal_create and gig_abort (#234).
const DT_AUTHORED = pickProps(zodToMcpProps(DomainTypeSchema), ["slug", "extends", "domain", "schema", "required_fields"]);

export const MCP_TOOLS: readonly MCPToolDef[] = [
  { slug: "type_resolve",                  category: "understand", input_schema: obj({ core_type: "string", extends: "string", domain: "string", required_fields: "array" }), output_schema: obj({ action: "string", candidates: "array", recommendation: "object" }) },
  { slug: "type_browse",                   category: "understand", input_schema: obj({ domain: "string", extends: "string", status: "string", min_usage: "number" }), output_schema: obj({ types: "array", stats: "object" }) },
  { slug: "tool_registry_browse",          category: "understand", input_schema: obj({ category: "string" }), output_schema: obj({ tools: "array", usage_stats: "array", dependency_map: "object" }) },
  { slug: "output_query",                  category: "understand", input_schema: obj({ domain_type: "string", gig_id: "string", agent_slug: "string", data_filter: "object" }), output_schema: obj({ outputs: "array", total_count: "number" }) },
  { slug: "output_trace",                  category: "understand", input_schema: obj({ output_id: "string", direction: "string", max_depth: "number" }), output_schema: obj({ graph: "object", root_signals: "array", terminal_outputs: "array" }) },
  { slug: "charter_read",          category: "understand", input_schema: obj({ path: "string" }), output_schema: obj({ products: "array", goals: "array", pain_points: "array", tech_stack: "array", access_grants: "array" }) },
  // #217 — advertised contract == handler. The five filters src/server.ts actually reads, and
  // the two keys it actually returns. The old {company_id, domain} in / {gigs,
  // performance_summary} out overlapped the handler in neither direction, so a client
  // following the surface got an UNFILTERED DUMP of the audit trail and then looked for a key
  // that was never returned.
  { slug: "execution_history_read",        category: "understand", input_schema: obj({ gig_id: "string", standard_slug: "string", genome_hash: "string", after: "string", before: "string" }), output_schema: obj({ executions: "array", count: "number" }) },
  // #234/#279 — the advertised surface here shared NOT ONE argument with the handler, which
  // reads `grant`, `plan` and `now_ms`. A caller obeying the schema passed three arguments that
  // were all ignored and got an answer computed from an absent grant. Advertising the real
  // shape is the minimum; the wiring question (nothing in production calls this) is #279.
  { slug: "access_grant_check",            category: "understand", input_schema: obj({ grant: "object", plan: "object", required_permissions: "array", now_ms: "number" }), output_schema: obj({ granted: "boolean", missing_permissions: "array", expires_in: "number" }) },

  { slug: "type_register",                 category: "build", input_schema: obj({ ...DT_AUTHORED, reason: "string" }), output_schema: obj({ registered: "boolean", domain_type_id: "string", version: "number" }) },
  { slug: "type_extend",                   category: "build", input_schema: obj({ slug: "string", fields_to_add: "object", extension: "object", reason: "string" }), output_schema: obj({ new_version: "number", changelog_entry: "string" }) },
  { slug: "agent_define",                  category: "build", input_schema: obj(zodToMcpProps(AgentSchema)), output_schema: obj({ agent_profile_id: "string", validation_result: "object" }) },
  { slug: "agent_evolve",                  category: "build", input_schema: obj({ slug: "string", changes: "object", base: "object", next: "object", new_version: "number", reason: "string", evidence: "object" }), output_schema: obj({ new_version: "number", cascade_check: "object" }) },
  { slug: "standard_compose",              category: "build", input_schema: obj(zodToMcpProps(StandardSchema)), output_schema: obj({ standard_id: "string", validation_result: "object" }) },
  // #239 — `basis`/`sample_size` say WHERE the estimate came from (a measured mean of real runs,
  // the standard's real structure, or a per-slug guess). estimated_duration_ms is the key the
  // handler actually returns; the old `estimated_duration` was never present on a response.
  { slug: "standard_simulate",             category: "build", input_schema: obj({ standard_slug: "string", mock_input: "object", depth: "string" }), output_schema: obj({ phases: "array", estimated_cost: "number", estimated_duration_ms: "number", basis: "string", sample_size: "number" }) },
  // #237 — `depth` is read now (and rejected when unrecognized); the response echoes the depth
  // the run actually took, so "I ran a cheap iteration" is verifiable rather than assumed.
  // #234 — every argument this tool reads is advertised, and every argument advertised is read.
  //
  // `budget` enforced a real spend ceiling and appeared in no schema: a caller reading the
  // tool surface had no way to learn a ceiling could be set, so the guardrail may as well not
  // have existed. That is the whole of #234 in one line.
  //
  // `resume_gig_id` + `reuse` are the two ways to reuse a sealed output instead of paying to
  // derive it again, and both are ADVERTISED for the same reason — an undiscoverable feature
  // is #234 repeated.
  //   resume_gig_id — continue a gig that died mid-pipeline, skipping the phases that already
  //     sealed. Refused (never silently run cold) if the genome, its PRODUCERS, payload, model,
  //     depth or a domain type moved since; the reply then carries `resume_refused` + `drift`.
  //   reuse — allow chair-level cache reads AND writes. A chair whose producer, resolved
  //     inputs and payload hash to a prior sealed output is served from it instead of invoked.
  // `skipped` / `resumed_from` / `reuse` on the response say exactly what did not run and why.
  //
  // `company_id` is GONE, found by the guard added with the same change. It was advertised and
  // never read — the #237 shape (advertised, silently discarded). It is worse than a merely
  // dead argument because it is TENANCY-shaped: a caller passing it to scope a run to a company
  // would reasonably believe the run was scoped, and nothing in the engine reads it. The engine
  // deliberately does not do tenancy — `principal` on the ledger is documented as provenance
  // and explicitly NOT an access control — so the honest move is to stop advertising a
  // guarantee it does not make.
  //
  // Sweeping the guard across all 37 tools then found `company_id` advertised and unread on
  // charter_read and charter_suggest_update too, so it is gone from the MCP surface entirely.
  // It survives only as a FIELD on the AccessGrant object (src/access_grant.ts), where it
  // describes the grant a caller passes in rather than promising the engine will scope by it.
  { slug: "gig_dispatch",                  category: "run", input_schema: obj({ standard_slug: "string", input: "object", depth: "string", wait: "boolean", budget: "object", resume_gig_id: "string", reuse: "boolean" }), output_schema: obj({ gig_id: "string", status: "string", depth: "string", manifest: "object", resumed_from: "string", reuse: "boolean", resume_refused: "boolean", drift: "array" }) },
  // `skipped_chairs` / `resumed_from` / `reuse_rejected` are the ASYNC path's only report of a
  // saving — the manifest never reaches a caller who dispatched without `wait`.
  { slug: "gig_monitor",                   category: "run", input_schema: obj({ gig_id: "string" }), output_schema: obj({ status: "string", phases_complete: "number", current_phase: "string", chairs: "array", outputs_so_far: "array", skipped_chairs: "array", resumed_from: "object", reuse_rejected: "array" }) },
  { slug: "gig_logs",                       category: "understand", input_schema: obj({ gig_id: "string", role: "string", type: "string", tail: "number" }), output_schema: obj({ gig_id: "string", roles: "array", count: "number", events: "array" }) },
  // #251 — `status` is the field both existing tests actually assert and it was not advertised.
  // `aborted` now means "this call delivered a cancellation to a live run", not "we looked at
  // the stores and guessed"; `cancellable` says whether this server could reach the run at all.
  { slug: "gig_abort",                     category: "run", input_schema: obj({ gig_id: "string", reason: "string" }), output_schema: obj({ status: "string", aborted: "boolean", cancellable: "boolean", cleanup_result: "object" }) },
  // #234 — `gig_id`, `agent_slug` and `phase` were read by the handler and advertised nowhere.
  // This one had teeth: a skill prompt written against this schema omits `gig_id`, the handler
  // defaults it to "", and the sealed output lands in the store attached to NO gig. A live run
  // of the consuming product produced 509 such orphans. The provenance chain is the engine's
  // core promise, and the field that anchors an output to its run was undiscoverable.
  { slug: "output_write",                  category: "run", input_schema: obj({ core_type: "string", primitive: "string", domain_type: "string", domain_type_version: "number", domain: "string", data: "object", input_refs: "array", refs: "array", gig_id: "string", agent_slug: "string", phase: "string", cost_usd: "number", tokens_used: "number", duration_ms: "number" }), output_schema: obj({ output_id: "string", validation_result: "object" }) },

  { slug: "agent_validate_pipeline",       category: "improve", input_schema: obj({ agents: "array", standard_slug: "string", slug: "string", domain: "string", primitives: "array", phases: "array" }), output_schema: obj({ valid: "boolean", graph: "object", unsatisfied_inputs: "array", illegal_progressions: "array" }) },
  // #238 — success_rate and trend are NULLABLE, because the engine genuinely cannot compute
  // them (a failed gig writes no ledger row, so the denominator does not exist) and a hardcoded
  // 1.0 is a fabricated measurement presented as a measurement. The `*_basis` strings say why.
  // `cost_usd` is real settled spend off the gig rows (#195), not an output count.
  { slug: "health_check",                  category: "improve", input_schema: obj({ entity_type: "string", kind: "string", slug: "string", window: "string" }), output_schema: obj({ entity: "string", kind: "string", output_count: "number", execution_count: "number", usage: "number", success_rate: nullable("number"), success_rate_basis: "string", cost: "number", cost_usd: "number", cost_basis: "string", trend: nullable("string"), trend_basis: "string", recommendations: "array" }) },
  // #255 — the integrity fields are ADVERTISED, not just returned. This tool's whole purpose
  // is that an operator can ask whether the system is healthy; a damage report they cannot
  // discover from the schema is only marginally better than one that is never computed.
  { slug: "system_health",                 category: "improve", input_schema: obj({ window: "string" }), output_schema: obj({ gigs_run: "number", cost: "number", type_stats: "object", agent_stats: "object", tool_stats: "object", bottlenecks: "array", budget: "object", load_errors: "array", ledger_integrity: "object", outputs_integrity: "object", counts_complete: "boolean", counts_complete_basis: "string" }) },
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
  { slug: "proposal_create",               category: "improve", input_schema: obj({ change_type: "string", target: "string", target_kind: "string", reason: "string" }), output_schema: obj({ proposal_id: "string", cascade_impact: "object" }) },
  { slug: "tool_propose",                  category: "improve", input_schema: obj({ slug: "string", type: "string", spec: "object", reason: "string" }), output_schema: obj({ proposal_id: "string" }) },
  // tool_register — close the propose→register loop. Adds a slug to the live
  // tool registry so subsequent agent_define calls can grant scope to it.
  // Without this, propose-only governance is half-built: there is no path to
  // legitimately admit a tool, and the rejection gate becomes a permanent block.
  { slug: "tool_register",                 category: "improve", input_schema: obj({ slug: "string", type: "string", spec: "object", category: "string" }), output_schema: obj({ registered: "boolean", slug: "string" }) },
  { slug: "tool_deprecate_propose",        category: "improve", input_schema: obj({ slug: "string", reason: "string", usage_stats: "object" }), output_schema: obj({ proposal_id: "string", affected_agents: "array" }) },
  // `need` is the documented argument; `query`/`capability` are accepted aliases kept for
  // callers written against the handler rather than the schema, and advertised so they are
  // discoverable rather than folklore (#234).
  { slug: "capability_research",           category: "improve", input_schema: obj({ need: "string", query: "string", capability: "string" }), output_schema: obj({ existing_matches: "array", gap: "boolean", approaches: "array", mcp_options: "array", recommendation: "object" }) },
  { slug: "session_review_write",          category: "improve", input_schema: obj({ gig_id: "string", output_id: "string", agent_slug: "string", agent_version: "number", quality_scores: "object", domain: "string", notes: "string" }), output_schema: obj({ review_id: "string", recorded: "boolean" }) },
  { slug: "learning_synthesize",           category: "improve", input_schema: obj({ agent_slug: "string", min_reviews: "number", since: "string", auto_propose: "boolean" }), output_schema: obj({ agent_slug: "string", review_count: "number", evidence_sufficient: "boolean", summary: "object", proposal_id: "string" }) },

  { slug: "agent_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "standard_promote",              category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "skill_define",                  category: "build", input_schema: obj(zodToMcpProps(SkillSchema)), output_schema: obj({ skill_id: "string", content_hash: "string" }) },
  { slug: "skill_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },

  { slug: "charter_suggest_update", category: "manage_context", input_schema: obj({ field: "string", current_value: "string", suggested_value: "string", evidence: "object" }), output_schema: obj({ proposal_id: "string" }) },
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
