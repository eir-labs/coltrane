// genome_schema.ts — the genome's DNA, defined ONCE in Zod. Every genome class's shape lived in
// 3-5 hand-maintained places (the TS type, the construction function, the MCP input_schema, the
// handler, the file format) and they drifted — a field added to the type silently never reached the
// MCP surface; a constructor quietly dropped a sealed field; the loader validated skills/evals as
// untyped bags. This module is the single source: from each schema we derive the TYPE (z.infer),
// the VALIDATOR (.parse), the MCP input_schema (zodToMcpProps), and the loader's file validation.
// Add a field once here and every restatement follows.
import { z } from "zod";

// ── Building blocks (the shared sub-schemas the classes compose from) ─────────────
export const PrimitiveSchema = z.enum(["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"]);
export const BelbinRoleSchema = z.enum(["explorer", "analyst", "critic", "synthesizer", "planner", "executor", "audience_modeler"]);
export const CodeToolAccessSchema = z.enum(["none", "read", "write", "full"]);
export const ModelTierSchema = z.enum(["economy", "standard", "premium"]);
export const DepthSchema = z.enum(["skim", "quick", "standard", "deep"]);

// The caged-browser grant (the cage branch adds browser_grant to the agent; the schema is here so
// the grant is validated like any field). Network grant for skills lives in the skill schema.
export const BrowserGrantSchema = z.object({
  allowed_origins: z.array(z.string()),
  blocked_origins: z.array(z.string()).optional(),
  trace_dir: z.string().optional(),
  isolated: z.boolean().optional(),
  headless: z.boolean().optional(),
});
export type BrowserGrant = z.output<typeof BrowserGrantSchema>;

// ── Agent — the template class, migrated end-to-end. z.input = AgentDef (what you author,
//    optionals allowed); z.output = Agent (defaults applied). One definition, both types. ──
export const AgentSchema = z.object({
  slug: z.string(),
  primitives: z.array(PrimitiveSchema).readonly(),
  input_types: z.array(z.string()).readonly().default([]),
  output_types: z.array(z.string()).readonly().default([]),
  domain: z.string().nullable().default(null),
  identity: z.string(),
  method: z.string(),
  constraints: z.array(z.string()).readonly(),
  behavioral_primitives: z.tuple([BelbinRoleSchema, BelbinRoleSchema]).readonly(),
  // optional on the OUTPUT type too (defineAgent fills []) — matches the current Agent interface so
  // the ~50 call-sites that build Agent objects don't all break. defineAgent applies the [] default.
  allowed_tools: z.array(z.string()).readonly().optional(),
  disallowed_tools: z.array(z.string()).readonly().optional(),
  skill_slugs: z.array(z.string()).readonly().optional(),
  model_tier: ModelTierSchema.optional(),
  max_tool_calls: z.number().optional(),
  max_token_budget: z.number().optional(),
  code_tool_access: CodeToolAccessSchema.optional(),
  depth_profile: DepthSchema.optional(),
  browser_grant: BrowserGrantSchema.optional(),
});

export type AgentInput = z.input<typeof AgentSchema>;
export type AgentOutput = z.output<typeof AgentSchema>;

// ── Chair / Phase / Standard — the schema is the DNA; the runtime Standard (resolved agents) is a
//    transform output and stays a derived type in composition.ts. The FILE/compose shape is here. ──
export const ChairSchema = z.object({
  role: z.string(),
  agent_slug: z.string().optional(),
  skill_slug: z.string().optional(),
  /** The human seat: the chair is an approval office held by a person. No agent, no skill —
   *  the incumbent's sealed verdict is the chair's output, and a gig that reaches this chair
   *  unapproved PARKS (awaiting_approval) rather than confabulating a yes. */
  human: z.boolean().optional(),
  depends_on: z.array(z.string()).default([]),
  input_contract: z.array(z.string()).default([]),
  output_contract: z.array(z.string()).default([]),
  // #243 — which promised outputs may legitimately be absent. Deny-by-default: omitted
  // means every promised type is required. Subset of output_contract, checked at compose.
  optional_outputs: z.array(z.string()).default([]),
  required_skills: z.array(z.string()).default([]),
});
export const PhaseSchema = z.object({ name: z.string(), chairs: z.array(ChairSchema) });
/** Lifecycle status, shared by domain types and standards (#203). */
export const DomainTypeStatusSchema = z.enum(["active", "deprecated", "retired"]);

