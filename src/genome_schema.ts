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
  depends_on: z.array(z.string()).default([]),
  input_contract: z.array(z.string()).default([]),
  output_contract: z.array(z.string()).default([]),
  required_skills: z.array(z.string()).default([]),
});
export const PhaseSchema = z.object({ name: z.string(), chairs: z.array(ChairSchema) });
export const StandardSchema = z.object({
  slug: z.string(),
  domain: z.string(),
  agents: z.array(z.unknown()).optional(),       // compose input (agent slugs/objects)
  agent_slugs: z.array(z.string()).optional(),   // the file shape (resolved to agents on load)
  phases: z.array(PhaseSchema),
  eval_slugs: z.array(z.string()).optional(),
  input_types: z.array(z.string()).optional(),
  output_types: z.array(z.string()).optional(),
  max_examine_rounds: z.number().optional(),
  description: z.string().optional(),
});

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

// ── DomainType — drives type_register/type_extend + the loader's type-DEFINITION validation
//    (distinct from registry.validate, which checks output DATA against a type's schema). ──
export const DomainTypeSchema = z.object({
  slug: z.string(),
  version: z.number().optional(),
  extends: z.string(),
  domain: z.string(),
  status: z.string().optional(),
  schema: z.record(z.unknown()),
  required_fields: z.array(z.string()).default([]),
});

export type SkillOutput = z.output<typeof SkillSchema>;
export type EvalOutput = z.output<typeof EvalSchema>;
export type DomainTypeOutput = z.output<typeof DomainTypeSchema>;

// ── zod → MCP input_schema properties. The MCP tool definitions (mcp.ts) derive their hand-written
//    field lists from here, so the write-surface can never drift from the schema. Maps each top-level
//    field to its coarse JSON type; optionals/defaults are flattened (MCP advertises the field). ──
type JsonType = "string" | "number" | "boolean" | "array" | "object";
function jsonTypeOf(schema: z.ZodTypeAny): JsonType {
  let s: z.ZodTypeAny = schema;
  // unwrap optional/default/nullable/readonly/effects to the inner type
  for (let i = 0; i < 10; i++) {
    const def = (s as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny } })._def;
    const inner = def?.innerType ?? def?.schema ?? def?.type;
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
