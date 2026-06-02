import type { CoreType } from "./core_types.js";

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

export function validateOutput(out: OutputCandidate): ValidationResult {
  if (out.core_type === "Artifact") {
    const vc = out.data["validation_criteria"];
    if (!Array.isArray(vc) || vc.length === 0) {
      return {
        valid: false,
        reason: "Artifact requires non-empty validation_criteria[]",
      };
    }
  }

  if (out.core_type === "Verdict") {
    const checks = out.data["checks"];
    if (!Array.isArray(checks) || checks.length === 0) {
      return { valid: false, reason: "Verdict requires non-empty checks[]" };
    }
    for (const c of checks as CheckEntry[]) {
      if (typeof c.method !== "string" || c.method.length === 0) {
        return {
          valid: false,
          reason: "Verdict.checks[*].method is required (string)",
        };
      }
    }
  }

  return { valid: true };
}