export const StandardSchema = z.object({
  slug: z.string(),
  domain: z.string(),
  // #203 — a lifecycle field the loader used to STRIP. An author could mark a standard
  // deprecated, see the edit accepted, and watch it stay dispatchable with nothing saying
  // otherwise; the loader models what it models and silently discards the rest.
  //
  // OPTIONAL rather than defaulted, deliberately. A default here would make `status`
  // required on the runtime `Standard` type, which every hand-rolled literal (34 of them in
  // the suite alone) would then have to restate — noise that teaches nobody anything. The
  // LOADER applies the default, so a standard read from disk always carries one and a
  // standard built in memory need not care.
  status: DomainTypeStatusSchema.optional(),
  agents: z.array(z.unknown()).optional(),       // compose input (agent slugs/objects)
  agent_slugs: z.array(z.string()).optional(),   // the file shape (resolved to agents on load)
  phases: z.array(PhaseSchema),
  eval_slugs: z.array(z.string()).readonly().optional(),
  input_types: z.array(z.string()).readonly().optional(),
  output_types: z.array(z.string()).readonly().optional(),
  // TODO(#194): plumbed end-to-end but NOT yet enforced — the runtime doesn't read this K-cap.
  // A consumer reading it from the schema must not assume enforcement until #194 (the caller-driven
  // examine⇄amend driver) lands. Tracked, non-blocking.
  max_examine_rounds: z.number().optional(),
  description: z.string().optional(),
});
export type StandardInput = z.input<typeof StandardSchema>;
export type StandardOutput = z.output<typeof StandardSchema>;

// ── Skill — the package shape. Reconciles the two current shapes (SkillMeta typed + SkillRecord
//    {slug;[k]:unknown} bag) into one. SHAPE-aligned only: determinism_ratio + fixtures are
//    fields/artifacts the schema knows, but the OG rigid "fixtures pass ≥ threshold to PROMOTE"
//    ceremony is deliberately NOT a schema invariant — promotion strictness is a separate, tunable
//    policy. The fixture/determinism runner still enforces "fixtures pass + deterministic" in CI. ──
export const NetworkGrantSchema = z.object({
  allow: z.array(z.string()).default([]),
  methods: z.array(z.string()).optional(),
  max_requests: z.number().optional(),
  max_bytes: z.number().optional(),
});
export const SkillPermissionSchema = z.object({
  tier: z.number().optional(),
  network: NetworkGrantSchema.optional(),
});
export const SkillSchema = z.object({
  slug: z.string(),
  version: z.number().optional(),
  skill_type: z.string().optional(),
  input_type: z.string().optional(),
  output_type: z.string().optional(),
  corpus: z.string().optional(),
  determinism_ratio: z.number().optional(),
  permission: SkillPermissionSchema.optional(),
  description: z.string().optional(),
  timeout_ms: z.number().optional(),
  // a package declares fixtures (test suite + determinism meter) + its code. Present so skill_define
  // is package-aware (meta + fixtures + code), not the retired flat {slug, domain, md}.
  fixtures: z.array(z.unknown()).optional(),
  code: z.string().optional(),
  md: z.string().optional(),
});

// ── Eval — retire the {slug;[k]:unknown} bag; the loader validates eval files against this. ──
export const EvalSchema = z.object({
  slug: z.string(),
  domain: z.string().optional(),
  on_type: z.string().optional(),
  non_empty_fields: z.array(z.string()).optional(),
  // free-text description of the assertion the eval encodes (the runtime scores via on_type +
  // non_empty_fields; `asserts` is the human-readable intent, not a machine list).
  asserts: z.string().optional(),
});

// ── DomainType — the ONE source for the persisted type record. The loader's DomainTypeRecord and
//    the registry's working projection both derive from this (no more three near-duplicate defs),
//    and type_register's MCP surface is generated from it. version/status default (every on-disk
//    file carries version:1 + status:"active"), so z.output has them present — the loader keys on
//    `slug@version` and reads status — while z.input leaves them optional for the register op. ──
export const DomainTypeSchema = z.object({
  slug: z.string(),
  version: z.number().default(1),
  extends: z.string(),
  domain: z.string(),
  status: DomainTypeStatusSchema.default("active"),
  description: z.string().optional(),
  schema: z.record(z.unknown()),
  required_fields: z.array(z.string()).default([]),
});

export type SkillOutput = z.output<typeof SkillSchema>;
export type EvalOutput = z.output<typeof EvalSchema>;
export type DomainTypeOutput = z.output<typeof DomainTypeSchema>;

