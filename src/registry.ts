import Ajv from "ajv";
import { type DomainTypeOutput } from "./genome_schema.js";
import { CORE_TYPES, type CoreType } from "./core_types.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";
import type { LoadedGenome } from "./loader.js";

// Base-type property inheritance (docs/genome-extension.md). A domain type extending
// a core type inherits the core's schema PROPERTIES — the base fields are "around at
// runtime" because the core is always loaded — so a subtype instance may carry them.
// The subtype OVERLOADS (same-named field wins) and EXTENDS (adds new fields). The 6
// cores are immutable, so we read their properties straight from the canonical set.
const CORE_SCHEMA_PROPS: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
  CANONICAL_CORE_TYPES.map((c) => [
    c.slug,
    ((c.schema as { properties?: Record<string, unknown> }).properties ?? {}),
  ]),
);

export const RESOLVE_WEIGHTS = {
  field_coverage: 0.4,
  usage_gravity: 0.15,
  downstream_satisfaction: 0.2,
  domain_affinity: 0.15,
  recency: 0.1,
} as const;

// DomainType is now derived from the single source (genome_schema.ts DomainTypeSchema). version +
// status are optional additions; the load-bearing shape (slug/extends/domain/schema/required_fields)
// is unchanged.
export type DomainType = DomainTypeOutput;

export interface ResolveQuery {
  extends: string;
  domain: string;
  required_fields: string[];
}

export interface ResolveResult {
  score: number;
  action: "use" | "extend" | "create";
  candidates: DomainType[];
}

export interface OutputToValidate {
  core_type: string;
  domain_type: string;
  input_refs?: string[];
  data: Record<string, unknown>;
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
}

export interface Registry {
  registerType(def: DomainType): { registered: true; version: number };
  resolveType(query: ResolveQuery): ResolveResult;
  validate(output: OutputToValidate): RegistryValidationResult;
  listTypes(): DomainType[];
  // Rebuild the type table from `defs`, in place. Used by genome_reload
  // (Rob #130) so editing domain_types/ on disk reflects in validation without
  // restarting the MCP server. Bypasses reuse-enforcement — this is a sync,
  // not authorship. Returns the slug diff vs the prior table.
  replaceTypes(defs: readonly DomainType[]): { added: string[]; modified: string[]; removed: string[] };
}

function isCoreType(slug: string): slug is CoreType {
  return (CORE_TYPES as readonly string[]).includes(slug);
}

export function createRegistry(initial: DomainType[] = []): Registry {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const types = new Map<string, DomainType>();
  for (const def of initial) types.set(def.slug, def);

  function score(query: ResolveQuery): ResolveResult {
    const candidates = [...types.values()].filter((t) => t.extends === query.extends);
    if (candidates.length === 0) return { score: 0, action: "create", candidates: [] };
    let best = 0;
    for (const c of candidates) {
      const covered = query.required_fields.filter((f) => c.required_fields.includes(f)).length;
      const coverage = query.required_fields.length === 0 ? 1 : covered / query.required_fields.length;
      const affinity = c.domain === query.domain ? 1 : 0;
      // usage_gravity, downstream_satisfaction, recency default to 1 until usage stats exist
      const s =
        100 *
        (RESOLVE_WEIGHTS.field_coverage * coverage +
          RESOLVE_WEIGHTS.usage_gravity * 1 +
          RESOLVE_WEIGHTS.downstream_satisfaction * 1 +
          RESOLVE_WEIGHTS.domain_affinity * affinity +
          RESOLVE_WEIGHTS.recency * 1);
      if (s > best) best = s;
    }
    const action = best >= 80 ? "use" : best >= 50 ? "extend" : "create";
    return { score: best, action, candidates };
  }

  return {
    registerType(def) {
      if (!isCoreType(def.extends)) {
        throw new Error(`extends must be a core type, got "${def.extends}"`);
      }
      const resolved = score({ extends: def.extends, domain: def.domain, required_fields: def.required_fields });
      if (resolved.score >= 80) {
        throw new Error(`reuse enforcement: an existing type scores ${resolved.score} (>=80)`);
      }
      types.set(def.slug, def);
      return { registered: true, version: 1 };
    },
    resolveType(query) {
      return score(query);
    },
    replaceTypes(defs) {
      const before = new Map(types);
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];
      types.clear();
      for (const def of defs) {
        if (!isCoreType(def.extends)) continue; // soft-skip; mirrors loader's stance
        types.set(def.slug, def);
        const prior = before.get(def.slug);
        if (!prior) added.push(def.slug);
        else if (JSON.stringify(prior) !== JSON.stringify(def)) modified.push(def.slug);
      }
      for (const slug of before.keys()) {
        if (!types.has(slug)) removed.push(slug);
      }
      return { added, modified, removed };
    },
    validate(output) {
      // Rob #133 — domain_type is OPTIONAL. Empty / missing means the output
      // is freeform vs. its core type (Interpretation, Plan, Artifact, …) but
      // doesn't conform to any registered domain schema. Examples that need
      // this: a discover-phase domain-model document, an analytical plan that
      // doesn't fit a typed plan-shape yet. The core_type discipline still
      // holds; only the domain-schema strictness is bypassed.
      if (!output.domain_type) return { valid: true, errors: [] };
      // A bare CORE type as the domain_type is a freeform output of that core (e.g. a
      // skill-backed chair that produces a plain Signal, no domain subtype). The core_type
      // discipline still holds; there's just no domain schema to enforce — same as above.
      if (isCoreType(output.domain_type)) return { valid: true, errors: [] };
      const dt = types.get(output.domain_type);
      if (!dt) return { valid: false, errors: [`unknown domain_type "${output.domain_type}"`] };
      // Inherit the base core type's properties, then let the subtype overload +
      // extend. required stays the subtype's own (base fields are available, not
      // forced) so existing instances that don't carry base fields still validate.
      const baseProps = CORE_SCHEMA_PROPS[dt.extends] ?? {};
      const ownProps = (dt.schema as { properties?: Record<string, unknown> }).properties ?? {};
      const schema = {
        type: "object",
        properties: { ...baseProps, ...ownProps },
        required: dt.required_fields,
        additionalProperties: false,
      };
      const validateFn = ajv.compile(schema);
      const ok = validateFn(output.data);
      // Preserve instancePath + keyword in the error projection so operators see
      // the failing field path, not just a type-class message. For property-level
      // failures Ajv puts the field in `params.missingProperty` (required) or
      // in `instancePath` (type mismatch) or `params.additionalProperty` (extras).
      return {
        valid: ok === true,
        errors: (validateFn.errors ?? []).map((e) => {
          const path = e.instancePath ?? "";
          const keyword = e.keyword ?? "";
          const message = e.message ?? "invalid";
          const params = (e.params as Record<string, unknown> | undefined) ?? {};
          const missing = typeof params["missingProperty"] === "string"
            ? ` '${params["missingProperty"] as string}'`
            : "";
          const additional = typeof params["additionalProperty"] === "string"
            ? ` '${params["additionalProperty"] as string}'`
            : "";
          const fieldHint = path ? ` at ${path}` : "";
          return `${keyword}${fieldHint}: ${message}${missing}${additional}`.trim();
        }),
      };
    },
    listTypes() {
      return [...types.values()];
    },
  };
}

export function loadRegistry(genome: LoadedGenome): Registry {
  const defs: DomainType[] = [...genome.domain_types.values()].map((d) => ({
    slug: d.slug,
    extends: d.extends,
    domain: d.domain,
    schema: d.schema as Record<string, unknown>,
    required_fields: [...d.required_fields],
  }));
  return createRegistry(defs);
}
