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

/**
 * Tools in the agent's grant that belong to no declared scope class.
 *
 * Surfaced so an operator sees them while authoring rather than discovering, mid-run, that a
 * chair silently did not receive a tool it was granted. A gate that drops a tool without saying
 * so trades one silent failure for another.
 */
export function undeclaredScopeTools(agent_allowed: readonly string[]): string[] {
  return agent_allowed.filter(
    (t) => !READ_TOOLS.has(t) && !WRITE_TOOLS.has(t) && !DEPLOY_TOOLS.has(t),
  );
}

/**
 * The tools a grant actually exposes to a chair, for a phase. FAIL-CLOSED.
 *
 * v1 walked the allowed list and filtered only the tools it RECOGNISED — members of
 * READ_TOOLS, WRITE_TOOLS or DEPLOY_TOOLS. A tool in none of the three matched no branch and
 * fell through to `result.push(tool)`: exposed unconditionally, whatever the grant said. The
 * gate's coverage was its own allowlist, so the tools it had never heard of were precisely the
 * ones it could not stop. A consumer reported it as "a permissions check silently defaults to
 * 'granted' whenever a tool declares no required scopes", and that was accurate.
 *
 * An unrecognised tool is not a safe tool; it is one nobody has classified, and the only
 * honest answer to "may this chair use it?" is no.
 */
export function exposedTools(q: ExposeQuery): string[] {
  const result: string[] = [];
  for (const tool of q.agent_allowed) {
    if (DEPLOY_TOOLS.has(tool)) {
      if (!q.grant.permissions.deploy) continue;
    } else if (WRITE_TOOLS.has(tool)) {
      if (!WRITE_PHASES.has(q.phase)) continue;
      if (!q.grant.permissions.write) continue;
    } else if (READ_TOOLS.has(tool)) {
      if (!q.grant.permissions.read) continue;
      if (!READ_PHASES.has(q.phase) && !WRITE_PHASES.has(q.phase)) continue;
    } else {
      // No declared scope class. Deny — this is the branch v1 did not have.
      continue;
    }
    result.push(tool);
  }
  return result;
}
