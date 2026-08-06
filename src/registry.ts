import Ajv from "ajv";
import { type DomainTypeOutput } from "./genome_schema.js";
import { CORE_TYPES, type CoreType } from "./core_types.js";
import { CORE_SUBSTANCE } from "./output_validation.js";
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

// The registry's working view of a domain type — the fields its resolve/validate logic reads — as an
// explicit PROJECTION of the single Zod source (genome_schema.ts DomainTypeOutput), not a third
// hand-written restatement. The persisted record additionally carries version/status/description,
// which the registry doesn't use; deriving the shared fields keeps them from drifting from the source.
export type DomainType = Pick<DomainTypeOutput, "slug" | "extends" | "domain" | "schema" | "required_fields">;

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

/**
 * Describe how an overload makes a type UNSEALABLE, or null when it does not.
 *
 * Only a TYPE mismatch qualifies, and that is a deliberate narrowing after measurement. The
 * other two overloads worth worrying about — a weakened `minItems`, a dropped per-item
 * `required` — are already backstopped at runtime: `output_validation.ts` rejects an empty
 * floor array outright and enforces `item_requires` per item, whatever the subtype's schema
 * says. So they change nothing observable, and refusing them would reject types the engine's
 * own suite builds ON PURPOSE (`seal_core_invariant_wiring.test.ts` constructs a loose
 * `loose-doc` precisely to prove the floor catches what the schema permits).
 *
 * A type mismatch is different in kind: the floor wants an array and the schema wants a
 * string, so NO payload satisfies both and the type is dead on arrival. That is #264's live
 * example — `fix-plan` declaring `steps: { type: "string" }`.
 */
function overloadClash(
  base: Record<string, unknown> | undefined,
  own: Record<string, unknown>,
  rule: { shape: string; item_requires?: string } | undefined,
): string | null {
  if (!base) return null;

  // `type` may legally be a STRING or an ARRAY of strings. Reading only the string spelling
  // let `type: ["string","null"]` through — which is #264's own example written the other
  // legal way. Compare as sets: an overload that shares no type with the core is unsatisfiable.
  const asSet = (v: unknown): Set<string> | null =>
    typeof v === "string" ? new Set([v]) : Array.isArray(v) && v.every((x) => typeof x === "string") ? new Set(v as string[]) : null;
  const b = asSet(base["type"]);
  const o = asSet(own["type"]);
  if (b && o && ![...o].some((t) => b.has(t))) {
    return `core declares type ${JSON.stringify(base["type"])}, subtype declares ${JSON.stringify(own["type"])}`;
  }

  // A floor that can only ever be EMPTY is unsatisfiable, because the runtime floor rejects
  // an empty array and an empty string. These are the "technically the right type" spellings
  // of the same defect.
  if (own["maxItems"] === 0) return `subtype caps "maxItems" at 0, and the floor rejects an empty array`;
  if (own["maxLength"] === 0) return `subtype caps "maxLength" at 0, and the floor rejects an empty string`;

  // `const` / `enum` pin the value to a closed set. If nothing in that set can satisfy the
  // floor's shape, no payload can satisfy both.
  const closed = own["const"] !== undefined ? [own["const"]] : Array.isArray(own["enum"]) ? (own["enum"] as unknown[]) : null;
  if (closed && rule) {
    const satisfies = (v: unknown): boolean =>
      rule.shape === "array" ? Array.isArray(v) && v.length > 0 : typeof v === "string" && v.length > 0;
    if (!closed.some(satisfies)) {
      return `subtype pins the value to ${JSON.stringify(closed)}, none of which satisfies the ${rule.shape} floor`;
    }
  }

  // The per-item field the core REQUIRES must remain satisfiable. Dropping it from `required`
  // is harmless (the runtime enforces it anyway); declaring it as a type the runtime will
  // never accept is not — the runtime wants a non-empty string.
  if (rule?.item_requires) {
    const itemProp = (own["items"] as { properties?: Record<string, unknown> } | undefined)?.properties?.[rule.item_requires] as
      | Record<string, unknown>
      | undefined;
    const t = itemProp ? asSet(itemProp["type"]) : null;
    if (t && !t.has("string")) {
      return `subtype declares item field "${rule.item_requires}" as ${JSON.stringify(itemProp?.["type"])}, and the floor requires a non-empty string`;
    }
  }
  return null;
}

/**
 * The rules a domain type must satisfy to be REPRESENTABLE at all — as distinct from the
 * per-output checks in `validate()`.
 *
 * Exported because there are two doors into the type table — `registerType` here and the
 * loader reading files off disk — and a rule enforced at only one of them is a rule with a
 * way around it. Returns a reason, or null when the type is fine.
 */
