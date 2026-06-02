import type { AccessGrant } from "./access_grant.js";

export type SubjectType = "company" | "lab" | "solo" | "oss" | "other";

export interface Product {
  name: string;
  type: string;
  url: string;
  description: string;
}

export interface NorthStar {
  goal: string;
  priority: "low" | "medium" | "high" | "critical";
  timeframe: string;
  metrics: readonly string[];
}

export interface Charter {
  subject_name: string;
  subject_type: SubjectType;
  charter: string;
  north_stars: readonly NorthStar[];
  products: readonly Product[];
  pain_points: readonly string[];
  tech_stack: readonly string[];
  existing_tools: readonly string[];
  access_grants: readonly AccessGrant[];
}

export interface ValidationIssue {
  path: string;
  reason: string;
}

export interface CharterValidation {
  valid: boolean;
  issues: readonly ValidationIssue[];
}

export class CharterError extends Error {}

const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_SUBJECT_TYPES = new Set<SubjectType>([
  "company",
  "lab",
  "solo",
  "oss",
  "other",
]);

export function validateCharter(ctx: unknown): CharterValidation {
  const issues: ValidationIssue[] = [];

  if (typeof ctx !== "object" || ctx === null) {
    return { valid: false, issues: [{ path: "$", reason: "context must be an object" }] };
  }
  const c = ctx as Record<string, unknown>;

  if (typeof c.subject_name !== "string" || c.subject_name.length === 0) {
    issues.push({ path: "subject_name", reason: "required non-empty string" });
  }

  if (
    typeof c.subject_type !== "string" ||
    !VALID_SUBJECT_TYPES.has(c.subject_type as SubjectType)
  ) {
    issues.push({
      path: "subject_type",
      reason: `must be one of ${[...VALID_SUBJECT_TYPES].join("|")}`,
    });
  }

  if (typeof c.charter !== "string" || c.charter.length === 0) {
    issues.push({ path: "charter", reason: "required non-empty string (mission / purpose)" });
  }

  if (!Array.isArray(c.north_stars)) {
    issues.push({ path: "north_stars", reason: "required array of NorthStar" });
  } else {
    c.north_stars.forEach((ns, i) => {
      const n = ns as Record<string, unknown>;
      if (typeof n.goal !== "string" || n.goal.length === 0) {
        issues.push({ path: `north_stars[${i}].goal`, reason: "required non-empty string" });
      }
      if (typeof n.priority !== "string" || !VALID_PRIORITIES.has(n.priority as string)) {
        issues.push({
          path: `north_stars[${i}].priority`,
          reason: `must be one of ${[...VALID_PRIORITIES].join("|")}`,
        });
      }
      if (typeof n.timeframe !== "string") {
        issues.push({ path: `north_stars[${i}].timeframe`, reason: "required string" });
      }
      if (!Array.isArray(n.metrics)) {
        issues.push({ path: `north_stars[${i}].metrics`, reason: "required array" });
      }
    });
  }

  if (!Array.isArray(c.products)) {
    issues.push({ path: "products", reason: "required array" });
  } else {
    c.products.forEach((p, i) => {
      const pp = p as Record<string, unknown>;
      for (const k of ["name", "type", "url", "description"]) {
        if (typeof pp[k] !== "string") {
          issues.push({ path: `products[${i}].${k}`, reason: "required string" });
        }
      }
    });
  }

  for (const k of ["pain_points", "tech_stack", "existing_tools"] as const) {
    if (!Array.isArray(c[k])) {
      issues.push({ path: k, reason: "required array of strings" });
    } else if ((c[k] as unknown[]).some((x) => typeof x !== "string")) {
      issues.push({ path: k, reason: "elements must all be strings" });
    }
  }

  if (!Array.isArray(c.access_grants)) {
    issues.push({ path: "access_grants", reason: "required array of AccessGrant" });
  }

  return { valid: issues.length === 0, issues };
}

export function loadCharter(value: unknown): Charter {
  const r = validateCharter(value);
  if (!r.valid) {
    throw new CharterError(
      `invalid Charter: ${r.issues.map((i) => `${i.path}: ${i.reason}`).join("; ")}`,
    );
  }
  return value as Charter;
}