// ── The institutional layer — institutions, organizations, agents-as-members, chairs, seats,
//    lineage, keys. The DEFINITIONS live here (public structure, one Zod source); the INSTANCES
//    (a real institution's orgs, named agents, issued keys) live in a governed instance store and
//    are written only through the MCP surface. Same discipline as every class above: the same
//    concepts had grown three disagreeing representations (engine files, hand-shaped instance
//    tables, empty carryover tables); this is the one source they all derive from.
//
//    An agent RECORD is membership/identity — who exists in the organization, human and model on
//    the SAME contract — distinct from the performer profile (AgentSchema above), which is what a
//    seat renders when the agent plays. A human record links to its auth account; a model record
//    simply has no auth account. Chairs carry the configuration (role, function, mission,
//    required_skills, caps, obligations); agents are the few named players who swap into them. ──

/** The typed lineage-edge vocabulary. Caps grant these; lineage edges are made of them. */
export const LineageEdgeTypeSchema = z.enum(["anchored-in", "produced-by", "evolved-from", "descends-from"]);

// Slugs NAME identities; LOOKUPS go by id. The instance store assigns each institutional
// identity a stable uuid; references and RLS key on the id, never the slug.
export const InstitutionSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["institution", "personal"]),
  laws: z.array(z.string()).default([]),
  wiki_space: z.string().optional(),
  sovereign: z.boolean().default(false),
});

export const OrganizationSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  charter: z.string().nullable().default(null),
  address: z.string().optional(),
  parent_org: z.string().nullable().default(null),
});

/** Membership/identity record: human and model agents on the SAME contract. */
export const AgentRecordSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["human", "steve"]),
  is_institution: z.boolean().default(false),
  skill_slugs: z.array(z.string()).default([]),
  // Lifecycle: nothing is active until governed so; "named" is sealed through the naming
  // ceremony (never self-approved — the proposal routes to the human governor).
  status: z.enum(["proposed", "named", "active", "retired"]).default("proposed"),
  named_from_forebear: z.string().nullable().default(null),
  // The auth link for human agents (the org's identity provider user id). A model agent
  // has no auth account; its authority is always a delegated, attenuated grant.
  auth_user_id: z.string().nullable().default(null),
});

export const OrgMemberSchema = z.object({ org_slug: z.string(), agent_slug: z.string() });
export const OrgInstitutionSchema = z.object({ org_slug: z.string(), institution_slug: z.string() });

/** A capability grant: a typed lineage-edge scope, optionally expiring. The grant IS the policy. */
export const EdgeCapGrantSchema = z.object({
  edge_type: LineageEdgeTypeSchema,
  scope: z.record(z.unknown()),
  expires: z.string().nullable().default(null),
});

/** The chair-contract dispatch grant — the office names which standards its incumbent may
 *  run. Authority sits on the chair; a credential presented by the incumbent may only
 *  narrow it, never widen it. (This is the shape the store's authorization function reads:
 *  a flat cap, not a scope smuggled inside a lineage edge.) */
export const DispatchCapGrantSchema = z.object({
  grant: z.literal("dispatch"),
  standards: z.array(z.string()).readonly(),
  expires: z.string().nullable().default(null),
});

/** A chair cap is a lineage-edge grant or a dispatch grant. One union, one Zod source. */
export const CapGrantSchema = z.union([EdgeCapGrantSchema, DispatchCapGrantSchema]);

/** The chair is the thing: the seat's configuration, not a person. */
export const InstitutionalChairSchema = z.object({
  id: z.string().optional(),
  institution_slug: z.string(),
  role: z.string(),
  /** The human office: this chair is held by a person, never a model agent. */
  human: z.boolean().optional(),
  function: PrimitiveSchema,
  mission: z.string(),
  required_skills: z.array(z.string()).default([]),
  caps: z.array(CapGrantSchema).default([]),
  obligations: z.array(z.string()).default([]),
});

/** A seat: a named agent bound into a chair for an org, witnessed. */
export const ChairAssignmentSchema = z.object({
  id: z.string().optional(),
  chair_id: z.string(),
  agent_slug: z.string(),
  org_slug: z.string(),
  contract_caps: z.array(CapGrantSchema).default([]),
  witnessed_by: z.string().nullable().default(null),
});

/** Cross-institution exposure happens only by contract across the wall. */
export const ExchangeContractSchema = z.object({
  id: z.string().optional(),
  from_institution: z.string(),
  to_institution: z.string(),
  caps: z.array(CapGrantSchema).default([]),
  witnessed_by: z.string().nullable().default(null),
});

