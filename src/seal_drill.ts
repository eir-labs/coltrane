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
/**
 * A short string satisfying `pattern`, or undefined when this drill cannot synthesise one.
 *
 * WHY: the stub honoured enum, const and minLength and IGNORED pattern, so `"sss"` was offered
 * against `(^|\n)[+-]` and the drill declared the type unsealable. That took software-change-pr-v1,
 * software-change-red-first-v0 and spec-drafting-v1 offline the moment red-spec gained its patch
 * pattern (30d1b48) — the whole RED-first loop refused at dispatch, for a constraint every real
 * drafter satisfies on every run.
 *
 * Deliberately a CANDIDATE LIST and not a regex inverter: inverting an arbitrary regex is its own
 * project, and a wrong inversion would be worse than no answer — it would let the drill assert a
 * type is sealable on the strength of a value no producer would ever write. Candidates cover the
 * shapes that actually appear in this genome's types (diff markers, dates, hashes, urls, ids). When
 * none matches, this returns undefined and the caller declines to drill the constraint rather than
 * condemning the standard — see the pattern-error filter in sealDrill.
 */
function stringMatching(pattern: string, minLength: number): string | undefined {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return undefined; // an uncompilable pattern is the schema's problem, reported elsewhere
  }
  const candidates = [
    "+", "-", "+a", "-a", "a\n+b", "diff --git a/x b/x\n+added",
    "a", "A", "0", "1", "ab", "abc", "abc123", "a-b", "a_b", "a.b", "a/b",
    "2026-01-01", "2026-01-01T00:00:00Z", "a@b.co", "https://example.com",
    "0".repeat(40), "0".repeat(64), "00000000-0000-4000-8000-000000000000",
    "s".repeat(Math.max(1, minLength)),
  ];
  for (const c of candidates) {
    if (c.length >= minLength && re.test(c)) return c;
  }
  return undefined;
}

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
      const plain = "s".repeat(Math.max(1, min));
      const pattern = typeof s["pattern"] === "string" ? (s["pattern"] as string) : undefined;
      if (!pattern) return plain;
      return stringMatching(pattern, min) ?? plain;
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
        // A PATTERN IS A CONTENT CONSTRAINT, NOT A STRUCTURAL ONE. This drill exists to catch a
        // standard that CANNOT seal — an unknown type, a required field with contradictory bounds,
        // a schema that will not compile. A `pattern` is a rule about what the AGENT writes, and the
        // agent satisfies it every run; the stub is a synthetic placeholder that was never going to.
        // Reporting it as "cannot seal" is a FALSE REFUSAL, and this one took the entire RED-first
        // change pipeline offline (30d1b48 → three standards undispatchable) while every one of them
        // was in fact perfectly sealable. stringMatching() now satisfies the patterns it can; what it
        // cannot, the drill declines to judge rather than condemning the standard on.
        const structural = errors.filter((e) => !/^pattern at /.test(e));
        if (structural.length > 0) fail(structural);
      }
    }
  }

  return { ok: failures.length === 0, checked: [...checked], failures };
}
