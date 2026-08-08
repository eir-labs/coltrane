// The seal drill (WU-0008) — push a stub through the real seal path per contract
// type BEFORE any inference is spent. A standard whose contracts no payload can
// satisfy is caught at simulate prices (milliseconds, $0) instead of at a terminal
// chair (a failed gig). See tests/seal_drill.test.ts for the frozen rule.

import { CORE_TYPES, type CoreType } from "./core_types.js";
import { CORE_SUBSTANCE, validateOutput } from "./output_validation.js";
import { CANONICAL_CORE_TYPES } from "./canonical_core_types.js";
import type { Registry } from "./registry.js";

/**
 * A minimal payload the schema ITSELF describes: required fields filled with the
 * simplest type-conformant values (enum → first member, arrays → one item, objects →
 * their own required subset). If even this cannot seal, no payload can — which is the
 * defect the drill exists to name. Deliberately not a fuzzer: one honest attempt at
 * the schema's own floor.
 */
export function stubForSchema(schema: Record<string, unknown>): unknown {
  return stubValue(schema, 0);
}

function stubValue(s: Record<string, unknown> | undefined, depth: number): unknown {
  if (!s || depth > 6) return "stub";
  if (Array.isArray(s["enum"])) return (s["enum"] as unknown[])[0];
  if (s["const"] !== undefined) return s["const"];
  const t = Array.isArray(s["type"]) ? (s["type"] as string[])[0] : (s["type"] as string | undefined);
  switch (t) {
    case "string": {
      const min = typeof s["minLength"] === "number" ? (s["minLength"] as number) : 1;
      return "s".repeat(Math.max(1, min));
    }
    case "number":
    case "integer":
      return typeof s["minimum"] === "number" ? (s["minimum"] as number) : 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const min = typeof s["minItems"] === "number" ? (s["minItems"] as number) : 1;
      const item = stubValue(s["items"] as Record<string, unknown> | undefined, depth + 1);
      // Non-empty by default: every core substance floor rejects an empty array, so an
      // empty stub would fail for the drill's reasons rather than the schema's.
      return Array.from({ length: Math.max(1, min) }, () => item);
    }
    case "object":
    default: {
      if (t === undefined && !s["properties"]) return "stub";
      const props = (s["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const required = Array.isArray(s["required"]) ? (s["required"] as string[]) : [];
      const out: Record<string, unknown> = {};
      for (const k of required) out[k] = stubValue(props[k], depth + 1);
      return out;
    }
  }
}

export interface SealDrillFailure {
  phase: string;
  role: string;
  domain_type: string;
  errors: string[];
}

export interface SealDrillResult {
  ok: boolean;
  checked: string[];
  failures: SealDrillFailure[];
}

interface DrillableStandard {
  phases: ReadonlyArray<{
    name: string;
    chairs: ReadonlyArray<{ role: string; output_contract?: readonly string[] }>;
  }>;
}

const CORE_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
  CANONICAL_CORE_TYPES.map((c) => [c.slug, c.schema as Record<string, unknown>]),
);

function isCore(slug: string): slug is CoreType {
  return (CORE_TYPES as readonly string[]).includes(slug);
}

/** Drill every chair's contract types through the REAL seal path. */
export function sealDrill(standard: DrillableStandard, registry: Registry): SealDrillResult {
  const failures: SealDrillFailure[] = [];
  const checked = new Set<string>();

  for (const phase of standard.phases) {
    for (const chair of phase.chairs) {
      for (const slug of chair.output_contract ?? []) {
        checked.add(slug);
        const fail = (errors: string[]) =>
          failures.push({ phase: phase.name, role: chair.role, domain_type: slug, errors });

        let core: CoreType | undefined;
        let schema: Record<string, unknown> | undefined;
        if (isCore(slug)) {
          core = slug;
          // Bare core: no domain schema; the stub only owes the substance floor, so
          // drill against the core's own canonical schema restricted to its floor.
          const rule = CORE_SUBSTANCE[slug];
          schema = {
            type: "object",
            properties: (CORE_SCHEMAS[slug]?.["properties"] as Record<string, unknown>) ?? {},
            required: rule ? [rule.field] : [],
          };
        } else {
          schema = registry.effectiveSchema(slug);
          if (!schema) {
            fail([`unknown domain type "${slug}" — nothing in the registry can seal it`]);
            continue;
          }
          core = registry.listTypes().find((t) => t.slug === slug)?.extends as CoreType | undefined;
        }

        const stub = stubForSchema(schema) as Record<string, unknown>;
        // Floor-aware stub repair: the substance floor demands non-empty content and,
        // for Verdict.checks, a `method` per item — make the stub honor the floor the
        // way any compliant producer must, so a failure below is the SCHEMA's fault.
        if (core) {
          const rule = CORE_SUBSTANCE[core];
          if (rule) {
            const v = stub[rule.field];
            if (rule.shape === "string" && (typeof v !== "string" || v.length === 0)) stub[rule.field] = "stub";
            if (rule.shape === "array") {
              const arr = Array.isArray(v) && v.length > 0 ? (v as unknown[]) : ["stub"];
              stub[rule.field] = rule.item_requires
                ? arr.map((x) =>
                    x && typeof x === "object"
                      ? { ...(x as Record<string, unknown>), [rule.item_requires!]: (x as Record<string, unknown>)[rule.item_requires!] ?? "stub" }
                      : { [rule.item_requires!]: "stub" },
                  )
                : arr;
            }
          }
        }

        const errors: string[] = [];
        if (!isCore(slug)) {
          // A schema the validator cannot even COMPILE (e.g. `enum: []`) throws here —
          // at gig time that is a terminal-chair exception, not even a clean seal
          // rejection. The drill downgrades the explosion to a named failure.
          try {
            const domainCheck = registry.validate({ core_type: core ?? "Signal", domain_type: slug, data: stub });
            if (!domainCheck.valid) errors.push(...domainCheck.errors);
          } catch (err) {
            errors.push(`schema does not compile: ${String(err instanceof Error ? err.message : err)}`);
          }
        }
        if (core) {
          const floorCheck = validateOutput({ core_type: core, domain_type: slug, data: stub });
          if (!floorCheck.valid) errors.push(floorCheck.reason ?? "core substance floor rejected the stub");
        }
        if (errors.length > 0) fail(errors);
      }
    }
  }

  return { ok: failures.length === 0, checked: [...checked], failures };
}
