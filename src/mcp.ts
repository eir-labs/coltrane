import type { ChangeClass } from "./type_versioning.js";
import { zodToMcpProps, AgentSchema, StandardSchema, SkillSchema, DomainTypeSchema, ChartSchema, VenueObjectSchema } from "./genome_schema.js";

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
  // Discoverability parity (tests/genome_browse_parity.test.ts): every genome class that is
  // authorable over MCP is listable over MCP. Standards and agents lacked these because the
  // registry grew up in a working tree where `ls standards/` was free — the first hosted mount
  // (no filesystem) turned that local assumption into an undiscoverable-slug hole.
  { slug: "standard_browse",               category: "understand", input_schema: obj({ domain: "string", status: "string" }), output_schema: obj({ standards: "array", count: "number" }) },
  // The single-record read for a standard, mirroring skill_inspect: browse lists shallow rows,
  // inspect returns ONE standard's full record — its phases with each chair's seat (role,
  // agent/skill/human, contracts), its type surface, its evals, and its description. Without it
  // there was no MCP read path to a standard's whole shape.
  { slug: "standard_inspect",              category: "understand", input_schema: obj({ slug: "string" }), output_schema: obj({ slug: "string", domain: "string", status: "string", phases: "array", input_types: "array", output_types: "array", eval_slugs: "array", description: nullable("string") }) },
  { slug: "agent_browse",                  category: "understand", input_schema: obj({ domain: "string", primitive: "string" }), output_schema: obj({ agents: "array", count: "number" }) },
  // The chart and the venue joined the parity table when they became authorable (0.7.0 shipped
  // ChartSchema with no MCP surface at all, which is why there was nothing to list). A chart row
  // carries what a dispatcher chooses on: the movements' standards, how many edges and gates the
  // arrangement has, the room it is held in, and a chart_hash prefix to tell two arrangements apart.
  { slug: "chart_browse",                  category: "understand", input_schema: obj({ venue: "string", standard_slug: "string" }), output_schema: obj({ charts: "array", count: "number" }) },
  // A venue row carries what a SEATING decides on: whose institution owns the room, how much
  // equipment it holds at all (the ceiling), whether anything may leave it, and its lifecycle.
  { slug: "venue_browse",                  category: "understand", input_schema: obj({ institution_slug: "string", flavor: "string" }), output_schema: obj({ venues: "array", count: "number" }) },
  // Tier-1 traversal by default (compact rows: id, gig_id, agent, phase, content_sha, preview,
  // storage_ref…). `output_id`/`content_sha` + `include_data:true` is the deeper second pass —
  // it fetches ONE output's full payload from the artifact tier (local mirror, or remote when drained).
  { slug: "output_query",                  category: "understand", input_schema: obj({ domain_type: "string", gig_id: "string", agent_slug: "string", data_filter: "object", output_id: "string", content_sha: "string", include_data: "boolean" }), output_schema: obj({ outputs: "array", total_count: "number" }) },
  // The walk crosses a chart's MOVEMENT boundaries: each graph node carries the `gig_id` it was
  // sealed under plus its `movement`/`performance_gig_id`, and `crossed` when the walk left the
  // seed's gig to reach it. `missing` names each referenced content_sha this store does not hold
  // — a hole in the chain is reported, never dropped. `direction` echoes which way was walked.
  { slug: "output_trace",                  category: "understand", input_schema: obj({ output_id: "string", direction: "string", max_depth: "number" }), output_schema: obj({ graph: "object", direction: "string", root_signals: "array", terminal_outputs: "array", missing: "array" }) },
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
  // chart_define / venue_define — generated from their schemas, like every migrated class. The
  // define call is where a chart's eleven rules and a venue's cross-field rules fire, so
  // `validation_result` carries the STRUCTURED violation list (rule + detail + where), not a
  // boolean: a chart is refused for one named reason at one named place.
  { slug: "chart_define",                  category: "build", input_schema: obj(zodToMcpProps(ChartSchema)), output_schema: obj({ chart_id: "string", chart_hash: "string", validation_result: "object" }) },
  // `VenueObjectSchema`, not `VenueSchema`: the advertised surface is generated from the inner
  // `ZodObject`'s `.shape`, which the `.superRefine`-wrapped `VenueSchema` (a `ZodEffects`) no longer
  // exposes. The cross-field rules the refinement adds are enforced at safeParse in the handler, not
  // advertised as arguments — so the two stay one statement of the same fact (#234).
  { slug: "venue_define",                  category: "build", input_schema: obj(zodToMcpProps(VenueObjectSchema)), output_schema: obj({ venue_id: "string", validation_result: "object" }) },
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
  //
  // `approvals` + `approved_by` are the human seat's door. A gig that reaches a chair marked
  // `human: true` PARKS (`status: "awaiting_approval"`, the reply naming the chair in
  // `awaiting`) until the incumbent's verdict is supplied here, keyed by chair role; the
  // verdict then seals through the same gate as every other output, under `approved_by`.
  // Undiscoverable, they would be an approval gate no operator could pass — #234 again, on
  // the one control whose whole purpose is to be exercised by a person.
  // `chart_slug` is the second way to name what a gig performs, and it is EXCLUSIVE with
  // `standard_slug`: "a standard AND a chart" names two performances, "neither" names none, and a
  // single-standard dispatch already IS the one-movement chart. Both are optional at the schema
  // level so no existing caller's shape breaks; the exactly-one refinement lives in the handler
  // (dispatchTarget, src/chart.ts). A chart dispatch's reply carries the ARRANGEMENT's manifest —
  // chart_hash, the per-movement roll-up, cumulative spend against the envelope — where a standard
  // dispatch carries the run's.
  // #20 — `gig_input_omitted` is the caller's statement that it passed NO payload (distinct from an
  // explicit `input: {}`). On an approve-only resume whose every remaining chair is human, an omitted
  // payload inherits the checkpoint's recorded gig_input_sha instead of drifting to sha256('{}') and
  // refusing; a supplied `input` leaves this false, so a disagreeing payload still gates
  // (src/runtime.ts). The handler reads it, so #234 requires it be advertised here — it is a real
  // control, not an internal signal, and a caller must be able to find it.
  { slug: "gig_dispatch",                  category: "run", input_schema: obj({ standard_slug: "string", chart_slug: "string", venue: "string", repo_url: "string", acting_for: "string", input: "object", gig_input_omitted: "boolean", depth: "string", wait: "boolean", budget: "object", resume_gig_id: "string", reuse: "boolean", approvals: "object", approved_by: "string" }), output_schema: obj({ gig_id: "string", status: "string", awaiting: "object", depth: "string", manifest: "object", resumed_from: "string", reuse: "boolean", resume_refused: "boolean", drift: "array" }) },
  // `skipped_chairs` / `resumed_from` / `reuse_rejected` are the ASYNC path's only report of a
  // saving — the manifest never reaches a caller who dispatched without `wait`.
  // `awaiting` names the human chair a parked run stopped at. On the async path — the DEFAULT
  // dispatch mode — the reply is only an id, so this is the only surface that can say a person
  // is now the blocker rather than the engine.
  { slug: "gig_monitor",                   category: "run", input_schema: obj({ gig_id: "string" }), output_schema: obj({ status: "string", awaiting: "object", phases_complete: "number", current_phase: "string", chairs: "array", outputs_so_far: "array", skipped_chairs: "array", resumed_from: "object", reuse_rejected: "array" }) },
  { slug: "gig_logs",                       category: "understand", input_schema: obj({ gig_id: "string", role: "string", type: "string", tail: "number" }), output_schema: obj({ gig_id: "string", roles: "array", count: "number", events: "array" }) },
  // #251 — `status` is the field both existing tests actually assert and it was not advertised.
  // `aborted` now means "this call delivered a cancellation to a live run", not "we looked at
  // the stores and guessed"; `cancellable` says whether this server could reach the run at all.
  { slug: "gig_abort",                     category: "run", input_schema: obj({ gig_id: "string", reason: "string" }), output_schema: obj({ status: "string", aborted: "boolean", cancellable: "boolean", cleanup_result: "object" }) },
  // gig_cancel stops a QUEUED gig — one dispatched into the org gig table but not yet claimed by
  // a drain worker — so no worker ever claims it. It is the counterpart to gig_abort, which
  // targets a RUNNING gig; a queued row is exactly the window gig_abort reports not_found for.
  // Cancel FAILS CLOSED on a running/claimed gig, naming gig_abort. Hosted routes to
  // deps.cancelGig (member JWT → coltrane_gig_cancel; agent token → coltrane_mcp_gig_cancel);
  // the local surface has no queue, so it answers with a typed hosted-only explanation.
  { slug: "gig_cancel",                    category: "run", input_schema: obj({ gig_id: "string" }), output_schema: obj({ gig_id: "string", status: "string" }) },
  // Approval is a MEMBER act — the web console does it, and this is the same act over MCP so a
  // human on an MCP client can approve a parked gig over the wire. `verdict` is the Judgment the
  // human seat seals. The tool is a pure pass-through to the store's member-JWT-only
  // coltrane_gig_approve RPC (an agent token is refused store-side, which is where that
  // enforcement belongs); hosted routes to deps.approveGig, non-hosted has no local run to
  // approve (a local run takes its verdicts through gig_dispatch's `approvals`).
  { slug: "gig_approve",                   category: "run", input_schema: obj({ gig_id: "string", role: "string", verdict: "object" }), output_schema: obj({ gig_id: "string", role: "string", status: "string", approved: "boolean" }) },
  // venue_credential_mint — the verb that stands up a worker without a browser. `org_slug` scopes
  // the credential and `instance` binds it to one host; a key with an org and no instance is the
  // org's whole authority with nothing to bind it to. The answer carries the COMPLETE worker
  // environment (`env`, canonical names only) — not just the key — so a caller never assembles the
  // rest by hand or infers which URL names which host (that inference is Gap 3). `credential_classes`
  // names what was provisioned in `VenueSchema.credential_surface` vocabulary, so a `realize` room
  // contract can be checked against the grant before a gig is dispatched. The engine ships the schema
  // and its refusals; a deployment wires the minting backend (deps.mintVenueCredential). There is
  // deliberately NO read-back verb (see the venue_credential_* exact-list law) and NO authorization
  // policy in the engine — who may mint lives in the store.
  { slug: "venue_credential_mint",         category: "run", input_schema: obj({ org_slug: "string", instance: "string" }), output_schema: obj({ instance: "string", env: "object", credential_classes: "array", expires_at: nullable("string") }) },
  // #234 — `gig_id`, `agent_slug` and `phase` were read by the handler and advertised nowhere.
  // This one had teeth: a skill prompt written against this schema omits `gig_id`, the handler
  // defaults it to "", and the sealed output lands in the store attached to NO gig. A live run
  // of the consuming product produced 509 such orphans. The provenance chain is the engine's
  // core promise, and the field that anchors an output to its run was undiscoverable.
  { slug: "output_write",                  category: "run", input_schema: obj({ core_type: "string", primitive: "string", domain_type: "string", domain_type_version: "number", domain: "string", data: "object", input_refs: "array", refs: "array", gig_id: "string", agent_slug: "string", phase: "string", cost_usd: "number", tokens_used: "number", duration_ms: "number", model: "string", model_tier: "string" }), output_schema: obj({ output_id: "string", primitive: "string", output: "object", validation_result: "object", validated: "boolean" }) },

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
  // The differentiator, made answerable: did this producer get BETTER, and what did it cost?
  // `learning_synthesize` counts reviews; this MEASURES the change across producer versions.
  // Every input was already sealed — outputs carry agent_slug/cost_usd, reviews carry
  // quality_scores against a specific output_id and agent_version — and nothing joined them.
  { slug: "improvement_report",            category: "improve", input_schema: obj({ agent_slug: "string", window: "string" }), output_schema: obj({ agent_slug: "string", total_outputs: "number", versions: "array", deltas: "array", tiers: "array", comparable: "boolean", basis: "string" }) },
  { slug: "learning_synthesize",           category: "improve", input_schema: obj({ agent_slug: "string", min_reviews: "number", since: "string", auto_propose: "boolean" }), output_schema: obj({ agent_slug: "string", review_count: "number", evidence_sufficient: "boolean", summary: "object", proposal_id: "string" }) },

  { slug: "agent_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "standard_promote",              category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean" }) },
  { slug: "skill_define",                  category: "build", input_schema: obj(zodToMcpProps(SkillSchema)), output_schema: obj({ skill_id: "string", content_hash: "string" }) },
  // The skill ITERATION loop. Until 0.5.0 the surface was define + promote: a skill could be
  // created and given production status, and never run, tested, listed or revised through the
  // engine. The fixture gate on promotion made the gap sharper — a skill could be refused for
  // failing fixtures with no way to run them and see which.
  { slug: "skill_browse",                  category: "understand", input_schema: obj({ domain: "string", status: "string", skill_type: "string", has_code: "boolean" }), output_schema: obj({ skills: "array", count: "number" }) },
  { slug: "skill_inspect",                 category: "understand", input_schema: obj({ slug: "string" }), output_schema: obj({ slug: "string", version: "number", has_code: "boolean", code_hash: nullable("string"), fixture_count: "number", fixtures: "array", promotable: "boolean" }) },
  // `mode:"test"` runs the skill's own fixtures instead of a caller's input, and reports the
  // threshold it would be held to at promotion — so "why was I refused" is one call.
  { slug: "skill_execute",                 category: "run", input_schema: obj({ slug: "string", input: "object", mode: "string", timeout_ms: "number" }), output_schema: obj({ slug: "string", ok: "boolean", output: "object", error: "string", duration_ms: "number" }) },
  // A candidate is run against the CURRENT fixtures in a throwaway copy and lands only if it
  // passes. A skill cannot regress through this door.
  { slug: "skill_evolve",                  category: "build", input_schema: obj({ slug: "string", code: "string", reason: "string" }), output_schema: obj({ slug: "string", accepted: "boolean", new_version: "number", failing_fixtures: "array" }) },
  { slug: "skill_promote",                 category: "build", input_schema: obj({ slug: "string", status: "string", current: "string" }), output_schema: obj({ slug: "string", status: "string", promoted: "boolean", fixture_report: "object" }) },

    // The org context — set ONCE by a member; every write path then resolves the working org
  // without being told (explicit org_slug on a call is an override, never a requirement).
  { slug: "org_use",                       category: "manage_context", input_schema: obj({ org_slug: "string" }), output_schema: obj({ org_slug: "string", set: "boolean" }) },
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
