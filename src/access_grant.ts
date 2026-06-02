export type ResourceType =
  | "repo"
  | "environment"
  | "database"
  | "api"
  | "email"
  | "crm"
  | "calendar"
  | "social"
  | "analytics";

export interface AccessGrant {
  id: string;
  company_id: string;
  resource_type: ResourceType;
  resource_uri: string;
  permissions: {
    read: boolean;
    write: boolean;
    execute: boolean;
    deploy: boolean;
  };
  scope: {
    branches: readonly string[];
    paths: readonly string[];
    excluded_paths: readonly string[];
    max_files_per_patch: number;
    max_lines_per_patch: number;
  };
  expires_at: string;
  requires_pr: boolean;
  requires_human_review: boolean;
  auto_revert_on_failure: boolean;
}

export type Phase = "SENSE" | "INTERPRET" | "JUDGE" | "PLAN" | "CREATE" | "VERIFY";

export interface TTLResult {
  valid: boolean;
  reason?: string;
  remaining_ms?: number;
}

export function checkGrantTTL(grant: AccessGrant, nowMs: number): TTLResult {
  const expiry = Date.parse(grant.expires_at);
  if (expiry <= nowMs) {
    return { valid: false, reason: `grant expired at ${grant.expires_at}` };
  }
  return { valid: true, remaining_ms: expiry - nowMs };
}

export interface PlanCheck {
  files: readonly string[];
  lines_changed: number;
}

export interface PlanResult {
  valid: boolean;
  reason?: string;
}

function matchesGlob(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => (seg === "**" ? ".*" : seg.replace(/\*/g, "[^/]*")))
        .join("/") +
      "$",
  );
  return re.test(path);
}

export function validatePlanAgainstGrant(
  plan: PlanCheck,
  grant: AccessGrant,
): PlanResult {
  if (plan.files.length > grant.scope.max_files_per_patch) {
    return {
      valid: false,
      reason: `plan exceeds max_files_per_patch (${plan.files.length} > ${grant.scope.max_files_per_patch})`,
    };
  }
  if (plan.lines_changed > grant.scope.max_lines_per_patch) {
    return {
      valid: false,
      reason: `plan exceeds max_lines_per_patch (${plan.lines_changed} > ${grant.scope.max_lines_per_patch})`,
    };
  }
  for (const f of plan.files) {
    for (const ex of grant.scope.excluded_paths) {
      if (matchesGlob(ex, f) || f === ex) {
        return { valid: false, reason: `file ${f} matches excluded path ${ex}` };
      }
    }
    const inScope = grant.scope.paths.some((p) => matchesGlob(p, f));
    if (!inScope) {
      return { valid: false, reason: `file ${f} is outside grant scope paths` };
    }
  }
  return { valid: true };
}

const READ_TOOLS = new Set([
  "url_scan",
  "file_read",
  "type_browse",
  "output_query",
  "type_resolve",
  "charter_read",
]);

const WRITE_TOOLS = new Set(["file_write", "shell_exec"]);
const DEPLOY_TOOLS = new Set(["deploy"]);

const READ_PHASES = new Set<Phase>(["SENSE", "INTERPRET", "JUDGE", "PLAN"]);
const WRITE_PHASES = new Set<Phase>(["CREATE"]);

export interface ExposeQuery {
  phase: Phase;
  agent_allowed: readonly string[];
  grant: AccessGrant;
}

export function exposedTools(q: ExposeQuery): string[] {
  const result: string[] = [];
  for (const tool of q.agent_allowed) {
    if (DEPLOY_TOOLS.has(tool) && !q.grant.permissions.deploy) continue;
    if (WRITE_TOOLS.has(tool)) {
      if (!WRITE_PHASES.has(q.phase)) continue;
      if (!q.grant.permissions.write) continue;
    }
    if (READ_TOOLS.has(tool)) {
      if (!q.grant.permissions.read) continue;
      if (!READ_PHASES.has(q.phase) && !WRITE_PHASES.has(q.phase)) continue;
    }
    result.push(tool);
  }
  return result;
}
