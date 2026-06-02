import Ajv from "ajv";
import { CORE_TYPES, type CoreType } from "./core_types.js";
import type { LoadedGenome } from "./loader.js";

export const RESOLVE_WEIGHTS = {
  field_coverage: 0.4,
  usage_gravity: 0.15,
  downstream_satisfaction: 0.2,
  domain_affinity: 0.15,
  recency: 0.1,
} as const;

export interface DomainType {
  slug: string;
  extends: string;
  domain: string;
  schema: Record<string, unknown>;
  required_fields: string[];
}

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
    validate(output) {
      const dt = types.get(output.domain_type);
      if (!dt) return { valid: false, errors: [`unknown domain_type "${output.domain_type}"`] };
      const schema = {
        type: "object",
        properties: (dt.schema as { properties?: Record<string, unknown> }).properties ?? {},
        required: dt.required_fields,
        additionalProperties: true,
      };
      const validateFn = ajv.compile(schema);
      const ok = validateFn(output.data);
      return { valid: ok === true, errors: (validateFn.errors ?? []).map((e) => e.message ?? "invalid") };
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