export function domainTypeDefect(def: { slug: string; extends: string; schema?: unknown }): string | null {
  // #272 — a domain type must not be NAMED after a core.
  //
  // `coreTypeOf` answers "what core is this really" by short-circuiting on CORE_TYPES before
  // consulting the registry. So a type registered as `Signal` resolves to "Signal" on its
  // NAME while the registry says it extends something else, and the core-agreement check
  // (#263) inverts: the contradicted pair seals, the correct pair is refused, and the
  // rejection asserts something about the registry that is not true.
  //
  // Refusing the name is cheaper and stronger than teaching every resolver to disambiguate —
  // the ambiguity stops being representable.
  // Narrowly: only when the slug names a core it does NOT extend. `{slug:"Signal",
  // extends:"Signal"}` is a legitimate bare-core alias — both answers agree, so there is no
  // ambiguity to resolve and several suites rely on it. The defect is a name that claims one
  // core while `extends` says another, which is what makes the two resolutions disagree.
  if (isCoreType(def.slug) && def.slug !== def.extends) {
    return `slug "${def.slug}" names a core type but extends "${def.extends}" — "what core is this" would have two contradictory answers (the name says ${def.slug}, the registry says ${def.extends}), and resolution short-circuits on the NAME`;
  }

  // #264 — a floor field overloaded into something the core forbids.
  //
  // `{...baseProps, ...ownProps}` lets a subtype's declaration win silently, so redeclaring
  // e.g. `steps` as a string yields a type NO payload can satisfy: the merged schema wants a
  // string, the substance floor wants a non-empty array. The genome loads clean, load_errors
  // is empty, and the first symptom is a seal abort at a terminal phase — the #1 documented
  // footgun downstream.
  //
  // NARROWING stays legal, and is the common legitimate case (`grant-opportunity` narrows
  // Signal's `source` to an enum, which strengthens the floor). Only contradiction is refused.
  // The GUARDED table, not a second copy. A hand-rolled duplicate here would return
  // `undefined` for a seventh core and skip this check silently — a silent genome drop
  // reintroduced inside the fix named after silent genome drops. `CORE_SUBSTANCE` throws at
  // import if a core has no floor, so the two cannot drift.
  const rule = CORE_SUBSTANCE[def.extends as CoreType];
  const floor = rule?.field;
  if (floor) {
    const own = (def.schema as { properties?: Record<string, unknown> } | undefined)?.properties?.[floor];
    if (own !== undefined) {
      const clash = overloadClash(
        CORE_SCHEMA_PROPS[def.extends]?.[floor] as Record<string, unknown> | undefined,
        own as Record<string, unknown>,
        rule,
      );
      if (clash) {
        return `redeclares "${floor}", the substance floor inherited from ${def.extends}, with an incompatible type (${clash}) — the runtime floor and this schema cannot both be satisfied, so the type is unsealable under any input`;
      }
    }
  }
  return null;
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
      const defect = domainTypeDefect(def);
      if (defect) throw new Error(`domain type "${def.slug}" rejected: ${defect}`);
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
      // "Still holds" is now a fact rather than a claim: outputs.write runs validateOutput
      // on every seal, so a bare core meets the same substance floor as its subtypes (#227).
      if (isCoreType(output.domain_type)) return { valid: true, errors: [] };
      const dt = types.get(output.domain_type);
      if (!dt) return { valid: false, errors: [`unknown domain_type "${output.domain_type}"`] };
      // Inherit the base core type's properties, then let the subtype overload + extend.
      //
      // MAINTAINER RULING (#227) — "There's no subtype thing. It's all the way top to
      // bottom." This REPLACES the stance that used to be documented here: that a core's
      // base fields are "available, not forced" on a subtype, so `required` stays the
      // subtype's own and existing instances that carry no base field still validate.
      //
      // That stance is wrong. Every core carries ONE substance floor — the declared field
      // that makes its output answerable to someone else (Signal.source, Interpretation.claims,
      // Plan.steps, Judgment.criteria, Artifact.validation_criteria, Verdict.checks) — and
      // that floor is FORCED on every sealed output of that core, bare core or domain
      // subtype alike. See src/output_validation.ts for the table and the per-core reasoning.
      //
      // The forcing lives at the seal boundary (outputs.write → validateOutput), not here,
      // for a reason: it must hold on the paths this function deliberately does not reach —
      // an absent domain_type (line 140), a bare core type as the domain_type (line 144),
      // and a subtype that overloads an inherited floor away (#230). Enforcing it here as
      // well would leave those three holes open. What this function still owns is the
      // subtype's OWN declared contract; `required` below stays the subtype's own because
      // the core's floor is already enforced unconditionally one layer out — not because
      // base fields are optional.
      const baseProps = CORE_SCHEMA_PROPS[dt.extends] ?? {};
      const ownProps = (dt.schema as { properties?: Record<string, unknown> }).properties ?? {};
      // #200 — honor the type's declared additionalProperties. Closed-by-default
      // stays the discipline (undeclared → false), but a type that opts into open
      // extension with `additionalProperties: true` accepts agent-added contextual
      // fields at seal instead of aborting the terminal chair.
      const additionalProperties =
        (dt.schema as { additionalProperties?: boolean }).additionalProperties ?? false;
      // #229 — a type's required fields may be declared in EITHER place, and both are
      // honored. Two authoring conventions exist in the genome and nothing reconciles
      // them: most types populate `required_fields` and leave `schema.required` empty;
      // the hand-authored seeding/bootstrap types do the reverse. Reading only
      // `required_fields` (as this did) silently discarded the declaration of every type
      // in the second group, so `{}` sealed as a well-formed instance of a type declaring
      // 3-6 required fields.
      //
      // UNION, not precedence. `type_extend` (src/server.ts:609) resolves the same
      // ambiguity as `schema.required ?? required_fields`, but precedence is the wrong
      // rule at seal time: it makes one declaration silently void the other. No type in
      // the genome populates both today, so the two rules are indistinguishable on
      // current data — which is exactly why the safer rule should be the one that gets
      // frozen in. Everything an author wrote down is enforced.
      const declaredRequired = [
        ...new Set([
          ...(((dt.schema as { required?: string[] }).required) ?? []),
          ...dt.required_fields,
        ]),
      ];
      const schema = {
        type: "object",
        properties: { ...baseProps, ...ownProps },
        required: declaredRequired,
        additionalProperties,
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
