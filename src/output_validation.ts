import { CORE_TYPES, type CoreType } from "./core_types.js";

export interface OutputCandidate {
  core_type: CoreType;
  domain_type: string;
  data: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

interface CheckEntry {
  method?: unknown;
  target_ref?: unknown;
  result?: unknown;
}

// ── The core-type substance invariant ────────────────────────────────────────────────
//
// MAINTAINER RULING (#227): "There's no subtype thing. It's all the way top to bottom."
//
// Every core type carries ONE substance floor, and it is enforced on EVERY sealed output
// of that core — whether the output is typed as a bare core ("Artifact", "Interpretation")
// or as a domain subtype (`grant-draft`, `summary`). There is no bare-core exemption and no
// subtype exemption. This is the rule that replaces the "base fields are available, not
// forced" stance formerly documented in src/registry.ts.
//
// WHY ONE FIELD AND NOT THE CORE'S WHOLE `required` LIST. Each core declares 5-6 required
// fields; most are bookkeeping the runtime supplies or the subtype renames. The floor is
// the single declared field that makes the output ANSWERABLE TO SOMEONE ELSE — the thing a
// reader can re-acquire, contradict, execute, or dispute. Strip it and what seals is a shell
// with a genuine content_sha and genuine provenance edges: `output_trace` reports an intact
// audit chain over nothing. That is the failure mode (#221/#227) this closes, and it is the
// same question Artifact and Verdict already answered.
//
// Per core, and why that field and not its siblings:
//
//   Signal         → `source`   "Raw acquired data from a source." A Signal is an assertion
//                               about the world; `source` is the only thing that lets anyone
//                               re-acquire it, date it, or bound its trust. Runner-up `data`
//                               was rejected: every Signal subtype in the genome declares its
//                               payload as named fields (`text`, `repo_path`, `description`)
//                               and none uses `data`, so a floor there would demand a
//                               redundant re-wrapping of every payload rather than the
//                               addition of information. `completeness`/`acquisition_cost`
//                               cannot carry a floor at all — 0 is a legitimate value.
//   Interpretation → `claims`   "Meaning extracted from signals." The claims ARE the extracted
//                               meaning and the only part of an Interpretation that can be
//                               contradicted. `frame` names the lens but asserts nothing;
//                               `confidence: 0` is legitimate.
//   Plan           → `steps`    "Sequenced actions with dependencies." The steps are the only
//                               part anyone can execute or audit against. `objective` states
//                               intent; `budget: 0` is legitimate.
//   Judgment       → `criteria` "Evaluation against criteria." Named criteria are what make a
//                               judgement disputable — the exact role `validation_criteria`
//                               plays for Artifact. A Judgment that renders opinions against
//                               nothing is unfalsifiable.
//   Artifact       → `validation_criteria`  (pre-existing) an artifact nobody can check is
//                               not an artifact.
//   Verdict        → `checks`   (pre-existing) a verification with no evidence is not one;
//                               each check must additionally name its `method`.
//
// ABSENT is rejected, not only EMPTY (#228 path (b)) — `!Array.isArray` covers both.
// The floors are also DECLARED, in core_types/<core>.json (`minItems: 1` / `minLength: 1`),
// so the schema on disk says what this code enforces.
export interface SubstanceRule {
  field: string;
  /** the declared JSON type of the floor field — decides what "empty" means */
  shape: "array" | "string";
  /** for array floors: a property every item must carry as a non-empty string */
  item_requires?: string;
}

export const CORE_SUBSTANCE: Readonly<Record<CoreType, SubstanceRule>> = {
  Signal: { field: "source", shape: "string" },
  Interpretation: { field: "claims", shape: "array" },
  Plan: { field: "steps", shape: "array" },
  Judgment: { field: "criteria", shape: "array" },
  Artifact: { field: "validation_criteria", shape: "array" },
  Verdict: { field: "checks", shape: "array", item_requires: "method" },
};

// Compile-time + load-time guard: every core has a floor. A seventh core (or a rename)
// cannot land without deciding what makes it substantive.
for (const core of CORE_TYPES) {
  if (!CORE_SUBSTANCE[core]) throw new Error(`core type "${core}" has no substance invariant`);
}

export function validateOutput(out: OutputCandidate): ValidationResult {
  const rule = CORE_SUBSTANCE[out.core_type];
  // An unrecognised core_type is not this function's contract to police (the loader and
  // the registry own that); it simply has no floor to apply.
  if (!rule) return { valid: true };

  const value = out.data[rule.field];

  if (rule.shape === "array") {
    if (!Array.isArray(value) || value.length === 0) {
      return {
        valid: false,
        reason: `${out.core_type} requires non-empty ${rule.field}[]`,
      };
    }
    if (rule.item_requires) {
      for (const item of value as CheckEntry[]) {
        const got = (item as Record<string, unknown> | null | undefined)?.[rule.item_requires];
        if (typeof got !== "string" || got.length === 0) {
          return {
            valid: false,
            reason: `${out.core_type}.${rule.field}[*].${rule.item_requires} is required (string)`,
          };
        }
      }
    }
    return { valid: true };
  }

  if (typeof value !== "string" || value.length === 0) {
    return {
      valid: false,
      reason: `${out.core_type} requires a non-empty ${rule.field}`,
    };
  }
  return { valid: true };
}