export const ForebearSchema = z.object({
  slug: z.string(),
  institution_slug: z.string(),
  name: z.string(),
  domain: z.string().optional(),
  what_taken: z.string().optional(),
  kind: z.string().optional(),
});

export const NorthstarSchema = z.object({
  slug: z.string(),
  institution_slug: z.string(),
  ordinal: z.number().optional(),
  kind: z.string().optional(),
  title: z.string(),
  statement: z.string(),
  source: z.record(z.unknown()).optional(),
  quote: z.string().optional(),
});

export const LineageEdgeSchema = z.object({
  id: z.number().optional(),
  institution_slug: z.string(),
  edge_type: LineageEdgeTypeSchema,
  from_node: z.string(),
  to_node: z.string(),
  kind: z.string().optional(),
  source: z.record(z.unknown()).optional(),
});

/** The issued org service key DOCUMENT — self-describing (key id, org scope, issuer, scopes,
 *  endpoints) so downstream images have a uniform understanding of what they hold. STRICT by
 *  construction: the secret has no field to live in, so a record carrying key material fails to
 *  parse. Org-scoped because the organization is the resource-usage boundary. Never a platform
 *  service_role. */
export const OrgServiceKeySchema = z
  .object({
    key_id: z.string(),
    org_slug: z.string(),
    issuer: z.string(),
    scopes: z.array(z.string()).default([]),
    endpoints: z.record(z.string()).optional(),
    issued_at: z.string().optional(),
    expires: z.string().nullable().default(null),
    status: z.enum(["active", "revoked"]).default("active"),
  })
  .strict();

export type InstitutionOutput = z.output<typeof InstitutionSchema>;
export type OrganizationOutput = z.output<typeof OrganizationSchema>;
export type AgentRecordOutput = z.output<typeof AgentRecordSchema>;
export type CapGrant = z.output<typeof CapGrantSchema>;
export type InstitutionalChairOutput = z.output<typeof InstitutionalChairSchema>;
export type ChairAssignmentOutput = z.output<typeof ChairAssignmentSchema>;
export type ExchangeContractOutput = z.output<typeof ExchangeContractSchema>;
export type ForebearOutput = z.output<typeof ForebearSchema>;
export type NorthstarOutput = z.output<typeof NorthstarSchema>;
export type LineageEdgeOutput = z.output<typeof LineageEdgeSchema>;
export type OrgServiceKeyOutput = z.output<typeof OrgServiceKeySchema>;

// ── zod → MCP input_schema properties. The MCP tool definitions (mcp.ts) derive their hand-written
//    field lists from here, so the write-surface can never drift from the schema. Maps each top-level
//    field to its coarse JSON type; optionals/defaults are flattened (MCP advertises the field). ──
type JsonType = "string" | "number" | "boolean" | "array" | "object";
function jsonTypeOf(schema: z.ZodTypeAny): JsonType {
  let s: z.ZodTypeAny = schema;
  // Unwrap the WRAPPER types (optional/default/nullable/readonly via `innerType`, effects via
  // `schema`) to the inner type. Deliberately NOT `_def.type`: on a ZodArray that key holds the
  // ELEMENT schema, so following it would descend into the array and report the element's scalar
  // type — the bug that advertised `primitives: z.array(enum)` as "string" and broke agent_define.
  // Bound is a deliberate safety cap, not a real limit: the genome's deepest field nests ~3 wrappers
  // (e.g. `.array().readonly().optional()`), so 10 is unreachable in practice — it exists only so a
  // future pathological/cyclic schema can't spin here. Raise it if a real field ever approaches it.
  for (let i = 0; i < 10; i++) {
    const def = (s as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
    const inner = def?.innerType ?? def?.schema;
    if (inner && inner instanceof z.ZodType) { s = inner; continue; }
    break;
  }
  if (s instanceof z.ZodString || s instanceof z.ZodEnum) return "string";
  if (s instanceof z.ZodNumber) return "number";
  if (s instanceof z.ZodBoolean) return "boolean";
  if (s instanceof z.ZodArray || s instanceof z.ZodTuple) return "array";
  return "object";
}

/** The MCP `properties` map (field → JSON type) for a genome class schema. */
export function zodToMcpProps(schema: z.ZodObject<z.ZodRawShape>): Record<string, JsonType> {
  return Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => [k, jsonTypeOf(v as z.ZodTypeAny)]));
}
