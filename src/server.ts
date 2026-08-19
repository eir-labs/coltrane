// §7 MCP server — the stdio entry that exposes MCP_TOOLS and routes calls.
// Two layers: a PURE dispatcher (dispatchTool — testable, no transport) and the
// stdio wiring (runStdioServer). Tools needing gig-execution context (output_write,
// gig_*) are honest `not_implemented` until src/runtime lands; the context-free
// tools (type_resolve/register/browse, standard_simulate) are wired now.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
// The wire names of the reserved relay↔child methods (restart guard, venue/8). Defined by the
// relay — the relay owns the conversation — and answered by the child handlers registered below.
import { RUNNING_GIGS_METHOD, ABORT_FOR_RESTART_METHOD } from "./server_relay.js";
import {
  MCP_TOOLS,
  requiresApproval,
  AGENT_STATUS_ORDER,
  STANDARD_STATUS_ORDER,
  SKILL_STATUS_ORDER,
  checkPromotion,
  PromotionError,
} from "./mcp.js";
import { createRegistry, loadRegistry, domainTypeDefect, type Registry, type DomainType } from "./registry.js";
import { loadGenome, resolveGenome, type SkillRecord, type EvalRecord, type LoadError } from "./loader.js";
import { SkillSchema, AgentSchema, StandardSchema, DomainTypeSchema, ChartSchema, VenueSchema, VenueObjectSchema, venueDefect } from "./genome_schema.js";
import {
  composeChart, runChart, chartHash, chartEntrySeedTypes, dispatchTarget,
  type Chart, type Venue, type ChartPlan, type ChartResult, type ResolvedMovement,
} from "./chart.js";
import type { GenomeStore, GenomeClass } from "./genome_store.js";
import { runSkillFixtures, executeSkill, loadFixtures } from "./skill_subprocess.js";
import { evolveSkill } from "./skills.js";
import { sealAgentDefinition, sealDefinition, sealSkillPackage, recordIdentity } from "./genome_writer.js";
import {
  createOutputStore, defaultOutputsPersistDir, performanceRoot,
  type OutputStore, type OutputRecord, type TraceDirection, type TraceMissingNode, type TraceRecordNode,
} from "./outputs.js";
import { createOutputMirror, defaultMirrorDir, outputPreview, mirrorStorageRef, type OutputMirror, type OutputMeta } from "./output_mirror.js";
import {
  FileLedger, LedgerError, LEDGER_SCHEMA_VERSION, defaultLedgerPath,
  type Ledger, type GovernanceLedgerEntry,
} from "./ledger.js";
import { sealDrill } from "./seal_drill.js";
import { standardSimulate } from "./simulate.js";
import { runGig, BudgetExhausted, GigAborted, ResumeRefused, partialGigUsage, partialBudgetState, type AgentInvoker } from "./runtime.js";
import { createCheckpointStore, createReuseStore, type CheckpointStore, type ReuseStore } from "./reuse.js";
import { makeClaudeInvoker, killLiveChairChildren } from "./claude_invoker.js";
import { dockerComposeRealizer, type VenueRealizer } from "./venue_realizer.js";
import { isDepth, DEPTHS, type Depth } from "./pricing.js";
import type { ToolProvider } from "./tool_providers.js";
import { ENGINE_MCP_SERVER } from "./tool_providers.js";
import type { ToolHook, ToolCallContext, PreOutcome } from "./hooks.js";
import {
  gigScopeRefusal,
  missingWorkerEnv,
  type CallerIdentity,
  type VenueCredentialGrant,
} from "./venue_credential.js";
import { composeStandard, defineAgent, CompositionError, type Standard, type Agent, type AgentDef, type PhaseDef } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE, type Primitive } from "./core_types.js";
import { proposeTypeChange, type DomainTypeDef } from "./type_versioning.js";
import { proposeAgentChange, evolveProfile, type AgentProfile } from "./agent_profile.js";
import { checkGrantTTL, validatePlanAgainstGrant, type AccessGrant, type PlanCheck } from "./access_grant.js";
import { loadCharter, CharterError } from "./charter.js";
import { COLTRANE_VERSION } from "./version.js";
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { newGigRun, applyGigProgress, gigEventLogLine, pruneGigRuns, type GigRunState } from "./gig_tracker.js";
import { isGig } from "./ledger.js";
import { SubthreadRecorder, ApiVersionMismatchError } from "./subthread_recorder.js";
import { canonJson, runFingerprint, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import type { LoadedGenome } from "./loader.js";

// Every StandardSchema field that is NOT structural (slug/domain/agents/agent_slugs/phases) is a
// passthrough that composeStandard must receive — eval_slugs, input_types (the gig contract),
// output_types, max_examine_rounds, description, … Derived from the schema's own key list so adding
// a field can't re-drift. Shared by standard_compose AND the agent_evolve cascade re-compose: both
// must thread the SAME fields, or one rejects a standard the other accepts (#204 — the cascade
// dropped input_types and wrongly failed entry chairs that read their contract from the gig input).
const STD_PASSTHROUGH = Object.keys(StandardSchema.shape).filter(
  (k) => !["slug", "domain", "agents", "agent_slugs", "phases"].includes(k),
);

/**
 * `window` → the ISO instant to filter from, for the health surfaces (#234).
 *
 * Both `system_health` and `health_check` advertised a `window` and neither read it, so every
 * health reading was over ALL TIME while presenting as a windowed one. That is the failure mode
 * this engine keeps finding: not a missing answer but a confident wrong one — "$412 of spend"
 * is a very different sentence depending on whether it covers a week or a year, and the caller
 * who asked for a week had no way to tell which they got.
 *
 * Returns `{}` for an absent window (all time — the prior behaviour, now the explicit default)
 * and an `error` for one that cannot be parsed. Silently falling back to all-time on a typo is
 * how the argument came to be ignored in the first place.
 */
export function parseWindow(raw: unknown, now: number): { after?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  const m = /^(\d+)\s*([hdw])$/.exec(String(raw).trim().toLowerCase());
  if (!m) return { error: `unrecognized window "${String(raw)}" — use e.g. "24h", "7d", "2w"` };
  const n = Number(m[1]);
  if (n <= 0) return { error: `window must be positive, got "${String(raw)}"` };
  const ms = m[2] === "h" ? 3_600_000 : m[2] === "d" ? 86_400_000 : 604_800_000;
  return { after: new Date(now - n * ms).toISOString() };
}

export interface ServerDeps {
  registry: Registry;
  outputs: OutputStore;
  ledger: Ledger;
  // Optional execution wiring. When both are present, gig_dispatch/gig_monitor go live;
  // when absent, they report not_implemented (honest — a bare server can't run gigs).
  // Mutable so the write-path (standard_compose) updates the LIVE map the
  // dispatcher reads — a definition made through the MCP surface is dispatchable
  // in the same session, not stale until re-bootstrap (T14 / manual-refresh gap).
  standards?: Map<string, Standard> | undefined;
  /** The loaded ARRANGEMENTS. Mutable for the same reason `standards` is: a chart authored through
   *  chart_define is dispatchable in the same session. Absent → chart_browse and a `chart_slug`
   *  dispatch say what bootstrap they need rather than reporting an empty genome. */
  charts?: Map<string, Chart> | undefined;
  /** The loaded ROOMS. Consulted wherever a chart names a venue: composeChart's ceiling rule needs
   *  the room to resolve, and an unresolvable ceiling fails closed. */
  venues?: Map<string, Venue> | undefined;
  /** The SUBSTRATE realizer a venue-with-mcp_servers gig is stood up on. Bootstrap constructs the
   *  containerized realizer (`dockerComposeRealizer()`, real docker by default) and threads it into
   *  the chart-path runGig deps beside `venue`, so a chart whose room declares servers gets a real
   *  room, not paper confinement. Absent → the substrate is skipped (the pre-wire behaviour). */
  venueRealizer?: VenueRealizer | undefined;
  invoke?: AgentInvoker | undefined;
  model_version?: string | undefined;
  // §13/skills — passed through to runGig so each invocation can resolve its
  // agent's skill_slugs into actual SkillRecords (rendered as the prompt's
  // Skills layer by the Claude invoker).
  skills?: Map<string, SkillRecord> | undefined;
  // Skills-as-first-class — slug → skill package dir on disk, so a skill-backed chair
  // (Chair.skill_slug, no agent) runs the skill's deterministic code half in the cage.
  // Without it, a standard that declares a skill chair (e.g. patent-triage-v1's verdict-gate
  // gate) fails the chair at dispatch. Derived from `skills` (each record's package_dir).
  skill_dirs?: Map<string, string> | undefined;
  // 5th-class eval definitions, slug-keyed. Passed to runGig so a standard's
  // declared eval_slugs are judged against real contracts (not a presence stub).
  evals?: Map<string, EvalRecord> | undefined;
  // Substrate-of-truth seam: when set, genome-mutation tools (agent_define, …) PERSIST
  // the content-addressed file here + ledger-seal its identity. Without it, they compute
  // + return the identity but don't write (validation path).
  genome_dir?: string | undefined;
  // Soft-fail load errors from the most recent loadGenome (Rob #129).
  // Surfaced by system_health + refreshed by genome_reload (Rob #130).
  load_errors?: LoadError[] | undefined;
  /** Org-context switch: wired by a hosted host to the store's coltrane_org_use RPC
   *  (member act, recorded). Absent on file genomes — one working tree, one implicit org. */
  orgUse?: ((org_slug: string) => Promise<string>) | undefined;
  // Live agent map from the genome — surfaced for standard_compose slug
  // resolution (Rob #132) AND genome_reload diff/refresh (Rob #130).
  agents?: Map<string, Agent> | undefined;
  // Genome extension — per-slug layer provenance (`${kind}:${slug}` → layer root),
  // surfaced via system_health so runtime callers can check a definition's origin.
  provenance?: ReadonlyMap<string, string> | undefined;
  // Live gig state for async dispatch. gig_dispatch (async) registers a run here and
  // updates it from runGig's progress events; gig_monitor reads it. Set by bootstrap.
  gig_runs?: Map<string, GigRunState> | undefined;
  // Base dir for per-gig agent logs (<base>/<gig_id>/<role>.jsonl). Set by bootstrap to
  // the outputs persist dir; absent → no file tee (state-only observability, e.g. tests).
  gig_log_base?: string | undefined;
  // Durable per-gig checkpoints, so a run that dies at phase 5 can be resumed instead of
  // restarting from zero. Bootstrap wires it under the outputs persist dir. WRITING is
  // automatic (a checkpoint you have to opt into before the failure is one you never have);
  // acting on it needs `resume_gig_id` on the dispatch call.
  checkpoints?: CheckpointStore | undefined;
  // The chair-level reuse cache. Wired by bootstrap but only PASSED to runGig when the caller
  // sets `reuse: true` — the store is cross-gig by construction, so both reading and writing
  // are the caller's decision, never a side effect of having run something.
  reuse?: ReuseStore | undefined;
  // #185 — the genome→provider bridge: each registered engine tool slug → an in_house provider, so
  // an agent's grant of a real engine tool RESOLVES instead of failing closed as a dead name. Built
  // by bootstrap from REGISTERED_TOOL_SLUGS, passed to the invoker, and kept live by tool_register.
  // Shared by reference with the invoker, so a mid-session register reaches resolution immediately.
  toolProviders?: Map<string, ToolProvider> | undefined;
  // The mcp server configs (server slug → --mcp-config entry) the invoker wires into each spawn.
  // Kept on the deps so the dispatch-preflight tool-grant guard in runGig resolves grants against
  // the IDENTICAL environment the invoker spawns into — no drift between what preflight checks and
  // what a chair gets. Built by bootstrap from `.mcp.json` (deny-by-default: coltrane's own server
  // unless the deployment registers more), the SAME object handed to makeClaudeInvoker.
  mcpServerConfigs?: Record<string, unknown> | undefined;
  // The write-boundary mode for `output_write` in THIS process. "seal" (default) durably writes
  // the validated record. "validate" runs the FULL seal predicate (checkWritable, as a question
  // via validateWrite) and returns the verdict WITHOUT persisting — the in-band contract boundary
  // for a spawned model chair. The runtime is the ONE sealer (executeChair), so a chair's own
  // `output_write` calls must adjudicate-not-seal, or the same output would be sealed twice: once
  // by the chair's cross-process coltrane server and once by the runtime that captures it. Set
  // from COLTRANE_OUTPUT_WRITE_MODE in bootstrapServerDeps; the invoker injects that env into the
  // chair's spawn so the child's coltrane server validates instead of sealing.
  output_write_mode?: "seal" | "validate" | undefined;
  // #206 — the interception seam. A wrapping layer (control plane) injects pre/post hooks that
  // gate/observe/rewrite tool calls in-process. The engine ships ZERO hooks and ZERO policy; it only
  // CALLS whatever is injected here. Absent/empty → dispatch is byte-identical to no seam.
  hooks?: readonly ToolHook[] | undefined;
  // The two-tier local mirror (Tier-1 metadata rows + Tier-2 content-addressed payloads under
  // `.coltrane/`, gitignored) that output_query/output_read traverse. Bootstrap wires it and
  // passes the SAME instance to the OutputStore, so every sealed output — CLI- or MCP-dispatched
  // — lands here and is retrievable with no remote configured. Absent → retrieval falls back to
  // the in-memory/jsonl store (e.g. bare test deps).
  output_mirror?: OutputMirror | undefined;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  // surfaced (not enforced here): whether this call would require human approval.
  requires_approval?: boolean;
  // marks the honest gap: tool exists in the surface but its impl awaits another lane.
  not_implemented?: boolean;
  // #218 — "recording the work failed" is not "the work failed". A LedgerError means the
  // audit row did not land; the caller must be able to tell that from an ordinary rejection,
  // because the two demand opposite responses (retry vs. don't).
  audit_write_failed?: boolean;
  // A machine-readable refusal code (distinct from the prose `error`), for a fail-closed answer
  // that names exactly one reason a call could not proceed — the shape RefusalCode in
  // src/venue_realize.ts:23 uses. A caller branches on this; the `error` teaches a human. Note this
  // is NOT `hosted_unsupported`: that flag means "hosted surface, local-process tool", a different
  // condition, and conflating the two is how a name comes to mean two things.
  refusal?: string;
}

/** Build a governance row. Every governance act names WHAT it was about (`subject_slug`) and
 *  carries its payload (`detail`) — v1 recorded a bare UUID and "n/a" identity (#212). */
function governanceRow(
  event: string,
  subject_slug: string,
  detail: Record<string, unknown>,
  subject_gig_id?: string,
): GovernanceLedgerEntry {
  const now = new Date().toISOString();
  return {
    kind: "governance",
    schema_version: LEDGER_SCHEMA_VERSION,
    entry_id: `${event}:${randomUUID()}`,
    event,
    subject_slug,
    ...(subject_gig_id ? { subject_gig_id } : {}),
    detail,
    output_hashes: [],
    started_at: now,
    finished_at: now,
  };
}

const KNOWN_SLUGS = new Set(MCP_TOOLS.map((t) => t.slug));

// Live registry of admissible tool slugs — the cage gate for agent_define's
// allowed_tools. Seeded with the static MCP_TOOLS surface; tool_register grows
// it at runtime so the propose→register→define loop can close.
const REGISTERED_TOOL_SLUGS = new Set<string>(MCP_TOOLS.map((t) => t.slug));

// Honest gap set: tools in the surface whose impl still awaits another lane. Now
// EMPTY — every v0 tool is wired against real in-repo impl (no stubs). Kept as the
// hook so a future tool can be surfaced before it's implemented without lying.
const NEEDS_RUNTIME = new Set<string>([]);

// CoreType → Primitive — the inverse of PRIMITIVE_OUTPUT_TYPE. output_write
// auto-resolves the writing primitive from core_type when the caller omits it.
const CORE_TYPE_TO_PRIMITIVE: Readonly<Record<string, Primitive>> = Object.fromEntries(
  Object.entries(PRIMITIVE_OUTPUT_TYPE).map(([prim, core]) => [core, prim as Primitive]),
);

function arr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * Read an optional `depth` argument (#237). Absent/empty → no depth (each agent's own
 * `depth_profile` stands). Present but not a real depth → an ERROR, never a silent discard:
 * the whole point of the parameter is cost control, and "we ignored your depth and ran the
 * expensive one" is the failure it exists to prevent.
 */
function readDepth(v: unknown): { depth?: Depth; error?: string } {
  if (v === undefined || v === null || v === "") return {};
  if (!isDepth(v)) return { error: `unknown depth "${String(v)}" — expected one of: ${DEPTHS.join(", ")}` };
  return { depth: v };
}

/**
 * Normalize the user-passed `schema` for type_register (Rob #131).
 *
 * The validator (registry.ts) reads `schema.properties` and treats anything
 * not in it as `additionalProperties` (silently rejected). The MCP surface
 * doesn't tell the caller the wrapper is required — Rob hit this writing
 * `{schema: {title: {type: "string"}}}` and watching every field disappear.
 *
 * Heuristic: if `schema` lacks a `.properties` key AND its values look like
 * JSON-schema field defs (objects with a `type` key), wrap them under
 * `.properties`. Otherwise leave the shape alone. Safe round-trip: a schema
 * that already has `.properties` is returned untouched.
 */
function normalizeSchemaShape(schema: Record<string, unknown>): Record<string, unknown> {
  if ("properties" in schema) return schema;
  const entries = Object.entries(schema);
  if (entries.length === 0) return schema;
  const looksLikeFieldDefs = entries.every(([, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && "type" in (v as object)
  );
  if (!looksLikeFieldDefs) return schema;
  return { type: "object", properties: schema };
}

/**
 * In-place sync helper for genome_reload (Rob #130). Mutates `target` so it
 * matches `source` after the call: keys in `source` not in `target` are added;
 * keys in both are replaced; keys in `target` not in `source` are deleted.
 * Returns the slug diff (added / modified / removed). `before` is a snapshot
 * captured BEFORE the mutation so modified-vs-unchanged is computable via
 * JSON-stringify equality.
 *
 * If `target` is undefined (deps wasn't bootstrapped with that class) the
 * function is a no-op and returns empty diffs — honest: nothing to mutate.
 */
function syncMap<V extends { slug?: string }>(
  target: Map<string, V> | undefined,
  source: ReadonlyMap<string, V>,
  before: Map<string, V>,
): { added: string[]; modified: string[]; removed: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  if (!target) return { added, modified, removed };
  // Add or replace
  for (const [key, val] of source) {
    const prior = before.get(key);
    target.set(key, val);
    if (!prior) added.push(key);
    else if (JSON.stringify(prior) !== JSON.stringify(val)) modified.push(key);
  }
  // Remove keys gone from source
  for (const key of [...target.keys()]) {
    if (!source.has(key)) {
      target.delete(key);
      removed.push(key);
    }
  }
  return { added, modified, removed };
}

// A queryable output row: the Tier-1 metadata projection (+ preview + storage_ref), with the
// full `data` payload only when the caller wants it. Keeps output_query's default shape
// backward-compatible (data present) while making the compact traversal and the deep second
// pass first-class.
function outputRow(rec: OutputRecord, deps: ServerDeps, withData: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: rec.id,
    gig_id: rec.gig_id,
    agent_slug: rec.agent_slug,
    from_role: rec.from_role,
    phase: rec.phase,
    primitive: rec.primitive,
    core_type: rec.core_type,
    domain_type: rec.domain_type,
    domain_type_version: rec.domain_type_version,
    domain: rec.domain,
    content_sha: rec.content_sha,
    input_refs: rec.input_refs,
    input_shas: rec.input_shas,
    cost_usd: rec.cost_usd,
    tokens_used: rec.tokens_used,
    duration_ms: rec.duration_ms,
    model: rec.model,
    model_tier: rec.model_tier,
    created_at: rec.created_at,
    preview: outputPreview(rec.data),
    storage_ref: deps.output_mirror ? mirrorStorageRef(rec.content_sha) : "",
  };
  if (withData) row["data"] = rec.data;
  if (rec.skill_provenance !== undefined) row["skill_provenance"] = rec.skill_provenance;
  if (rec.reused_from !== undefined) row["reused_from"] = rec.reused_from;
  return row;
}

// A Tier-1 metadata row (from the mirror) shaped as an output_query row.
function metaToRow(meta: OutputMeta): Record<string, unknown> {
  return { ...meta };
}

/**
 * Pure tool dispatcher. Routes a tool call to its implementation. No transport,
 * no I/O beyond the injected deps — fully unit-testable.
 */
export async function dispatchTool(slug: string, args: Record<string, unknown>, deps: ServerDeps): Promise<ToolResult> {
  if (!KNOWN_SLUGS.has(slug)) {
    return { ok: false, error: `unknown tool "${slug}"` };
  }
  // Approval gating is surfaced on every result so the caller (or a wrapping
  // policy layer) can refuse to apply a change that needs human sign-off.
  const approval = requiresApproval({
    slug,
    change_class: (args["change_class"] as never) ?? null,
    target_kind: (args["target_kind"] as never) ?? null,
  });

  if (NEEDS_RUNTIME.has(slug)) {
    return { ok: false, not_implemented: true, requires_approval: approval, error: `"${slug}" awaits src/runtime / context stores` };
  }

  // #206 — the interception seam. The engine ships ZERO hooks; it only CALLS whatever the wrapping
  // layer injected. No hooks → this loop is a no-op and dispatch is byte-identical to no seam. Hooks
  // wrap ONLY known, implemented calls (we are past the guards above). A hook that throws fails the
  // call CLOSED — a gate that errors must never let the call through.
  const hooks = deps.hooks ?? [];
  let workArgs = args;
  const hookCtx = (): ToolCallContext => ({ slug, args: workArgs, deps, requires_approval: approval });
  // before: array order; first halt wins (impl + remaining before-hooks + ALL after-hooks skipped).
  for (const h of hooks) {
    if (!h.before) continue;
    let out: PreOutcome;
    try {
      out = await h.before(hookCtx());
    } catch (e) {
      return { ok: false, error: `hook "${h.name}" before() failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (out.action === "halt") return out.result;
    if (out.args) workArgs = out.args; // threaded to the next hook + the impl
  }

  let result = await runImpl(slug, workArgs, deps, approval);

  // after: array order; folds over the result (each hook sees the prior's output).
  for (const h of hooks) {
    if (!h.after) continue;
    try {
      result = await h.after(hookCtx(), result);
    } catch (e) {
      return { ok: false, error: `hook "${h.name}" after() failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return result;
}

// The engine's actual tool implementations — the big switch, extracted from dispatchTool (#206) so
// the hook loop can wrap it. The body is UNCHANGED: it reads `args` (which the caller threads as the
// possibly-rewritten workArgs) and `approval` (computed once by the wrapper). No logic change.
async function runImpl(slug: string, args: Record<string, unknown>, deps: ServerDeps, approval: boolean): Promise<ToolResult> {
  try {
    switch (slug) {
      case "type_resolve": {
        const res = deps.registry.resolveType({
          extends: String(args["core_type"] ?? args["extends"] ?? ""),
          domain: String(args["domain"] ?? ""),
          required_fields: arr(args["required_fields"]),
        });
        return { ok: true, requires_approval: approval, data: res };
      }
      case "type_browse": {
        let types = deps.registry.listTypes();
        if (args["domain"]) types = types.filter((t) => t.domain === args["domain"]);
        if (args["extends"]) types = types.filter((t) => t.extends === args["extends"]);
        // #234/#203 — `status` was advertised here and never applied. The two issues compound:
        // #203 gave domain types a lifecycle, and the tool for finding types offered to filter
        // on it while returning retired ones anyway. An operator browsing for what they may
        // build on got the retired definitions back with nothing marking them.
        //
        // The registry default is "active", so an undeclared type answers to `status:"active"`
        // rather than being invisible to every filter.
        if (args["status"]) {
          const want = String(args["status"]);
          types = types.filter((t) => ((t as { status?: string }).status ?? "active") === want);
        }
        // #234 — `min_usage` likewise advertised and ignored. Usage is the count of sealed
        // outputs of that type, the same derivation system_audit uses to call a type unused.
        if (typeof args["min_usage"] === "number") {
          const min = args["min_usage"] as number;
          const usage = new Map<string, number>();
          for (const o of deps.outputs.all()) usage.set(o.domain_type, (usage.get(o.domain_type) ?? 0) + 1);
          types = types.filter((t) => (usage.get(t.slug) ?? 0) >= min);
        }
        return { ok: true, requires_approval: approval, data: { types, stats: { count: types.length } } };
      }
      case "type_register": {
        const def: DomainType = {
          slug: String(args["slug"] ?? ""),
          extends: String(args["extends"] ?? ""),
          domain: String(args["domain"] ?? ""),
          // Rob #131 — normalize schema shape. The validator reads
          // `schema.properties`; if the caller passes field defs at the top
          // level (e.g. `{title: {type: "string"}}`) instead of inside a
          // `.properties` wrapper, every field gets silently rejected as
          // `additionalProperties`. Detect the unwrapped shape and wrap it.
          schema: normalizeSchemaShape((args["schema"] as Record<string, unknown>) ?? {}),
          required_fields: arr(args["required_fields"]),
        };
        const res = deps.registry.registerType(def);
        // substrate seal: persist a loadable domain_types/<slug>.json (full record) + ledger.
        const fileDef = { slug: def.slug, version: 1, extends: def.extends, domain: def.domain, status: "active", schema: def.schema, required_fields: def.required_fields };
        const sealed = sealDefinition("type_register", def.slug, fileDef, deps.ledger, deps.genome_dir, "domain_types", args["reason"] != null ? { reason: args["reason"] } : undefined);
        return { ok: true, requires_approval: approval, data: { ...(res as object), content_hash: sealed.content_hash, dependency_hash: sealed.dependency_hash, effective_hash: sealed.effective_hash } };
      }
      case "standard_simulate": {
        const simSlug = String(args["standard_slug"] ?? "");
        const simDepth = readDepth(args["depth"]);
        if (simDepth.error) return { ok: false, requires_approval: approval, error: simDepth.error };
        // #239 — hand the simulator the standard it is simulating. It only ever received a
        // SLUG, so a 6-phase pipeline came back as three invented phases and a cost with no
        // connection to it. And hand it the REAL settled spend of prior runs (#195): a measured
        // mean of this pipeline beats any formula for the "validate before you spend" check.
        const std = deps.standards?.get(simSlug);
        // #267 — refuse a standard we cannot find, rather than estimating one we invented.
        // This tool is documented as the cheap pre-dispatch gate ("validate before you
        // spend"), and a gate that cannot fail is worse than no gate: callers stop looking.
        // A typo'd slug is the single most likely thing an operator wants caught here.
        //
        // The gate lives at the MCP boundary, NOT in standardSimulate(). Keeping the pure
        // function permissive is a deliberate separation — an estimator that refuses is a
        // different kind of thing from an estimator — and it is the TOOL that owes callers a
        // verdict. (`standardSimulate` has exactly one non-test caller: this line. So this is
        // a design choice about where refusal belongs, not a constraint imposed by other
        // callers.) `basis: "fallback"` labels an invented number honestly, but it is a field
        // inside a SUCCESS payload — it stops nobody.
        //
        // "I looked and it is absent" is a different answer from "I have no way to look", and
        // the two get different answers. A host that wired no standards map cannot resolve
        // ANY slug, so it reports `not_implemented` exactly as `gig_dispatch` does on the same
        // host. Returning a $1.00 estimate there would be worse than useless: it would quote a
        // price for a run that `gig_dispatch` is about to refuse outright.
        if (!deps.standards) {
          return {
            ok: false,
            not_implemented: true,
            requires_approval: approval,
            error: "standard_simulate needs standards wired into the server",
          };
        }
        if (!simSlug) {
          return { ok: false, requires_approval: approval, error: "standard_simulate requires a standard_slug" };
        }
        if (!std) {
          return {
            ok: false,
            requires_approval: approval,
            error:
              `unknown standard "${simSlug}" — nothing to simulate. Check the slug, and if the ` +
              `standard is newly authored run genome_reload and confirm load_errors is empty.`,
          };
        }
        const observed = deps.ledger
          .query({ kind: "gig", standard_slug: simSlug })
          .filter(isGig)
          .map((e) => e.usage?.total_cost_usd)
          .filter((n): n is number => typeof n === "number" && n > 0);
        const res = standardSimulate({
          standard_slug: simSlug,
          mock_input: (args["mock_input"] as Record<string, unknown>) ?? {},
          depth: simDepth.depth ?? "standard",
          ...(std ? { standard: { slug: std.slug, phases: std.phases.map((p) => ({ name: p.name, chairs: p.chairs.length })) } } : {}),
          ...(observed.length > 0 ? { observed_costs_usd: observed } : {}),
        });
        // WU-0008 — the seal drill: before quoting a price, prove every chair contract
        // can seal AT ALL. A cost estimate for a run whose terminal chair is doomed is
        // worse than useless (it prices a failure as if it were work). Failures ride in
        // the SUCCESS payload loudly; dispatch stays unchanged — the operator decides.
        const drill = sealDrill(
          { phases: std.phases.map((p) => ({ name: p.name, chairs: p.chairs.map((c) => ({ role: c.role, output_contract: c.output_contract })) })) },
          deps.registry,
        );
        return { ok: true, requires_approval: approval, data: { ...res, seal_drill: drill } };
      }
      case "output_query": {
        const mirror = deps.output_mirror;
        // SECOND PASS — a single output's FULL payload by id or content_sha. This is the deeper
        // Tier-2 read: prefer the content-addressed artifact tier (local mirror, or remote when
        // drained), falling back to the store. Returns exactly the one output, with its data.
        const wantId = args["output_id"] ? String(args["output_id"]) : undefined;
        const wantSha = args["content_sha"] ? String(args["content_sha"]) : undefined;
        if (wantId || wantSha) {
          const rec = wantId
            ? deps.outputs.get(wantId)
            : deps.outputs.all().find((o) => o.content_sha === wantSha);
          let row: Record<string, unknown> | undefined = rec ? outputRow(rec, deps, true) : undefined;
          // Store miss (or a mirror-only payload): read the artifact tier directly.
          if ((!row || row["data"] === undefined) && mirror) {
            const sel: { id?: string; content_sha?: string } = {};
            if (wantId) sel.id = wantId;
            if (wantSha) sel.content_sha = wantSha;
            const hit = mirror.readPayload(sel);
            if (hit?.meta) row = { ...metaToRow(hit.meta), data: hit.data };
            else if (row && hit?.data !== undefined) row["data"] = hit.data;
          }
          const outputs = row ? [row] : [];
          return { ok: true, requires_approval: approval, data: { outputs, total_count: outputs.length } };
        }

        // LIST — Tier-1 traversal. The store is now cross-process-fresh (the `fullyHydrated`
        // latch is gone), so a gig sealed by a separate CLI process is visible here. `data` is
        // carried by default (backward-compat) and on `data_filter`; pass `include_data:false`
        // for the compact Tier-1 rows (metadata + preview + storage_ref, no payload).
        const dataFilter = args["data_filter"];
        const hasDataFilter = Boolean(dataFilter && typeof dataFilter === "object" && !Array.isArray(dataFilter));
        const includeData = args["include_data"] === false ? false : true;
        let recs = deps.outputs.all();
        if (args["domain_type"]) recs = recs.filter((o) => o.domain_type === args["domain_type"]);
        if (args["gig_id"]) recs = recs.filter((o) => o.gig_id === args["gig_id"]);
        if (args["agent_slug"]) recs = recs.filter((o) => o.agent_slug === args["agent_slug"]);
        // #234 — `data_filter` was advertised and ignored, so a caller narrowing a query by
        // payload got the UNFILTERED set back and a `total_count` describing it. Every key must
        // match (AND), compared structurally so an object or array value filters as written.
        if (hasDataFilter) {
          const entries = Object.entries(dataFilter as Record<string, unknown>);
          recs = recs.filter((o) => {
            const data = (o.data ?? {}) as Record<string, unknown>;
            return entries.every(([k, v]) => canonJson(data[k]) === canonJson(v));
          });
        }
        // Payload is dropped only when the caller explicitly asks for the compact rows AND is not
        // filtering by payload (a data_filter needs the payload to have been read).
        const withData = includeData || hasDataFilter;
        const outputs = recs.map((o) => outputRow(o, deps, withData));
        return { ok: true, requires_approval: approval, data: { outputs, total_count: outputs.length } };
      }
      case "output_trace": {
        const id = String(args["output_id"] ?? "");
        const maxDepth = typeof args["max_depth"] === "number" ? (args["max_depth"] as number) : undefined;
        // #234 — `direction` was advertised and ignored: every trace walked UPSTREAM, so a
        // caller asking "what was derived FROM this draft?" received its ancestors instead and
        // nothing said the answer was to a different question. `outputs.trace` is inherently
        // backward (it follows input_refs), so downstream is walked here over the same store.
        const direction = String(args["direction"] ?? "upstream").toLowerCase();
        if (!["upstream", "downstream", "both"].includes(direction)) {
          return { ok: false, requires_approval: approval, error: `unrecognized direction "${direction}" — use "upstream", "downstream" or "both"` };
        }
        // The WALK — every direction of it — belongs to the store, which is the one owner of the
        // performance-family crossing rule and of the labels that make a crossing visible. This
        // handler used to hand-roll the forward walk over `all()`, which gave downstream a
        // different scope than upstream (none at all) and no labels either.
        const nodes = deps.outputs.trace(id, {
          ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
          direction: direction as TraceDirection,
        });
        // A hole is reported as itself: named on its own key AND left in the graph, never dropped
        // from either. It is deliberately kept OUT of the two classifications, which read fields
        // an absent record does not have — a hole carries no `input_refs`, so the root-signal test
        // ("nothing upstream of it") would have called every unresolvable reference a root signal,
        // which is the opposite of what is known about it: nothing at all.
        const missing = nodes.filter((n): n is TraceMissingNode => n.missing === true);
        const held = nodes.filter((n): n is TraceRecordNode => n.missing !== true);
        const all = deps.outputs.all();
        return {
          ok: true, requires_approval: approval,
          data: {
            graph: { nodes }, direction,
            root_signals: held.filter((o) => o.input_refs.length === 0),
            // The other end of the chain: outputs nothing else was derived from.
            terminal_outputs: held.filter((o) => !all.some((x) => x.input_refs.includes(o.id))),
            missing,
          },
        };
      }
      case "output_write": {
        // §6 universal output write: validates against core+domain schema AT WRITE
        // (T3). Primitive is auto-resolved from core_type when omitted. Optional
        // `refs: [{ to, relation }]` link provenance edges after the row exists.
        //
        // Boundary discipline: null/undefined at the dispatchTool boundary is
        // NOT silently coerced to "" or {} before validate sees them. The
        // validator must see what the caller actually sent — `data: null`
        // falls through and Ajv rejects with the type-mismatch message, rather
        // than the boundary swallowing the adversarial intent.
        const core_type = String(args["core_type"] ?? "");
        const primitive = String(args["primitive"] ?? CORE_TYPE_TO_PRIMITIVE[core_type] ?? "SENSE");
        const domain_type_raw = args["domain_type"];
        const domain_type = typeof domain_type_raw === "string"
          ? domain_type_raw
          : domain_type_raw == null ? "" : String(domain_type_raw);
        const data_raw = args["data"];
        // undefined → {} (caller never sent the field); null stays null so Ajv sees it.
        const data = (data_raw === undefined ? {} : data_raw) as Record<string, unknown>;
        // THE WRITE BOUNDARY. In "validate" mode the caller is a spawned model chair sealing
        // in-band: run the COMPLETE seal predicate (validateWrite === checkWritable: the substance
        // floor via validateOutput + the domain schema via registry.validate + core agreement) and
        // return the verdict WITHOUT persisting. On a violation the throw below becomes an in-band
        // { ok:false, error } (dispatchTool's catch), so the STILL-RUNNING agent gets the exact
        // reason and self-corrects by calling output_write again — no invoker re-prompt, and no
        // subset check. The runtime (executeChair) is the one sealer, so validating-not-sealing
        // here is what keeps the output sealed exactly once.
        if (deps.output_write_mode === "validate") {
          const verdict = deps.outputs.validateWrite({ core_type, domain_type, data });
          if (!verdict.valid) {
            throw new Error(
              verdict.reason ??
                `output rejected: "${domain_type || core_type}" did not satisfy its output contract`,
            );
          }
          return {
            ok: true, requires_approval: approval,
            data: { validated: true, validation_result: { valid: true } },
          };
        }
        const rec = deps.outputs.write({
          core_type,
          domain_type,
          domain_type_version: args["domain_type_version"] as number | undefined,
          domain: String(args["domain"] ?? ""),
          gig_id: String(args["gig_id"] ?? ""),
          agent_slug: String(args["agent_slug"] ?? ""),
          ...(typeof args["model"] === "string" ? { model: args["model"] } : {}),
          ...(typeof args["model_tier"] === "string" ? { model_tier: args["model_tier"] } : {}),
          phase: args["phase"] as string | undefined,
          primitive,
          data,
          input_refs: arr(args["input_refs"]),
          cost_usd: args["cost_usd"] as number | undefined,
          tokens_used: args["tokens_used"] as number | undefined,
          duration_ms: args["duration_ms"] as number | undefined,
        });
        const refs = Array.isArray(args["refs"]) ? (args["refs"] as { to: string; relation: string }[]) : [];
        for (const r of refs) {
          deps.outputs.addRef(rec.id, r.to, r.relation as never, primitive);
        }
        // `validation_result` is declared on this tool AND load-bearing: the write validated
        // (deps.outputs.write → checkWritable) before the row existed, so reaching here means it
        // passed — an INVALID payload would have thrown and been returned as { ok:false, error }
        // by dispatchTool's try/catch. Say so, in the same { valid } shape the define/compose
        // tools use, rather than declaring a field and never returning it (#234 family).
        return { ok: true, requires_approval: approval, data: { output_id: rec.id, primitive, output: rec, validation_result: { valid: true } } };
      }
      case "execution_history_read": {
        // Read the append-only ledger — the genome's run history. Filterable by
        // gig / standard / genome_hash / time window (LedgerQuery).
        const filter: Record<string, string> = {};
        for (const k of ["gig_id", "standard_slug", "genome_hash", "after", "before"]) {
          if (args[k]) filter[k] = String(args[k]);
        }
        const executions = deps.ledger.query(filter);
        return { ok: true, requires_approval: approval, data: { executions, count: executions.length } };
      }
      case "gig_dispatch": {
        if (!deps.standards || !deps.invoke) {
          return { ok: false, not_implemented: true, requires_approval: approval, error: "gig_dispatch needs standards + invoke wired into the server" };
        }
        // ── which performance? ───────────────────────────────────────────────────────────────
        // EXACTLY ONE of standard_slug / chart_slug. A single-standard dispatch IS the degenerate
        // one-movement chart, so naming both names two performances and naming neither names none;
        // the refinement lives in one place (dispatchTarget) and is shared with the CLI.
        // WHO ACTS, as distinct from who asked. Read here so the wire is visible in the handler
        // rather than riding anonymously inside `args` — #234's law refuses an argument advertised
        // and never read, and it is right to: this one decides whose authority a gig carries, which
        // is the identity a drain later runs it as. The store enforces that it names a SEATED
        // player; an unseated one produces a gig that can only fail at genome load.
        const actingFor =
          args["acting_for"] === undefined || args["acting_for"] === null ? undefined : String(args["acting_for"]);
        void actingFor; // forwarded to the queue seam via `args` below; named here to be legible.
        // WHERE it plays, as distinct from what it plays. This is a CEILING, and the whole design is
        // fail-closed — so the one outcome the contract forbids is proceeding as if no venue was
        // asked. It is threaded into BOTH runGig calls below (the sync and async paths) via the same
        // conditional-spread trio the chart path uses (server.ts:935-941), so `runGig`'s own venue
        // block either realizes the room or refuses fail-closed. It used to be read into this local
        // and then DISCARDED (`void venue`, with a comment claiming the queue seam forwarded it — it
        // did not for a local run): gig a77f6f7f dispatched room-probe-v1 with a named venue and got
        // NO room, NO refusal, and a 'complete' status whose output was byte-identical to the
        // venue-less control. An unnamed gig carries `undefined` here and is threaded to nothing —
        // the venue-less path stays byte-identical.
        const venue =
          args["venue"] === undefined || args["venue"] === null ? undefined : String(args["venue"]);

        const target = dispatchTarget({
          standard_slug: args["standard_slug"] === undefined || args["standard_slug"] === null ? undefined : String(args["standard_slug"]),
          chart_slug: args["chart_slug"] === undefined || args["chart_slug"] === null ? undefined : String(args["chart_slug"]),
        });
        if (!target.ok) return { ok: false, requires_approval: approval, error: target.error };
        const chartDef = target.kind === "chart" ? deps.charts?.get(target.slug) : undefined;
        if (target.kind === "chart" && !chartDef) {
          return {
            ok: false, requires_approval: approval,
            error: deps.charts
              ? `unknown chart "${target.slug}"`
              : `unknown chart "${target.slug}": this server has no charts map (bootstrap from a genome with charts/)`,
          };
        }
        const slug2 = target.slug;
        // The standards this dispatch will actually run: one, or one per movement. Every preflight
        // below is stated ONCE over this list, so a chart cannot route around a gate a standard
        // dispatch has to pass.
        const targetStandards: Standard[] = [];
        if (chartDef) {
          for (const m of chartDef.movements) {
            const s = deps.standards.get(m.standard_slug);
            // A dead standard name is composeChart's R2 and is reported with the rule named below;
            // the preflights simply have nothing to check for that movement.
            if (s) targetStandards.push(s);
          }
        } else {
          const standard = deps.standards.get(slug2);
          if (!standard) return { ok: false, requires_approval: approval, error: `unknown standard "${slug2}"` };
          targetStandards.push(standard);
        }
        // #203, the READ side. Preserving `status` through the loader was only half of it: the
        // symptom recorded on the issue — "a retired standard stays dispatchable and nothing
        // says otherwise" — survived the field being kept, because nothing consulted it. A
        // declaration that round-trips and changes nothing is worse than one that is dropped;
        // the round-trip is evidence it took effect.
        //
        // Placed ABOVE the wait/async split deliberately. Both modes have their own body below,
        // and a guard sitting inside the synchronous branch would leave the DEFAULT path — the
        // one the product dispatches through — open.
        //
        // deprecated ALLOWS and warns; retired REFUSES. Were both refused, `deprecated` would
        // be a spelling of `retired` and there would be no way to say the softer thing.
        //
        // Swept over EVERY standard this dispatch will run, so a chart cannot smuggle a retired
        // movement past a gate a direct dispatch of the same standard would fail.
        const warnings: string[] = [];
        for (const s of targetStandards) {
          const stdStatus = (s as { status?: string }).status;
          if (stdStatus === "retired") {
            return {
              ok: false, requires_approval: approval,
              error: `standard "${s.slug}" is retired and cannot be dispatched. ` +
                `Promote it back to active (standard_promote) if it should run again.`,
            };
          }
          if (stdStatus === "deprecated") {
            warnings.push(`standard "${s.slug}" is deprecated — it still runs, but should not be built on.`);
          }
        }
        // WU-0008 preflight: run the same sealDrill used by standard_simulate BEFORE spending
        // on any chair. A structurally-unsealable standard is refused here (pennies) instead of
        // after a chair runs and aborts. Gate is placed once, above the wait/async split, so a
        // single check covers both runGig call-sites below — and over every movement's standard,
        // because a chart that cannot seal at movement three is refused before movement one.
        for (const s of targetStandards) {
          const drill = sealDrill(
            { phases: s.phases.map((p) => ({ name: p.name, chairs: p.chairs.map((c) => ({ role: c.role, output_contract: c.output_contract })) })) },
            deps.registry,
          );
          if (!drill.ok) {
            return {
              ok: false, requires_approval: approval,
              error: `standard "${s.slug}" cannot seal: ` +
                drill.failures.map((f) => `${f.phase}/${f.role} → ${f.domain_type} (${f.errors.join("; ")})`).join(", "),
              data: { seal_drill: drill },
            };
          }
        }
        // Optional budget arg — when present, runtime enforces per-gig cost-budget
        // and raises BudgetExhausted on depletion (PR for T10 gap, see runtime.ts).
        const budgetArg = args["budget"] as Record<string, unknown> | undefined;
        let budget: { opening: number; base_cost?: number; k?: number } | undefined;
        if (budgetArg && typeof budgetArg["opening"] === "number") {
          budget = { opening: budgetArg["opening"] as number };
          if (typeof budgetArg["base_cost"] === "number") budget.base_cost = budgetArg["base_cost"] as number;
          if (typeof budgetArg["k"] === "number") budget.k = budgetArg["k"] as number;
        }
        const gigInput = (args["input"] as Record<string, unknown>) ?? {};
        // #237 — `depth` was advertised here and never read. Every dispatch ran at full depth,
        // so the documented "skim first while iterating" practice had no mechanism behind it.
        const depthArg = readDepth(args["depth"]);
        if (depthArg.error) return { ok: false, requires_approval: approval, error: depthArg.error };
        const depth = depthArg.depth;

        // ── reuse a sealed output instead of re-deriving it ──────────────────────────────
        // Both halves are opt-in, and both are named on the dispatch call so the decision is
        // recorded where the run is requested rather than inferred from server configuration.
        const resumeArg = args["resume_gig_id"] === undefined || args["resume_gig_id"] === null
          ? undefined
          : String(args["resume_gig_id"]);
        if (resumeArg !== undefined && resumeArg.trim() === "") {
          return { ok: false, requires_approval: approval, error: `gig_dispatch: "resume_gig_id" must be a gig id, not an empty string` };
        }
        if (resumeArg !== undefined && !deps.checkpoints) {
          return { ok: false, requires_approval: approval, error: `gig_dispatch: resume_gig_id was supplied but this server has no checkpoint store wired, so no run is resumable` };
        }
        // A live run holds the AbortController for that gig_id; resuming into it would put two
        // runs on one gig, writing to the same outputs file and racing the same checkpoint.
        if (resumeArg !== undefined && deps.gig_runs?.get(resumeArg)?.status === "running") {
          return { ok: false, requires_approval: approval, error: `gig_dispatch: gig "${resumeArg}" is still running — abort it before resuming` };
        }
        const reuseOn = args["reuse"] === true;
        if (reuseOn && !deps.reuse) {
          return { ok: false, requires_approval: approval, error: `gig_dispatch: reuse was requested but this server has no reuse store wired` };
        }
        // #20 — the CLI signals an OMITTED --input as a boolean on args, so a human-only resume can
        // inherit the checkpoint's gig_input_sha instead of drifting to sha256('{}') and refusing.
        // It is advertised in gig_dispatch's input_schema (src/mcp.ts): a control the handler reads
        // must be discoverable by a caller (#234). Only true when the caller stated no payload; an
        // explicit `{}` is a supplied value and leaves this false, so a disagreeing payload still
        // gates (see src/runtime.ts).
        const gigInputOmitted = args["gig_input_omitted"] === true;
        const reuseWiring = {
          ...(deps.checkpoints ? { checkpoints: deps.checkpoints } : {}),
          ...(resumeArg !== undefined ? { resume_from: resumeArg } : {}),
          ...(reuseOn && deps.reuse ? { reuse: deps.reuse } : {}),
          ...(gigInputOmitted ? { gig_input_omitted: true } : {}),
        };

        // ── the human seat's door ────────────────────────────────────────────────────────
        // A chair marked `human: true` parks the run until its incumbent's verdict arrives
        // here, keyed by role. The typical shape is the SECOND call on one gig: dispatch,
        // park, then re-dispatch with `resume_gig_id` + the approval, which restores the
        // chairs already paid for and seals the verdict under `approved_by`.
        const approvalsArg = args["approvals"];
        const approvals = approvalsArg && typeof approvalsArg === "object" && !Array.isArray(approvalsArg)
          ? (approvalsArg as Record<string, Record<string, unknown>>)
          : undefined;
        const approvedBy = typeof args["approved_by"] === "string" && args["approved_by"].trim() !== ""
          ? args["approved_by"]
          : undefined;
        const humanWiring = {
          ...(approvals ? { approvals } : {}),
          ...(approvedBy !== undefined ? { approved_by: approvedBy } : {}),
        };
        /** What a run skipped, and why — echoed on every reply so a saving is never silent. */
        const savings = (res: Awaited<ReturnType<typeof runGig>>): Record<string, unknown> => ({
          ...(res.skipped ? { skipped: res.skipped } : {}),
          ...(res.resumed_from ? { resumed_from: res.resumed_from } : {}),
          ...(res.reuse ? { reuse: res.reuse } : {}),
          ...(res.checkpoint_error ? { checkpoint_error: res.checkpoint_error } : {}),
        });

        const wait = args["wait"] === true;

        // ── the chart path ────────────────────────────────────────────────────────────────────
        // A chart is COMPOSED here, not at load, because the last rule needs a fact the genome does
        // not hold: which types the dispatch payload carries. Everything else composeChart checks it
        // already checked at load; this pass is the one that can hold R7 to the real payload, so a
        // performance whose first movement was never seeded is refused before it spawns anything.
        if (chartDef) {
          const composed = composeChart({
            chart: chartDef,
            standards: deps.standards,
            ...(deps.agents ? { agents: deps.agents } : {}),
            ...(deps.venues ? { venues: deps.venues } : {}),
            payload_types: Object.keys(gigInput),
          });
          if (!composed.ok) {
            return {
              ok: false, requires_approval: approval,
              error: `chart "${slug2}" cannot be performed: ` + composed.violations.map((v) => `${v.rule}: ${v.detail}`).join(" | "),
              data: { validation_result: { valid: false, violations: composed.violations } },
            };
          }
          const plan: ChartPlan = composed;
          const chartDeps = {
            outputs: deps.outputs, ledger: deps.ledger, invoke: deps.invoke,
            model_version: deps.model_version, skills: deps.skills, skill_dirs: deps.skill_dirs, evals: deps.evals, budget,
            toolProviders: deps.toolProviders, mcpServerConfigs: deps.mcpServerConfigs, // each movement's preflight resolves against the invoker's environment
            // THE ROOM THE ARRANGEMENT NAMED, carried into the run.
            //
            // Without this the venue branch in `runGig` is unreachable in production: `composeChart`
            // checks the ceiling at AUTHORING time (R10) and `deps.venues` is passed here only so it
            // can, but the chart's own `venue` was never threaded into the run deps — so no shipped
            // caller ever set `deps.venue`, and `resolveAndRealize` ran for tests alone. A room that
            // is checked when the chart is written and forgotten when it is performed is a ceiling
            // on paper.
            ...(chartDef.venue ? { venue: chartDef.venue } : {}),
            ...(deps.venues ? { venues: deps.venues } : {}),
            // The substrate seam, carried beside the room the arrangement named: when that room
            // declares mcp_servers, runGig stands it up on this realizer and threads its transports
            // onto each chair's spawn. Absent = the substrate is skipped (server-less venues, or a
            // bare deps without a realizer wired).
            ...(deps.venueRealizer ? { venueRealizer: deps.venueRealizer } : {}),
            ...(depth ? { depth } : {}), ...reuseWiring, ...humanWiring,
          };
          /** The ARRANGEMENT's manifest. A chart has no single genome_hash or run_fingerprint — it
           *  has a chart_hash and one run per movement — so the reply says what a chart run is
           *  rather than reshaping it into a standard run's fields. */
          const chartManifest = (res: ChartResult): Record<string, unknown> => ({
            chart_slug: res.chart_slug, chart_hash: res.chart_hash,
            movements: res.movements.map((m) => ({
              movement_id: m.movement_id, standard_slug: m.standard_slug, gig_id: m.gig_id,
              status: m.status, output_count: m.outputs.length, spent_usd: m.spent_usd,
              ...(m.result ? { genome_hash: m.result.genome_hash, run_fingerprint: m.result.run_fingerprint } : {}),
            })),
            output_count: res.movements.reduce((n, m) => n + m.outputs.length, 0),
            spent_usd: res.spent_usd,
            ...(res.budget ? { budget: res.budget } : {}),
            ...(res.gates_approved ? { gates_approved: res.gates_approved } : {}),
            ...(res.resumed ? { resumed: res.resumed } : {}),
          });
          if (wait) {
            try {
              const res = await runChart(plan, gigInput, chartDeps);
              return {
                ok: true, requires_approval: approval,
                data: {
                  gig_id: res.gig_id, status: res.status,
                  ...(res.awaiting ? { awaiting: res.awaiting } : {}),
                  ...(depth ? { depth } : {}),
                  warnings, manifest: chartManifest(res),
                },
              };
            } catch (e) {
              if (e instanceof ResumeRefused) {
                return { ok: false, requires_approval: approval, error: e.message,
                  data: { resume_refused: true, gig_id: e.gig_id, drift: e.drift } };
              }
              if (e instanceof BudgetExhausted) {
                const partial = partialGigUsage(e);
                return { ok: false, requires_approval: approval, error: e.message,
                  data: { budget_exhausted: true, agent_slug: e.agent_slug, balance: e.balance, cost: e.cost, budget_state: e.state,
                    ...(partial ? { usage: partial } : {}) } };
              }
              throw e;
            }
          }
          // Async, the default. Same live-state row an async standard dispatch registers, so
          // gig_monitor and gig_abort reach a performance exactly as they reach a run: the row
          // names the standard the performance OPENS with, and `chart_slug` names the arrangement.
          const chartGigId = resumeArg ?? randomUUID();
          const chartRuns = deps.gig_runs ?? (deps.gig_runs = new Map());
          const priorChartState = chartRuns.get(chartGigId);
          const chartState = newGigRun(
            chartGigId, plan.movements[0]!.standard.slug,
            plan.movements.reduce((n, m) => n + m.standard.phases.length, 0),
            new Date().toISOString(),
          );
          chartState.chart_slug = plan.chart.slug;
          const chartController = new AbortController();
          chartState.controller = chartController;
          chartRuns.set(chartGigId, chartState);
          pruneGigRuns(chartRuns);
          const chartLogDir = deps.gig_log_base ? join(deps.gig_log_base, "gigs", chartGigId) : undefined;
          const onChartProgress = (ev: Parameters<typeof applyGigProgress>[1]): void => {
            applyGigProgress(chartState, ev);
            if (chartLogDir && ev.type === "agent_event") {
              try { mkdirSync(chartLogDir, { recursive: true }); appendFileSync(join(chartLogDir, `${ev.role}.jsonl`), JSON.stringify(ev.event) + "\n"); } catch { /* best-effort */ }
            }
            const line = gigEventLogLine(chartGigId, ev);
            if (line) { try { process.stderr.write(line + "\n"); } catch { /* best-effort */ } }
          };
          const chartPromise = runChart(plan, gigInput, {
            ...chartDeps, gig_id: chartGigId, onProgress: onChartProgress, signal: chartController.signal,
          });
          let chartRefusal: ResumeRefused | undefined;
          if (resumeArg !== undefined) {
            void chartPromise.catch((e: unknown) => { if (e instanceof ResumeRefused) chartRefusal = e; });
          }
          void chartPromise
            .then((res) => {
              chartState.status = res.status === "complete" ? "complete" : "awaiting_approval";
              // An arrangement-level GATE has no phase — its position is the movement it gates — so
              // the movement_id fills the slot a within-movement park fills with its phase name.
              if (res.awaiting) chartState.awaiting = { phase: res.awaiting.phase ?? res.awaiting.movement_id, role: res.awaiting.chair };
              chartState.finished_at = new Date().toISOString();
              // The arrangement's identity in the slot the run's identity occupies — the same
              // substitution `run_fingerprint` makes for a chart (src/chart.ts), so a monitor reading
              // this field gets the hash that actually identifies what ran.
              chartState.genome_hash = res.chart_hash;
              chartState.outputs_count = res.movements.reduce((n, m) => n + m.outputs.length, 0);
              // A budget_exhausted performance settled without completing and without parking. It
              // is not `complete` and there is no person to wait for, so it reads as failed with
              // the boundary it stopped at named — the same posture a depleted run has.
              if (res.status === "budget_exhausted") {
                chartState.status = "failed";
                chartState.error = `budget envelope exhausted at movement "${res.budget?.exhausted_at_movement ?? "?"}" (spent $${res.spent_usd} of $${res.budget?.total_usd ?? "?"})`;
              }
            })
            .catch((e: unknown) => {
              chartState.finished_at = new Date().toISOString();
              if (e instanceof GigAborted) {
                chartState.status = "aborted";
                chartState.abort_reason = e.reason;
                chartState.outputs_count = e.outputs.length;
                if (e.usage) chartState.usage = e.usage;
                return;
              }
              chartState.status = "failed";
              chartState.error = e instanceof Error ? e.message : String(e);
              const partial = partialGigUsage(e);
              if (partial) chartState.usage = partial;
              const bs = partialBudgetState(e);
              if (bs) chartState.budget_state = bs;
              onChartProgress({ type: "gig_failed", error: chartState.error });
            })
            .finally(() => { chartState.controller = undefined; });
          if (resumeArg !== undefined) {
            await Promise.resolve(); // one turn — see the ordering note on the standard path below
            if (chartRefusal) {
              if (priorChartState) chartRuns.set(chartGigId, priorChartState);
              else chartRuns.delete(chartGigId);
              return { ok: false, requires_approval: approval, error: chartRefusal.message,
                data: { resume_refused: true, gig_id: chartRefusal.gig_id, drift: chartRefusal.drift } };
            }
          }
          return {
            ok: true, requires_approval: approval,
            data: {
              gig_id: chartGigId, status: "running", chart_slug: plan.chart.slug, chart_hash: plan.chart_hash,
              ...(depth ? { depth } : {}), warnings, ...(chartLogDir ? { log_dir: chartLogDir } : {}),
              ...(resumeArg !== undefined ? { resumed_from: resumeArg } : {}),
              ...(reuseOn ? { reuse: true } : {}),
            },
          };
        }

        // ── the single-standard path ──────────────────────────────────────────────────────────
        // Reached only when the target is a standard: the chart branch above always returns, and an
        // unresolvable standard slug returned before the preflights. So there is exactly one here.
        const standard = targetStandards[0]!;

        // Synchronous mode (opt-in via wait:true) — block, return the manifest. The
        // deterministic test path and any caller that wants the answer in one call.
        if (wait) {
          try {
            const res = await runGig(standard, gigInput, {
              outputs: deps.outputs, ledger: deps.ledger, invoke: deps.invoke,
              model_version: deps.model_version, skills: deps.skills, skill_dirs: deps.skill_dirs, evals: deps.evals, budget,
              toolProviders: deps.toolProviders, mcpServerConfigs: deps.mcpServerConfigs, // dispatch preflight resolves against the invoker's environment
              // THE ROOM THIS DISPATCH NAMED, threaded so runGig realizes it or refuses fail-closed —
              // the same conditional-spread trio the chart path uses (server.ts:935-941). `venue` is
              // threaded only when non-empty so runGig's `deps.venue !== undefined` gate is never
              // tripped by an absent one; `venues`/`venueRealizer` come from bootstrap (ServerDeps).
              ...(venue ? { venue } : {}),
              ...(deps.venues ? { venues: deps.venues } : {}),
              ...(deps.venueRealizer ? { venueRealizer: deps.venueRealizer } : {}),
              ...(depth ? { depth } : {}), ...reuseWiring, ...humanWiring,
            });
            return {
              ok: true, requires_approval: approval,
              data: {
                gig_id: res.gig_id,
                // The run's own verdict on itself. A parked gig reported as nothing at all read
                // as a completed one to every caller of the synchronous path.
                status: res.status,
                ...(res.awaiting ? { awaiting: res.awaiting } : {}),
                ...(depth ? { depth } : {}),
                warnings,
                manifest: {
                  genome_hash: res.genome_hash, run_fingerprint: res.run_fingerprint, output_count: res.outputs.length,
                  ...(res.usage ? { usage: res.usage } : {}), // #195 — settled model spend
                  ...(res.budget_state ? { budget_state: res.budget_state } : {}),
                  ...savings(res),
                },
              },
            };
          } catch (e) {
            // A refused resume is a REFUSAL, not a crash: nothing ran, nothing was spent, and
            // the caller needs the drift list to decide whether to re-dispatch cold.
            if (e instanceof ResumeRefused) {
              return { ok: false, requires_approval: approval, error: e.message,
                data: { resume_refused: true, gig_id: e.gig_id, drift: e.drift } };
            }
            if (e instanceof BudgetExhausted) {
              // #236 — the synchronous half: a depleted gig also burned real dollars before it
              // stopped, and the operator needs them in the same reply as the depletion notice.
              const partial = partialGigUsage(e);
              return { ok: false, requires_approval: approval, error: e.message,
                data: { budget_exhausted: true, agent_slug: e.agent_slug, balance: e.balance, cost: e.cost, budget_state: e.state,
                  ...(partial ? { usage: partial } : {}) } };
            }
            throw e;
          }
        }
        // Async mode (default) — register live state, run in the background, return the id
        // immediately so the caller can poll gig_monitor + tail the per-chair logs instead of
        // blocking for the whole run ("synchronous dispatch is not a good pattern").
        // A resumed run CONTINUES the gig it resumes — same id — so the restored outputs stay
        // in-gig and `output_trace` still reaches them. The live-state entry for the earlier
        // attempt is replaced: that gig is running again, and showing its old `failed` state
        // while it runs would be a lie the operator acts on.
        const gigId = resumeArg ?? randomUUID();
        const runs = deps.gig_runs ?? (deps.gig_runs = new Map());
        // #278 review — keep the prior attempt's record so a REFUSED resume can put it back.
        // Overwriting it is right when the resume proceeds (that gig is running again), and
        // destructive when it does not: the operator loses the `failed` status and error they
        // were resuming in response to, and is left with a gig stuck at `running` forever.
        const priorState = runs.get(gigId);
        const state = newGigRun(gigId, slug2, standard.phases.length, new Date().toISOString());
        // #249/#250 — the cancellation handle, held for as long as the run is live. This is the
        // object gig_abort reaches; before it existed there was nothing to reach.
        const controller = new AbortController();
        state.controller = controller;
        runs.set(gigId, state);
        // #253 — bound the live-run map. Only settled entries are dropped, so a running gig's
        // controller is never pruned out from under gig_abort.
        pruneGigRuns(runs);
        const logDir = deps.gig_log_base ? join(deps.gig_log_base, "gigs", gigId) : undefined;
        const onProgress = (ev: Parameters<typeof applyGigProgress>[1]): void => {
          applyGigProgress(state, ev);
          // tee each chair's child events to its own jsonl — the agent-layer log
          if (logDir && ev.type === "agent_event") {
            try { mkdirSync(logDir, { recursive: true }); appendFileSync(join(logDir, `${ev.role}.jsonl`), JSON.stringify(ev.event) + "\n"); } catch { /* best-effort */ }
          }
          // compact milestone line to stderr (captured in the MCP log)
          const line = gigEventLogLine(gigId, ev);
          if (line) { try { process.stderr.write(line + "\n"); } catch { /* best-effort */ } }
        };
        const runPromise = runGig(standard, gigInput, {
          outputs: deps.outputs, ledger: deps.ledger, invoke: deps.invoke,
          model_version: deps.model_version, skills: deps.skills, skill_dirs: deps.skill_dirs, evals: deps.evals, budget,
          toolProviders: deps.toolProviders, mcpServerConfigs: deps.mcpServerConfigs, // dispatch preflight resolves against the invoker's environment
          // Same venue trio as the sync path above — the DEFAULT dispatch mode must honour a named
          // room too, or the fix covers only the deterministic wait:true test path and leaves the
          // path the product actually dispatches through discarding the venue.
          ...(venue ? { venue } : {}),
          ...(deps.venues ? { venues: deps.venues } : {}),
          ...(deps.venueRealizer ? { venueRealizer: deps.venueRealizer } : {}),
          gig_id: gigId, onProgress, signal: controller.signal, ...(depth ? { depth } : {}), ...reuseWiring, ...humanWiring,
        });
        // A REFUSED resume must be answered in THIS reply, not discovered later by polling. The
        // gate throws in runGig's SYNCHRONOUS phase — before its first `await`, which is exactly
        // what "a refused resume spends nothing" means — so the promise is already rejected by
        // the time we get here, and registering this handler first queues it ahead of the
        // microtask that resumes the `await` below. tests/phase_resume_and_reuse pins that
        // ordering property so it cannot silently regress into a "running" reply for a run that
        // never started. (The main chain below still handles the rejection; this only observes.)
        let resumeRefusal: ResumeRefused | undefined;
        if (resumeArg !== undefined) {
          void runPromise.catch((e: unknown) => { if (e instanceof ResumeRefused) resumeRefusal = e; });
        }
        void runPromise
          .then((res) => {
            // A run that PARKED at a human chair settled without completing. Recording it as
            // `complete` erased the park from gig_monitor — the only surface an async caller
            // has — so the operator saw a finished gig with a chair that never sealed.
            state.status = res.status === "awaiting_approval" ? "awaiting_approval" : "complete";
            if (res.awaiting) state.awaiting = res.awaiting;
            state.finished_at = new Date().toISOString();
            state.run_fingerprint = res.run_fingerprint; state.genome_hash = res.genome_hash; state.outputs_count = res.outputs.length;
            if (res.usage) state.usage = res.usage; // #195 — surface settled spend to gig_monitor
            // Say what was skipped. On the async path the manifest never reaches the caller, so
            // gig_monitor is the ONLY place a saving can be reported — and an unreported saving
            // is indistinguishable from chairs that quietly failed to run.
            if (res.skipped) state.skipped_chairs = res.skipped.map((s) => ({ phase: s.phase, role: s.role, reason: s.reason, source_gig_id: s.source_gig_id, output_types: s.output_types }));
            if (res.reuse && res.reuse.rejected.length > 0) state.reuse_rejected = res.reuse.rejected.map((r) => ({ phase: r.phase, role: r.role, reason: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) }));
            // #236 — the synchronous reply has carried budget_state since the budget existed;
            // the async path never did, so the DEFAULT dispatch mode could not answer "what did
            // this consume?" even on success.
            if (res.budget_state) state.budget_state = res.budget_state;
          })
          .catch((e: unknown) => {
            state.finished_at = new Date().toISOString();
            if (e instanceof GigAborted) {
              // A cancelled run is not a crashed run (#251). And the spend it already accrued
              // still has to land: killing children without recording accrued usage would turn
              // a recorded cost into an unrecorded one.
              state.status = "aborted";
              state.abort_reason = e.reason;
              state.outputs_count = e.outputs.length;
              if (e.usage) state.usage = e.usage;
              return;
            }
            state.status = "failed";
            state.error = e instanceof Error ? e.message : String(e);
            // #236 — settled spend used to die here. Async is the DEFAULT dispatch mode, so
            // every failed or aborted gig reported zero dollars while its completed chairs'
            // outputs persisted on disk. Failed runs are the ones whose cost matters most.
            const partial = partialGigUsage(e);
            if (partial) state.usage = partial;
            // ...and the budget half of the same loss: the runtime attaches the snapshot to
            // whatever it throws, but nothing read it back here. A depleted or crashed gig
            // could not say how much of its allowance it had already burned.
            const bs = partialBudgetState(e);
            if (bs) state.budget_state = bs;
            onProgress({ type: "gig_failed", error: state.error });
          })
          .finally(() => { state.controller = undefined; }); // don't pin a controller past settle
        if (resumeArg !== undefined) {
          await Promise.resolve(); // one turn — see the ordering note above
          if (resumeRefusal) {
            // The gig never started, so it must not be left masquerading as a live run — and
            // RESTORING beats deleting. Deleting turned a `failed` gig into an unknown one and
            // left any poller waiting on a run that no longer existed; the failure the operator
            // was acting on is exactly what they still need to see.
            if (priorState) deps.gig_runs?.set(gigId, priorState);
            else deps.gig_runs?.delete(gigId);
            return { ok: false, requires_approval: approval, error: resumeRefusal.message,
              data: { resume_refused: true, gig_id: resumeRefusal.gig_id, drift: resumeRefusal.drift } };
          }
        }
        return {
          ok: true, requires_approval: approval,
          data: {
            gig_id: gigId, status: "running", ...(depth ? { depth } : {}), warnings, ...(logDir ? { log_dir: logDir } : {}),
            // Echo the opt-ins back. A caller who typo'd `reuse` and paid full price for a run
            // they believed was cached has no other way to find out.
            ...(resumeArg !== undefined ? { resumed_from: resumeArg } : {}),
            ...(reuseOn ? { reuse: true } : {}),
          },
        };
      }
      case "gig_monitor": {
        const gid = String(args["gig_id"] ?? "");
        // Prefer the live state map (async runs). Falls back to the ledger/outputs read for a
        // synchronously-completed gig (or one from a prior server lifetime, not in the map).
        const live = deps.gig_runs?.get(gid);
        // A MOVEMENT SEALS UNDER ITS OWN ID, so a raw `===` can never match a chart's records: a
        // movement runs as `<performance>.m.<movement_id>` (src/chart.ts `movementGigId`), and the
        // id an operator holds — the one `gig_dispatch` returned — is the performance's. Resolve
        // through `performanceRoot`, which src/outputs.ts:142-147 declares the ONE owner of that
        // scheme, rather than re-deriving the separator here; that second copy is the drift the
        // note there warns about, and it is what `output_trace` already had to fix (#248,
        // tests/cross_movement_trace.test.ts). A plain gig id is its own root, so a
        // single-standard run is unmoved, and a shared PREFIX is not a root — the infix carries
        // dots on both sides precisely so a uuid cannot be mistaken for a parent of another.
        // BOTH READINGS RESOLVE, and the exact match is not redundant: asking about a MOVEMENT's
        // own id must keep naming its own records, and `performanceRoot(<perf>.m.<mv>)` is
        // `<perf>`, which would not equal the movement id the caller asked about. A root-only
        // predicate trades one false negative for another.
        const ofPerformance = (o: OutputRecord): boolean =>
          o.gig_id === gid || performanceRoot(o.gig_id) === gid;
        if (live) {
          const outs = deps.outputs.all().filter(ofPerformance);
          return {
            ok: true, requires_approval: approval,
            data: {
              status: live.status,
              // Who the run is waiting ON. `awaiting_approval` with no chair named leaves the
              // operator to guess which seat is theirs to sit in.
              ...(live.awaiting ? { awaiting: live.awaiting } : {}),
              standard_slug: live.standard_slug,
              // Present iff this run is a performance of a chart. Absent means one standard, which
              // is what every caller has always been looking at.
              ...(live.chart_slug ? { chart_slug: live.chart_slug } : {}),
              current_phase: live.current_phase ?? null,
              phases_total: live.phases_total,
              phases_complete: live.phases_seen.length,
              chairs: Object.values(live.chairs),
              outputs_count: live.outputs_count,
              outputs_so_far: outs,
              ...(live.run_fingerprint ? { run_fingerprint: live.run_fingerprint } : {}),
              ...(live.usage ? { usage: live.usage } : {}), // #195 — settled model spend, queryable by gig_id
              // #236 — what the gig consumed of its allowance, on BOTH terminal paths. Carries
              // `unit: "append-units"` and the real `settled_usd` alongside (#233), so nothing
              // reads the synthetic proxy as dollars.
              ...(live.budget_state ? { budget_state: live.budget_state } : {}),
              // A run that skipped phases must SAY which and why. On the async path this is the
              // only surface that can carry it, and a run showing 6 phases complete in 4 seconds
              // is otherwise indistinguishable from one whose chairs quietly did nothing.
              ...(live.skipped_chairs ? { skipped_chairs: live.skipped_chairs } : {}),
              ...(live.resumed_from ? { resumed_from: live.resumed_from } : {}),
              ...(live.reuse_rejected ? { reuse_rejected: live.reuse_rejected } : {}),
              ...(live.abort_reason ? { abort_reason: live.abort_reason } : {}), // why it stopped (#251)
              ...(live.error ? { error: live.error } : {}),
              ...(live.finished_at ? { finished_at: live.finished_at } : {}),
            },
          };
        }
        // The non-live path is the DAMAGING one: `status` and `phases_complete` below are derived
        // from this list, so an unresolved chart id did not merely omit the records — it answered
        // "unknown" and "0 phases" about a performance that had demonstrably done work.
        const outs = deps.outputs.all().filter(ofPerformance);
        const entry = deps.ledger.query({ kind: "gig", gig_id: gid })[0];
        return {
          ok: true, requires_approval: approval,
          data: {
            status: entry ? "complete" : outs.length > 0 ? "running" : "unknown",
            phases_complete: outs.length,
            current_agent: outs.length ? outs[outs.length - 1]!.agent_slug : null,
            outputs_so_far: outs,
            // #195 — settled spend from the ledger (post-restart path). Only a gig row carries usage.
            ...(entry?.kind === "gig" && entry.usage ? { usage: entry.usage } : {}),
          },
        };
      }
      case "gig_logs": {
        // The agent-layer transcript, served (not hand-read off disk). gig_monitor gives the
        // coltrane-layer summary; this returns each chair's child events from the per-chair
        // jsonl the async dispatcher tees. Filter by role and/or event type; tail the last N.
        const gid = String(args["gig_id"] ?? "");
        const roleFilter = args["role"] ? String(args["role"]) : undefined;
        const typeFilter = args["type"] ? String(args["type"]) : undefined;
        const tail = typeof args["tail"] === "number" ? (args["tail"] as number) : undefined;
        const dir = deps.gig_log_base ? join(deps.gig_log_base, "gigs", gid) : undefined;
        if (!dir || !existsSync(dir)) {
          return { ok: true, requires_approval: approval, data: { gig_id: gid, roles: [], count: 0, events: [] } };
        }
        const roleFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
        const roles = roleFilter ? roleFiles.filter((r) => r === roleFilter) : roleFiles;
        const events: Array<Record<string, unknown>> = [];
        for (const role of roles) {
          const lines = readFileSync(join(dir, `${role}.jsonl`), "utf8").split("\n").filter(Boolean);
          for (const l of lines) {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              if (typeFilter && e["type"] !== typeFilter) continue;
              events.push({ role, ...e });
            } catch { /* skip malformed */ }
          }
        }
        const sliced = tail !== undefined ? events.slice(-tail) : events;
        return { ok: true, requires_approval: approval, data: { gig_id: gid, roles, count: events.length, events: sliced } };
      }
      case "tool_registry_browse": {
        let tools = [...MCP_TOOLS];
        if (args["category"]) tools = tools.filter((t) => t.category === args["category"]);
        return { ok: true, requires_approval: approval, data: { tools: tools.map((t) => ({ slug: t.slug, category: t.category })), usage_stats: [], dependency_map: {} } };
      }
      case "standard_compose": {
        try {
          const sSlug = String(args["slug"] ?? "");
          const sDomain = String(args["domain"] ?? "");
          // Rob #132 — resolve agent slugs from the genome. Before: clients had
          // to round-trip the full Agent JSON (slug + primitives + types + ...)
          // because composeStandard does a slug-keyed lookup and would NPE on
          // plain string slugs. Now: when an entry is a string or a slug-only
          // object, look it up in deps.agents (populated by bootstrap from the
          // loaded genome). Full Agent objects are passed through unchanged.
          // The input_schema advertises BOTH keys: `agents` is the compose-input shape; `agent_slugs`
          // is the shape the PERSISTED standards/<slug>.json file carries (written at line ~1413).
          // Reading only `agents` made `agent_slugs` a silent no-op that failed via the misleading
          // "agent not found" error — and broke the read-file/re-compose round-trip. Fall back to
          // `agent_slugs` when `agents` is absent so the documented parameter actually composes.
          const sAgentsRaw = (args["agents"] as unknown[]) ?? (args["agent_slugs"] as unknown[]) ?? [];
          const sAgents: Agent[] = sAgentsRaw.map((a) => {
            if (typeof a === "string") {
              const loaded = deps.agents?.get(a);
              if (!loaded) throw new CompositionError(`agent "${a}" not found in genome`);
              return loaded;
            }
            if (a && typeof a === "object" && "slug" in a && !("primitives" in a)) {
              const slug = (a as { slug: string }).slug;
              const loaded = deps.agents?.get(slug);
              if (loaded) return loaded;
              throw new CompositionError(`agent "${slug}" not found in genome (slug-only object form)`);
            }
            return a as Agent;
          });
          const sPhases = (args["phases"] as PhaseDef[]) ?? [];
          // Carry EVERY passthrough field the schema declares (eval_slugs, input_types, output_types,
          // max_examine_rounds, description, …) through compose → live map → persisted file. The
          // handler used to thread only eval_slugs, silently dropping input_types/output_types/
          // max_examine_rounds/description on both the compose call AND the persisted file — so a
          // standard authored via the TOOL lost exactly the fields composeStandard preserves on the
          // FILE path (audit finding D). Copy by the schema's own key list (STD_PASSTHROUGH) so it
          // can't re-drift.
          const extras: Record<string, unknown> = {};
          for (const k of STD_PASSTHROUGH) if (args[k] !== undefined) extras[k] = args[k];
          const std = composeStandard({ slug: sSlug, domain: sDomain, agents: sAgents, phases: sPhases, ...extras });
          // Write-through to the LIVE map so gig_dispatch sees the new standard
          // in the same session (no rebootstrap needed).
          deps.standards?.set(sSlug, std);
          // substrate seal: persist a loadable standards/<slug>.json (agent_slugs form) + ledger.
          const fileDef = { slug: sSlug, domain: sDomain, agent_slugs: sAgents.map((a) => a.slug), phases: sPhases, ...extras };
          const sealed = sealDefinition("standard_compose", sSlug, fileDef, deps.ledger, deps.genome_dir, "standards");
          return { ok: true, requires_approval: approval, data: { standard_id: std.slug, content_hash: sealed.content_hash, dependency_hash: sealed.dependency_hash, effective_hash: sealed.effective_hash, validation_result: { valid: true } } };
        } catch (e) {
          if (e instanceof CompositionError) return { ok: false, requires_approval: approval, error: e.message, data: { validation_result: { valid: false, error: e.message } } };
          throw e;
        }
      }
      case "chart_define": {
        // The arrangement, authored through the genome's mouth. Every field is read explicitly from
        // the schema's own key set — the surface is generated from ChartSchema, so a field added
        // there must be threaded here or the drift guard reds.
        if (!deps.standards) {
          return { ok: false, not_implemented: true, requires_approval: approval, error: "chart_define needs a standards map (bootstrap from a genome) — a chart's movements name standards, and a chart composed against nothing is a chart of dead names" };
        }
        const cSlug = String(args["slug"] ?? "");
        const chartInputDef = {
          slug: cSlug,
          movements: (args["movements"] as unknown[]) ?? [],
          ...(args["edges"] !== undefined ? { edges: args["edges"] } : {}),
          ...(args["approval_gates"] !== undefined ? { approval_gates: args["approval_gates"] } : {}),
          ...(args["budget_envelope"] !== undefined ? { budget_envelope: args["budget_envelope"] } : {}),
          ...(args["venue"] !== undefined ? { venue: args["venue"] } : {}),
        } as Parameters<typeof composeChart>[0]["chart"];
        const shape = ChartSchema.safeParse(chartInputDef);
        const composed = composeChart({
          chart: chartInputDef,
          standards: deps.standards,
          ...(deps.agents ? { agents: deps.agents } : {}),
          ...(deps.venues ? { venues: deps.venues } : {}),
          // Authoring time knows no payload, so a boundary movement's declared gig contract stands
          // in for it — the same rule the loader applies, and dispatch re-checks against the real
          // payload. (An unparseable chart has no movements to read; composeChart reports R0.)
          payload_types: shape.success ? chartEntrySeedTypes(shape.data, deps.standards) : [],
        });
        if (!composed.ok) {
          const why = composed.violations.map((v) => `${v.rule}: ${v.detail}`).join(" | ");
          return {
            ok: false, requires_approval: approval, error: `chart "${cSlug}" was refused: ${why}`,
            data: { validation_result: { valid: false, violations: composed.violations } },
          };
        }
        // Write-through to the LIVE map so gig_dispatch can perform it in the same session.
        deps.charts?.set(cSlug, composed.chart);
        const chartFile = { ...composed.chart };
        const sealedChart = sealDefinition("chart_define", cSlug, chartFile, deps.ledger, deps.genome_dir, "charts");
        return {
          ok: true, requires_approval: approval,
          data: {
            chart_id: composed.chart.slug, chart_hash: composed.chart_hash,
            movements: composed.order, edges_classified: composed.edges_classified,
            content_hash: sealedChart.content_hash, dependency_hash: sealedChart.dependency_hash,
            effective_hash: sealedChart.effective_hash,
            validation_result: { valid: true },
          },
        };
      }

      case "venue_define": {
        // The room. BOTH gates, in the loader's order: the single Zod source for the shape, then
        // venueDefect for the cross-field rules — so a venue authored here cannot slip past a check
        // a venue read off disk would hit.
        const vSlug = String(args["slug"] ?? "");
        const venueInputDef = {
          slug: vSlug,
          institution_slug: args["institution_slug"],
          ...(args["description"] !== undefined ? { description: args["description"] } : {}),
          ...(args["flavor"] !== undefined ? { flavor: args["flavor"] } : {}),
          // Pass through only what was stated. The schema owns the defaults — including that an
          // unstated `equipment` is the EMPTY room — so this handler cannot disagree with the loader
          // about what a bare venue means.
          ...(args["equipment"] !== undefined ? { equipment: args["equipment"] } : {}),
          ...(args["doors"] !== undefined ? { doors: args["doors"] } : {}),
          ...(args["installs"] !== undefined ? { installs: args["installs"] } : {}),
          ...(args["credential_surface"] !== undefined ? { credential_surface: args["credential_surface"] } : {}),
          ...(args["lifecycle"] !== undefined ? { lifecycle: args["lifecycle"] } : {}),
          ...(args["responsible_chair"] !== undefined ? { responsible_chair: args["responsible_chair"] } : {}),
          // The worker-contract fields, passed through by the same rule: only what was stated, so the
          // schema keeps ownership of every default (an unstated `mcp_servers`/`devices`/`architectures`
          // is the EMPTY list, an unstated `substrate`/`floor`/`max_concurrent_chairs` the deployment
          // default). Read here so a room authored through this tool actually carries its substrate,
          // and so the advertised schema and the handler stay one statement of the same fact (#234).
          ...(args["substrate"] !== undefined ? { substrate: args["substrate"] } : {}),
          ...(args["mcp_servers"] !== undefined ? { mcp_servers: args["mcp_servers"] } : {}),
          ...(args["devices"] !== undefined ? { devices: args["devices"] } : {}),
          ...(args["architectures"] !== undefined ? { architectures: args["architectures"] } : {}),
          ...(args["max_concurrent_chairs"] !== undefined ? { max_concurrent_chairs: args["max_concurrent_chairs"] } : {}),
          ...(args["floor"] !== undefined ? { floor: args["floor"] } : {}),
          // The repository this room's tree is populated from, passed through by the same only-what-
          // was-stated rule: an unstated `repo_url` is the EMPTY room the schema defaults it to. Read
          // here so a room authored through this tool actually carries its declared repository, and so
          // the advertised schema and the handler stay one statement of the same fact (#234) — the
          // field a caller sees is the field the handler acts on, never advertised and silently dropped.
          ...(args["repo_url"] !== undefined ? { repo_url: args["repo_url"] } : {}),
        };
        const parsedVenue = VenueSchema.safeParse(venueInputDef);
        if (!parsedVenue.success) {
          const why = parsedVenue.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
          return {
            ok: false, requires_approval: approval, error: `venue "${vSlug}" was refused: ${why}`,
            data: { validation_result: { valid: false, error: why } },
          };
        }
        const vDefect = venueDefect(parsedVenue.data);
        if (vDefect) {
          return {
            ok: false, requires_approval: approval, error: vDefect,
            data: { validation_result: { valid: false, error: vDefect } },
          };
        }
        deps.venues?.set(vSlug, parsedVenue.data);
        const sealedVenue = sealDefinition("venue_define", vSlug, parsedVenue.data, deps.ledger, deps.genome_dir, "venues");
        return {
          ok: true, requires_approval: approval,
          data: {
            venue_id: parsedVenue.data.slug,
            // What a room actually permits, echoed back: an author who meant "read-only tools" and
            // typed nothing has built the EMPTY room, and the count is where they see it.
            tool_count: parsedVenue.data.equipment.tools.length,
            content_hash: sealedVenue.content_hash, dependency_hash: sealedVenue.dependency_hash,
            effective_hash: sealedVenue.effective_hash,
            validation_result: { valid: true },
          },
        };
      }

      case "agent_validate_pipeline": {
        if (Array.isArray(args["primitives"])) {
          try {
            defineAgent({
              slug: String(args["slug"] ?? "pipeline-check"),
              primitives: args["primitives"] as Primitive[],
              // synthetic agent: only the primitive progression is under test here, so the
              // behavioral fields are stubs that satisfy defineAgent's required-field gate.
              identity: "pipeline validation stub",
              method: "validate the primitive progression",
              constraints: [],
              behavioral_primitives: ["analyst", "critic"],
            });
            return { ok: true, requires_approval: approval, data: { valid: true, errors: [], illegal_progressions: [], unsatisfied_inputs: [] } };
          } catch (e) {
            if (e instanceof CompositionError) return { ok: true, requires_approval: approval, data: { valid: false, errors: [e.message], illegal_progressions: [e.message], unsatisfied_inputs: [] } };
            throw e;
          }
        }
        try {
          composeStandard({
            slug: String(args["standard_slug"] ?? "pipeline-check"),
            domain: String(args["domain"] ?? ""),
            agents: ((args["agents"] as Agent[]) ?? []),
            phases: ((args["phases"] as PhaseDef[]) ?? []),
          });
          return { ok: true, requires_approval: approval, data: { valid: true, errors: [], illegal_progressions: [], unsatisfied_inputs: [] } };
        } catch (e) {
          if (e instanceof CompositionError) return { ok: true, requires_approval: approval, data: { valid: false, errors: [e.message], illegal_progressions: [e.message], unsatisfied_inputs: [] } };
          throw e;
        }
      }
      case "type_extend": {
        // resolve the base type from the registry, propose the field additions.
        const baseDef = deps.registry.listTypes().find((t) => t.slug === args["slug"]);
        if (!baseDef) return { ok: false, requires_approval: approval, error: `unknown type "${String(args["slug"])}"` };
        const baseProps = (baseDef.schema as { properties?: Record<string, unknown> }).properties ?? {};
        const extension = (args["extension"] as { schema?: { properties?: Record<string, unknown>; required?: string[] } }) ?? undefined;
        const addProps =
          (extension?.schema?.properties as Record<string, unknown> | undefined) ??
          (args["fields_to_add"] as Record<string, unknown>) ?? {};
        const nextProps = { ...baseProps, ...addProps };
        const nextRequired = extension?.schema?.required ?? baseDef.required_fields;
        const base: DomainTypeDef = {
          slug: baseDef.slug, version: 1, extends: baseDef.extends, domain: baseDef.domain,
          status: "active", schema: { type: "object", properties: baseProps }, required_fields: baseDef.required_fields,
        };
        // THE THIRD DOOR. `{...baseProps, ...addProps}` above is the exact merge #264 is
        // about, and this handler reached `recordIdentity` without ever consulting
        // `registerType` or `domainTypeDefect` — so `type_extend` could persist and version a
        // definition the engine had just declared illegal. #264 names this tool explicitly.
        //
        // The thesis of that fix was "there are two doors into the type table, and a rule
        // enforced at one of them is a rule with a way around it." There were three.
        const extendDefect = domainTypeDefect({
          slug: baseDef.slug,
          extends: baseDef.extends,
          schema: { properties: nextProps },
          // 2026-08-08 — the undeclared-required check needs the extension's required
          // set, or an extend could version-in a requirement no producer can see.
          required_fields: nextRequired,
        });
        if (extendDefect) {
          return { ok: false, requires_approval: approval, error: `type_extend rejected: ${extendDefect}` };
        }
        const next: DomainTypeDef = {
          ...base, schema: { type: "object", properties: nextProps }, required_fields: nextRequired,
        };
        const proposal = proposeTypeChange(base, next);
        const newFields = Object.keys(nextProps).length - Object.keys(baseProps).length;
        // substrate seal: the new version's identity is recorded in the ledger (file
        // materialization of versioned types follows the version-aware loader path).
        const versioned = { ...next, version: proposal.next_version };
        const tx = deps.genome_dir ? recordIdentity("type_extend", `${base.slug}@v${proposal.next_version}`, versioned, deps.ledger, args["reason"] != null ? { reason: args["reason"] } : undefined) : undefined;
        return { ok: true, requires_approval: proposal.approval_required, data: { new_version: proposal.next_version, changelog_entry: `${proposal.change_class}: +${newFields} field(s)`, change_class: proposal.change_class, effective_hash: tx?.effective_hash, content_hash: tx?.content_hash } };
      }
      case "charter_read": {
        const path = args["path"] ? String(args["path"]) : "";
        if (!path) return { ok: false, requires_approval: approval, error: "charter_read: path required (no default charter location)" };
        if (!existsSync(path)) return { ok: false, requires_approval: approval, error: `charter_read: file not found at ${path}` };
        try {
          const raw = JSON.parse(readFileSync(path, "utf-8"));
          const ch = loadCharter(raw);
          return { ok: true, requires_approval: approval, data: ch };
        } catch (e) {
          if (e instanceof CharterError) return { ok: false, requires_approval: approval, error: e.message };
          throw e;
        }
      }
      case "charter_suggest_update": {
        // Validate BEFORE appending. The append-first shape let `charter_suggest_update({})`
        // pump a permanent, content-free row into a store with no compaction and no retention.
        // session_review_write was already the correct pattern in this file.
        const field = String(args["field"] ?? "");
        if (!field) {
          return { ok: false, requires_approval: approval, error: "charter_suggest_update requires field" };
        }
        const proposal_id = randomUUID();
        deps.ledger.append(governanceRow("charter_suggest_update", field, {
          proposal_id,
          current_value: args["current_value"] ?? null,
          suggested_value: args["suggested_value"] ?? null,
          evidence: args["evidence"] ?? null,
        }));
        return {
          ok: true, requires_approval: true,
          data: {
            proposal_id,
            field,
            current_value: args["current_value"] ?? null,
            suggested_value: args["suggested_value"] ?? null,
            evidence: args["evidence"] ?? null,
          },
        };
      }
      case "system_health": {
        // #216 — GIG rows, not every row. `count()` used to be the raw row total, so every
        // agent_define, promotion, proposal, review, tool_register and abort inflated the
        // reported gig count AND the derived cost AND the reported budget spend.
        // ONE read, two derivations. These were a `count()` and a separate `query()`, each a
        // full file read for FileLedger — so an append landing between them made `gigs_run`
        // and `cost` describe different ledgers IN THE SAME RESPONSE. `read()`'s own docstring
        // promises "a single read pass shared by query / count / integrity, so the three can
        // never disagree"; the call site was undoing that.
        // #234 — `window` was advertised and ignored, so every reading below silently covered
        // all time. It is a filter on the SAME single read pass, so the totals still cannot
        // disagree with each other.
        const shWindow = parseWindow(args["window"], Date.now());
        if (shWindow.error) return { ok: false, requires_approval: approval, error: shWindow.error };
        const gigRows = deps.ledger.query({ kind: "gig", ...(shWindow.after ? { after: shWindow.after } : {}) });
        const gigs_run = gigRows.length;
        // Settled spend where we have it (#195) — a real number now that gig rows are
        // separable, instead of a row-count proxy standing in for dollars.
        const cost = gigRows.reduce((sum, e) => sum + (e.kind === "gig" ? e.usage?.total_cost_usd ?? 0 : 0), 0);
        // #255 — both audit surfaces compute an honest damage report and nothing ever asked
        // for it: `integrity` had ZERO call sites in this file. `load_errors` below is the
        // precedent — a soft-failure channel surfaced here because CLAUDE.md sends operators
        // to system_health first. Corruption belongs in the same place and reads as loudly.
        const ledger_integrity = deps.ledger.integrity();
        const outputs_integrity = deps.outputs.integrity();
        // What we can actually justify saying about the totals below. `countsShort` is only
        // ever set from damage we FOUND; nothing here infers completeness from its absence.
        const countsShort = !ledger_integrity.ok || !outputs_integrity.ok;
        const damaged = [
          ...(ledger_integrity.ok ? [] : [`ledger (${ledger_integrity.corrupt.length} unreadable line(s))`]),
          ...(outputs_integrity.ok ? [] : [`output store (${outputs_integrity.corrupt.length} unreadable line(s))`]),
        ];
        const countsBasis = countsShort
          ? `counts are SHORT: ${damaged.join(" and ")} — every total below is computed over the rows that parsed. ` +
            `Note the output store's report also covers the refs graph, which feeds only \`refs\`; if the damage is ` +
            `confined there the other totals may in fact be whole.`
          : `no unreadable line was found (ledger: ${ledger_integrity.entries} entries; output store: ` +
            `${outputs_integrity.scanned} file(s) scanned). That is NOT proof the counts are complete — a jsonl ` +
            `truncated at a line boundary loses whole rows without leaving a parse error, and an in-memory ledger ` +
            `or a store with no persistDir has nothing to scan at all.`;
        const outs = deps.outputs.all();
        const type_stats: Record<string, number> = {};
        const agent_stats: Record<string, number> = {};
        for (const o of outs) {
          type_stats[o.domain_type] = (type_stats[o.domain_type] ?? 0) + 1;
          agent_stats[o.agent_slug] = (agent_stats[o.agent_slug] ?? 0) + 1;
        }
        return {
          ok: true, requires_approval: approval,
          data: {
            gigs_run, cost, type_stats, agent_stats,
            types: deps.registry.listTypes().length, outputs: outs.length, refs: deps.outputs.refs().length,
            tool_stats: {}, bottlenecks: [], budget: { spent: cost, remaining: null },
            // Rob #129 — surface what was skipped at load so operators see broken files
            load_errors: deps.load_errors ?? [],
            // #255 — the damage reports, and an honest label on everything derived from them.
            ledger_integrity,
            outputs_integrity,
            // gigs_run / cost / outputs / type_stats / agent_stats are all computed over the
            // rows that PARSED, so a corrupt line makes every one of them SHORT.
            //
            // ROUND 2 — this is `false` or `null` and NEVER `true`, deliberately.
            //
            // The first version was `ledger_integrity.ok && outputs_integrity.ok`, which
            // claimed completeness from the absence of a parse error. That does not follow.
            // A jsonl truncated at a LINE BOUNDARY — the likeliest way an append-only file
            // gets damaged, and what an interrupted write usually leaves — loses whole rows
            // without leaving anything unparseable behind. Both reports come back clean and
            // the counts are still short. Worse, the predicate was structurally constant in
            // real deployments: `MemoryLedger.integrity()` is unconditionally ok, and a store
            // with no persistDir has nothing to scan, so a server wired that way could never
            // report anything but `true`.
            //
            // That is precisely the #238 pattern this surface exists to oppose — a hardcoded
            // affirmative dressed as a measurement. Corruption we FOUND is provable;
            // completeness is not. So the field states only what can be known, and the basis
            // says why, following #238's own remedy: a labelled null is an answer, a
            // fabricated attestation is not.
            counts_complete: countsShort ? false : null,
            counts_complete_basis: countsBasis,
            // genome extension — per-slug layer provenance, queryable at runtime (e.g.
            // a consumer checking "is this player coming from where I expect" before composing)
            provenance: deps.provenance ? Object.fromEntries(deps.provenance) : {},
          },
        };
      }
      case "genome_reload": {
        // Rob #130 — re-read the genome from disk and update deps in place. No
        // MCP server restart needed; the user's Claude Code session keeps its
        // conversational context.
        if (!deps.genome_dir) {
          return { ok: false, requires_approval: approval, error: "genome_reload requires deps.genome_dir; this server wasn't bootstrapped from a genome directory" };
        }
        const fresh = resolveGenome(deps.genome_dir);

        // Diff each definition class against the live deps.
        const standardsBefore = new Map(deps.standards ?? []);
        const skillsBefore = new Map(deps.skills ?? []);
        const evalsBefore = new Map(deps.evals ?? []);
        const typesBefore = new Map(deps.registry.listTypes().map((t) => [t.slug, t] as const));

        // domain_types — registry.replaceTypes does the mutation + diff.
        const typeDefs: DomainType[] = [...fresh.domain_types.values()].map((d) => ({
          slug: d.slug,
          extends: d.extends,
          domain: d.domain,
          schema: d.schema as Record<string, unknown>,
          required_fields: [...d.required_fields],
        }));
        const typeDiff = deps.registry.replaceTypes(typeDefs);

        // standards — mutate in place so callers holding deps.standards see updates.
        const standardsDiff = syncMap(deps.standards, fresh.standards, standardsBefore);
        const skillsDiff = syncMap(deps.skills, fresh.skills, skillsBefore);
        const evalsDiff = syncMap(deps.evals, fresh.evals, evalsBefore);

        // Refresh surfaced load_errors so the next system_health call sees them.
        deps.load_errors = [...fresh.load_errors];

        // agents — diff against deps.agents (the prior-load snapshot) then
        // mutate deps.agents in place so the next reload sees the new baseline.
        const agentsBefore = new Map(deps.agents ?? []);
        const agentsDiff = syncMap(deps.agents, fresh.agents, agentsBefore);

        // charts + venues — same in-place sync. A reload that refreshed standards and left the
        // arrangements over them stale would leave gig_dispatch performing a chart the genome no
        // longer describes, which is the class of drift genome_reload exists to close.
        const chartsBefore = new Map(deps.charts ?? []);
        const chartsDiff = syncMap(deps.charts, fresh.charts, chartsBefore);
        const venuesBefore = new Map(deps.venues ?? []);
        const venuesDiff = syncMap(deps.venues, fresh.venues, venuesBefore);

        // typesBefore is captured for symmetry; not currently surfaced beyond typeDiff.
        void typesBefore;

        return {
          ok: true, requires_approval: approval,
          data: {
            reloaded: true,
            changes: {
              added: {
                domain_types: typeDiff.added,
                standards: standardsDiff.added,
                skills: skillsDiff.added,
                evals: evalsDiff.added,
                agents: agentsDiff.added,
                charts: chartsDiff.added,
                venues: venuesDiff.added,
              },
              modified: {
                domain_types: typeDiff.modified,
                standards: standardsDiff.modified,
                skills: skillsDiff.modified,
                evals: evalsDiff.modified,
                agents: agentsDiff.modified,
                charts: chartsDiff.modified,
                venues: venuesDiff.modified,
              },
              removed: {
                domain_types: typeDiff.removed,
                standards: standardsDiff.removed,
                skills: skillsDiff.removed,
                evals: evalsDiff.removed,
                agents: agentsDiff.removed,
                charts: chartsDiff.removed,
                venues: venuesDiff.removed,
              },
            },
            load_errors: deps.load_errors,
          },
        };
      }
      case "server_restart": {
        // PR #141 — the relay parent-process intercepts this call before it
        // reaches the server child. If execution reaches this handler, the
        // relay is misconfigured (typically: COLTRANE_SERVER_DIRECT=1 was
        // set, bypassing the relay) and the conversation will lose its pipe
        // if the server is killed.
        //
        // The registry spec exists for discoverability (tool_inspect,
        // system_audit). This guard turns "silent miss" into "loud error"
        // when the relay isn't catching.
        return {
          ok: false,
          requires_approval: approval,
          error:
            "server_restart was not intercepted by the relay; the server child cannot restart itself in place. This usually means COLTRANE_SERVER_DIRECT=1 was set on the parent process, so the relay was skipped. Restart Claude Code without that env var (or use Rob's pre-relay workaround: `claude mcp remove coltrane -s local` → `claude mcp add coltrane node /path/to/dist/src/server_entry.js` → `/branch` → `claude -r <session-id>`). See docs/mcp_hot_reload.md.",
        };
      }
      case "health_check": {
        const targetSlug = String(args["slug"] ?? "");
        const targetKind = String(args["kind"] ?? args["entity_type"] ?? "");
        // #234 — the advertised-and-ignored `window`, same as system_health.
        const hcWindow = parseWindow(args["window"], Date.now());
        if (hcWindow.error) return { ok: false, requires_approval: approval, error: hcWindow.error };
        // The window has to reach BOTH stores. Applying it only to the ledger would make a
        // windowed health_check on a standard mean one thing and on an agent mean another.
        const all = hcWindow.after
          ? deps.outputs.all().filter((o) => o.created_at >= hcWindow.after!)
          : deps.outputs.all();
        // standards live in the ledger (executions); agents/types in the outputs store.
        const gigRows = targetKind === "standard"
          ? deps.ledger.query({ kind: "gig", standard_slug: targetSlug, ...(hcWindow.after ? { after: hcWindow.after } : {}) }).filter(isGig)
          : [];
        const execution_count = gigRows.length;
        const filtered = targetKind === "agent"
          ? all.filter((o) => o.agent_slug === targetSlug)
          : targetKind === "standard"
            ? []
            : all.filter((o) => o.domain_type === targetSlug);
        const output_count = targetKind === "standard" ? execution_count : filtered.length;
        // #238 — REAL dollars. `cost: output_count` reported "2" for $1.25 of spend; the engine
        // has carried settled model spend on the gig row since #195, so the proxy is now simply
        // a wrong number where a right one is available.
        const cost_usd = targetKind === "standard"
          ? gigRows.reduce((s, e) => s + (e.usage?.total_cost_usd ?? 0), 0)
          : filtered.reduce((s, o) => s + (o.cost_usd ?? 0), 0);
        return {
          ok: true, requires_approval: approval,
          data: {
            entity: targetSlug, kind: targetKind, output_count, execution_count,
            usage: output_count,
            cost: cost_usd, cost_usd,
            cost_basis: targetKind === "standard"
              ? "settled model spend summed over this standard's gig rows (#195)"
              : "sum of per-output cost_usd; unset on model-invoked outputs today, so 0 can mean 'not recorded'",
            // #238 — these were the literal constants 1.0 and "stable" for ANY entity. An agent
            // that failed every dispatch it ever ran reported a 100% success rate, and it COULD
            // NOT report otherwise: a failed gig writes no ledger row, so the denominator does
            // not exist. A fabricated measurement presented as a measurement is worse than a
            // missing one, because the missing one gets investigated. null + a stated reason.
            success_rate: null,
            success_rate_basis:
              "unavailable — a failed gig writes no ledger row, so the denominator does not exist; " +
              "any rate computed from what IS recorded would be 1.0 by construction (#236)",
            trend: null,
            trend_basis: "unavailable — no time-windowed execution history is retained to compare against",
            recommendations: [],
          },
        };
      }
      case "system_audit": {
        // Real derivation over the genome: a registered domain type with zero
        // outputs is an unused type — the canonical audit finding in v0.
        // #234 — `scope` and `check` were advertised and ignored, so a caller auditing one
        // domain received findings for every domain and had no way to tell.
        const auditScope = args["scope"] !== undefined ? String(args["scope"]) : undefined;
        const auditCheck = args["check"] !== undefined ? String(args["check"]) : undefined;
        const KNOWN_CHECKS = ["unused_type"];
        if (auditCheck !== undefined && !KNOWN_CHECKS.includes(auditCheck)) {
          return { ok: false, requires_approval: approval, error: `unknown check "${auditCheck}" — known checks: ${KNOWN_CHECKS.join(", ")}` };
        }
        // `scope` narrows to a domain; the counts reported must describe the SAME slice the
        // findings do, or the response contradicts itself.
        const allTypes = deps.registry.listTypes();
        const types = auditScope ? allTypes.filter((t) => t.domain === auditScope) : allTypes;
        const allOutputs = deps.outputs.all();
        const scopedOutputs = auditScope
          ? allOutputs.filter((o) => types.some((t) => t.slug === o.domain_type))
          : allOutputs;
        const usedTypes = new Set(allOutputs.map((o) => o.domain_type));
        const unused_types = types.filter((t) => !usedTypes.has(t.slug)).map((t) => t.slug);
        const findings = (auditCheck === undefined || auditCheck === "unused_type")
          ? unused_types.map((slug) => ({ kind: "unused_type", slug, severity: "info" }))
          : [];
        return { ok: true, requires_approval: approval, data: { findings, unused_types, type_count: types.length, output_count: scopedOutputs.length, ...(auditScope ? { scope: auditScope } : {}), ...(auditCheck ? { check: auditCheck } : {}) } };
      }
      // #234 — these two minted a UUID, discarded every argument, and reported success.
      //
      // Not a no-op: a fabricated `proposal_id` is a RECEIPT. A caller handed one has been told
      // their proposal was recorded and can be looked up, and neither was true — the slug, spec
      // and reason went nowhere, and nothing anywhere could be found under that id.
      //
      // Their own tests sat in a describe block named "proposal tools (LEDGER-BACKED)", where
      // the `proposal_create` case asserts `ledger.query().length === 1` and these two assert
      // only `typeof proposal_id === "string"` — which `randomUUID()` satisfies forever. A
      // regression guard elsewhere states "all are wired against real in-repo impl now". The
      // fabricated id is precisely what made both look true.
      //
      // So: record what the caller sent, through the same `governanceRow` path proposal_create
      // uses. Deprecation is a governance act on the tool registry; a proposal to remove a tool
      // that leaves no trace is worse than one that is refused, because the refusal is visible.
      //
      // Kept as two case blocks rather than one fallthrough: they take different arguments, and
      // a shared body makes each tool appear to read the other's — which is exactly the
      // schema/handler drift this issue is about, reintroduced in the fix for it.
      case "tool_propose": {
        const toolSlug = String(args["slug"] ?? "");
        if (!toolSlug) return { ok: false, requires_approval: approval, error: "tool_propose requires slug" };
        const proposal_id = randomUUID();
        deps.ledger.append(governanceRow("tool_propose", toolSlug, {
          proposal_id,
          reason: args["reason"] ?? null,
          tool_type: args["type"] ?? null,
          spec: args["spec"] ?? null,
        }));
        return { ok: true, requires_approval: true, data: { proposal_id } };
      }
      case "tool_deprecate_propose": {
        const toolSlug = String(args["slug"] ?? "");
        if (!toolSlug) return { ok: false, requires_approval: approval, error: "tool_deprecate_propose requires slug" };
        const proposal_id = randomUUID();
        deps.ledger.append(governanceRow("tool_deprecate_propose", toolSlug, {
          proposal_id,
          reason: args["reason"] ?? null,
          usage_stats: args["usage_stats"] ?? null,
        }));
        return { ok: true, requires_approval: true, data: { proposal_id, affected_agents: [] } };
      }
      case "proposal_create": {
        const change_type = String(args["change_type"] ?? "");
        const target = String(args["target"] ?? "");
        if (!change_type || !target) {
          return { ok: false, requires_approval: approval, error: "proposal_create requires change_type and target" };
        }
        const proposal_id = randomUUID();
        deps.ledger.append(governanceRow("proposal_create", target, {
          proposal_id, change_type, reason: args["reason"] ?? null,
          target_kind: args["target_kind"] ?? null,
        }));
        return {
          ok: true, requires_approval: approval,
          data: { proposal_id, cascade_impact: { agents_affected: [], standards_affected: [] } },
        };
      }
      case "capability_research": {
        // Real local gap-search over the genome: does any existing tool or domain
        // type already cover the asked-for capability? If nothing matches, it's a gap.
        //
        // #234 — this handler read `query`/`capability` while the tool advertised `need`/
        // `context`. The two sets did not overlap, so EVERY caller following the schema
        // searched for the empty string. That is not a no-op: an empty search matches nothing,
        // nothing matched means `gap: true`, and the tool answered "no existing capability —
        // propose a new tool/type" for every capability the engine has. The one tool whose job
        // is to stop redundant definitions recommended a new one, unconditionally, to anyone
        // who used it as documented — inverting this repo's "reuse and evolve, don't duplicate"
        // rule at precisely the step that rule is meant to govern.
        //
        // `need` is now primary (it is the advertised name); `query`/`capability` stay as
        // accepted aliases so existing callers keep working, and are advertised too.
        const q = String(args["need"] ?? args["query"] ?? args["capability"] ?? "").trim().toLowerCase();
        // An empty search is REFUSED rather than answered. Reporting `gap: true` for a question
        // nobody asked is the specific failure above: a confident wrong answer, not a missing one.
        if (!q) {
          return { ok: false, requires_approval: approval, error: "capability_research needs a non-empty `need` (the capability to search for)" };
        }
        const toolMatches = MCP_TOOLS.filter((t) => t.slug.toLowerCase().includes(q)).map((t) => t.slug);
        const typeMatches = deps.registry.listTypes().filter((t) => t.slug.toLowerCase().includes(q)).map((t) => t.slug);
        const existing_matches = [...toolMatches, ...typeMatches];
        const gap = existing_matches.length === 0;
        return {
          ok: true, requires_approval: approval,
          data: { need: q, query: q, existing_matches, gap, approaches: [], mcp_options: toolMatches, recommendation: gap ? "no existing capability — propose a new tool/type" : "reuse existing" },
        };
      }
      case "gig_abort": {
        const gid = String(args["gig_id"] ?? "");
        const reason = String(args["reason"] ?? "");
        // #249/#251 — the LIVE run map is the authority, consulted first. The old handler read
        // only the ledger + output store, which got the answer wrong in both directions: a gig
        // in its FIRST phase has sealed nothing, so it reported `not_found` for precisely the
        // window abort exists to serve; and post-restart every historical gig reported
        // `running`/`aborted:true` forever. gig_monitor already read this map, so the two tools
        // disagreed about the same gig_id in the same millisecond.
        const live = gid.length > 0 ? deps.gig_runs?.get(gid) : undefined;
        let status: string;
        let aborted = false;
        if (live) {
          if (live.status === "running") {
            live.abort_requested = true;
            live.abort_reason = reason || "aborted by operator";
            // THE actual cancellation. runGig stops at its next checkpoint (between phases /
            // between dispatch batches) and the invoker kills the chair's in-flight child.
            const controller = live.controller;
            if (controller) {
              try { controller.abort(live.abort_reason); } catch { /* an already-aborted signal is fine */ }
              aborted = true;
            }
            // A run registered without a controller (dispatched by an older code path) can be
            // MARKED but not stopped — say so rather than claiming a cancellation.
            status = aborted ? "aborting" : "running";
          } else {
            status = live.status === "aborted" ? "already_aborted"
              : live.status === "failed" ? "already_failed"
                : "already_complete";
          }
        } else {
          // No live run in THIS process. The stores can testify that a gig existed; they cannot
          // make it cancellable — so `aborted` stays false. An empty gig_id must not be probed:
          // query({gig_id: ""}) drops the filter entirely and would match every row, reporting a
          // phantom "already_complete".
          const completed = gid.length > 0 && deps.ledger.query({ gig_id: gid }).length > 0;
          const hasOutputs = gid.length > 0 && deps.outputs.all().some((o) => o.gig_id === gid);
          status = completed ? "already_complete" : hasOutputs ? "running" : "not_found";
        }
        // Record only a real abort. v1 appended REGARDLESS — including on not_found — so an
        // immutable row claimed a cancellation for a gig that never existed. `subject_gig_id`
        // is first-class so the abort surfaces in the aborted gig's own history; the v1
        // `abort:<gid>` namespace hid it from the only query that would look (#213).
        if (status !== "not_found") {
          deps.ledger.append(governanceRow("gig_abort", gid, { reason, status, cancelled: aborted }, gid));
        }
        return {
          ok: true, requires_approval: approval,
          data: { status, aborted, cancellable: aborted, cleanup_result: { reason } },
        };
      }
      case "gig_cancel": {
        // gig_cancel stops a QUEUED gig — one in the org gig table that no drain worker has
        // claimed yet — so no worker ever claims it. That queue is a HOSTED concept: the store's
        // gig table. A LOCAL surface has no queue (a local gig_dispatch runs immediately, tracked
        // in gig_runs), so there is nothing here to cancel. The hosted seam (deps.cancelGig) is
        // intercepted in callSurfaceTool before this handler is reached; reaching this switch is a
        // NON-hosted call. Two honest answers:
        //   * a live RUNNING gig is the wrong door — cancel is pre-claim; a running gig is stopped
        //     by gig_abort. Fail closed and say so.
        //   * otherwise there is no local queue to cancel from — a typed hosted-only explanation.
        const gid = String(args["gig_id"] ?? "");
        const live = gid.length > 0 ? deps.gig_runs?.get(gid) : undefined;
        if (live && live.status === "running") {
          return {
            ok: false, requires_approval: approval,
            error:
              `gig "${gid}" is already running — gig_cancel only stops a QUEUED gig before a worker ` +
              "claims it. Use gig_abort to stop a running gig.",
          };
        }
        return {
          ok: false, requires_approval: approval,
          error:
            "gig_cancel stops a QUEUED gig in the org gig table before a drain worker claims it. " +
            "A local surface has no queue — cancel over the hosted store (coltrane_gig_cancel for a " +
            "member, coltrane_mcp_gig_cancel for an agent token).",
        };
      }
      case "gig_approve": {
        // Approval is a MEMBER act whose authority lives in the STORE (the coltrane_gig_approve RPC
        // is member-JWT-only; an agent token is refused there — the enforcement belongs store-side,
        // not here). The HOSTED surface routes this to deps.approveGig (see callSurfaceTool);
        // reaching this switch is a NON-hosted call, which has no store-backed run to approve — a
        // local run takes its human verdicts through gig_dispatch's `approvals` argument instead.
        const gigId = String(args["gig_id"] ?? "");
        const role = String(args["role"] ?? "");
        const verdict = args["verdict"];
        if (!gigId || !role || verdict === undefined) {
          return { ok: false, requires_approval: approval, error: "gig_approve requires gig_id, role, and verdict (the Judgment the human seat seals)" };
        }
        return {
          ok: false, not_implemented: true, requires_approval: approval,
          error:
            `gig_approve is the hosted member seam — approve gig "${gigId}" role "${role}" over a store-backed ` +
            "surface (wire deps.approveGig). A local run takes its human verdicts through gig_dispatch's `approvals` argument.",
        };
      }
      case "agent_define": {
        // Build the def by the SCHEMA's own field list (genome_schema.ts AgentSchema): copy exactly
        // the fields the schema declares from args. This handler was one of the restatements that
        // DRIFTED — it read a RETIRED nested `permissions` object for the tuning fields (the generated
        // surface advertises them flat) and never read `browser_grant` at all, silently dropping the
        // cage grant on every MCP-authored agent. Iterating the schema keys keeps the write-path from
        // re-drifting (add a field to AgentSchema and it's copied automatically; none is invented). We
        // deliberately do NOT parse here: defineAgent (inside sealAgentDefinition) runs the structural
        // + composition checks and surfaces their precise typed errors — pre-parsing would mask a
        // composition error (e.g. CREATE with no upstream reasoning) behind a generic schema error.
        const built: Record<string, unknown> = {};
        for (const key of Object.keys(AgentSchema.shape)) {
          if (args[key] !== undefined) built[key] = args[key];
        }
        const def = built as unknown as AgentDef;
        // Governance gate: each allowed_tools slug must be registered. tool_propose
        // alone does NOT register; tool_register lands the slug. Unknown slugs are
        // rejected so the cage cannot grant scope to a tool the registry doesn't know.
        if (def.allowed_tools && def.allowed_tools.length > 0) {
          const unknown = def.allowed_tools.filter((s) => !REGISTERED_TOOL_SLUGS.has(s));
          if (unknown.length > 0) {
            return {
              ok: false,
              requires_approval: approval,
              error: `agent_define: unknown/unregistered allowed_tools slug${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — call tool_propose then tool_register first`,
            };
          }
        }
        // The substrate loop: validate → canonical hash → (if genome_dir) persist + ledger-seal.
        const sealed = sealAgentDefinition(def, deps.ledger, deps.genome_dir);
        // Write-through to the LIVE map so a same-session standard_compose resolves this agent
        // WITHOUT a genome_reload. agent_define wrote agents/<slug>.json but never refreshed
        // deps.agents, so standard_compose (which resolves slugs from deps.agents) denied an agent
        // this very tool had just created. This mirrors the write-through standard_compose does for
        // deps.standards and tool_register does for deps.toolProviders.
        deps.agents?.set(sealed.agent.slug, sealed.agent);
        return {
          ok: true,
          requires_approval: approval,
          data: {
            agent: sealed.agent,
            agent_profile_id: sealed.agent.slug,
            content_hash: sealed.content_hash,
            dependency_hash: sealed.dependency_hash,
            effective_hash: sealed.effective_hash,
            validation_result: { valid: true },
          },
        };
      }
      case "tool_register": {
        // Close the propose→register loop. Adds the slug to REGISTERED_TOOL_SLUGS
        // so subsequent agent_define calls can grant scope to it. The propose step
        // creates the proposal_id; this step lands the slug in the live registry.
        const targetSlug = String(args["slug"] ?? "");
        if (!targetSlug) {
          return { ok: false, requires_approval: approval, error: "tool_register requires slug" };
        }
        // #218 — SEAL BEFORE GRANTING. REGISTERED_TOOL_SLUGS is the capability gate that
        // decides whether agent_define may grant this slug. v1 mutated it (and toolProviders)
        // and only then appended, so a failed append left the tool registered and grantable,
        // the caller told the call failed, and no audit row at all — the audit trail could not
        // answer "who granted this capability, and when".
        const registration_id = randomUUID();
        // #234 — `type`, `spec` and `category` were advertised and discarded. This row IS the
        // audit answer to "who granted this capability, and what did they grant?"; without the
        // spec it could only answer the first half.
        deps.ledger.append(governanceRow("tool_register", targetSlug, {
          registration_id,
          tool_type: args["type"] ?? null,
          spec: args["spec"] ?? null,
          category: args["category"] ?? null,
        }));
        REGISTERED_TOOL_SLUGS.add(targetSlug);
        // Keep the #185 provider bridge live: a freshly-registered tool must resolve for a same-
        // session agent_define→dispatch (the registry and provider map share lifecycle).
        deps.toolProviders?.set(targetSlug, { tool: targetSlug, kind: "in_house" });
        return {
          ok: true,
          requires_approval: approval,
          data: { registered: true, slug: targetSlug, registration_id },
        };
      }
      case "agent_evolve": {
        // Real change-space classification: a permissions change needs approval,
        // a harmonic (type-graph) or creative (identity/method) change does not.
        const base = args["base"] as AgentProfile | undefined;
        const next = args["next"] as AgentProfile | undefined;
        const new_version = Number(args["new_version"] ?? ((base?.version ?? 0) + 1));
        if (base && next) {
          const change = proposeAgentChange(base, next);
          // For a creative-space change, return the lineage-threaded evolved profile
          // (version+1, parent_version=base.version) so the immutable chain reconstructs.
          const evolved = change.space === "creative"
            ? evolveProfile(base, { identity: next.identity, method: next.method, constraints: next.constraints })
            : null;
          // substrate seal: the evolved version's identity (lineage claim) is recorded in
          // the ledger when persisting — never a contract lie, even before file materialization.
          const evolveDetail = {
            ...(args["reason"] != null ? { reason: args["reason"] } : {}),
            ...(args["evidence"] != null ? { evidence: args["evidence"] } : {}),
          };
          const ev = (evolved && deps.genome_dir) ? recordIdentity("agent_evolve", `${base.slug}@v${new_version}`, evolved, deps.ledger, evolveDetail) : undefined;
          return {
            ok: true, requires_approval: change.approval_required,
            data: { space: change.space, approval_required: change.approval_required, type_check_passed: change.type_check_passed ?? null, new_version, evolved_profile: evolved, parent_version: evolved?.parent_version ?? base.version, effective_hash: ev?.effective_hash, content_hash: ev?.content_hash, cascade_check: { agents_affected: [], standards_affected: [] } },
          };
        }
        // (slug, changes) shape: apply a field-diff to a named genome agent, then
        // CASCADE — type-check every standard the agent is bound into and fail
        // CLOSED if any breaks, so a bad evolve can't corrupt a live pipeline.
        const evolveSlug = typeof args["slug"] === "string" ? (args["slug"] as string) : undefined;
        const changes = (args["changes"] && typeof args["changes"] === "object")
          ? (args["changes"] as Partial<AgentDef>) : undefined;
        if (evolveSlug && changes && (deps.genome_dir || deps.agents?.has(evolveSlug))) {
          // The base definition: the genome file when a working tree exists, else the loaded
          // agents map (a hosted surface has no filesystem — the STORE genome is the base,
          // and the seam above persists the merged definition back through the store).
          let currentDef: AgentDef;
          if (deps.genome_dir && existsSync(join(deps.genome_dir, "agents", `${evolveSlug}.json`))) {
            currentDef = JSON.parse(readFileSync(join(deps.genome_dir, "agents", `${evolveSlug}.json`), "utf-8")) as AgentDef;
          } else if (deps.agents?.has(evolveSlug)) {
            currentDef = deps.agents.get(evolveSlug) as unknown as AgentDef;
          } else {
            return { ok: false, requires_approval: approval, error: `agent_evolve: unknown agent "${evolveSlug}" (no agents/${evolveSlug}.json)` };
          }
          const nextDef = { ...currentDef, ...changes };

          // The agent must still be a legal composition on its own…
          try {
            defineAgent(nextDef);
          } catch (e) {
            if (e instanceof CompositionError) {
              return { ok: false, requires_approval: approval, error: `agent_evolve rejected: ${e.message}`, data: { cascade_check: { agents_affected: [], standards_affected: [] } } };
            }
            throw e;
          }

          // …and every standard it's bound into must still type-check.
          const standards_affected: Array<{ slug: string; type_check_passed: boolean; errors: string[] }> = [];
          for (const std of deps.standards?.values() ?? []) {
            if (!std.agents.some((a) => a.slug === evolveSlug)) continue;
            const rebound = std.agents.map((a) => (a.slug === evolveSlug ? ({ ...a, ...changes } as Agent) : a));
            // Carry the SAME passthrough fields the compose/file path carries — above all input_types,
            // the gig contract an entry chair reads its input_contract from. Threading only eval_slugs
            // dropped input_types, so the re-compose saw no gig inputs and wrongly rejected a valid
            // entry chair as "input not produced by any upstream chair" (#204), failing the cascade.
            const stdRec = std as unknown as Record<string, unknown>;
            const stdExtras: Record<string, unknown> = {};
            for (const k of STD_PASSTHROUGH) if (stdRec[k] !== undefined) stdExtras[k] = stdRec[k];
            try {
              composeStandard({ slug: std.slug, domain: std.domain, agents: rebound, phases: std.phases, ...stdExtras });
              standards_affected.push({ slug: std.slug, type_check_passed: true, errors: [] });
            } catch (e) {
              if (e instanceof CompositionError) standards_affected.push({ slug: std.slug, type_check_passed: false, errors: [e.message] });
              else throw e;
            }
          }

          // Fail closed: if any binding standard broke, persist NOTHING.
          const broken = standards_affected.filter((s) => !s.type_check_passed);
          if (broken.length > 0) {
            return {
              ok: false, requires_approval: approval,
              error: `agent_evolve rejected: ${broken.length} standard(s) fail type-check after the change: ${broken.map((b) => b.slug).join(", ")}`,
              data: { new_version, cascade_check: { agents_affected: [], standards_affected } },
            };
          }

          // Persist the evolved agent + ledger-seal, then re-bind the live
          // standards so genome_hash reflects the change on the next gig.
          const sealed = sealAgentDefinition(nextDef, deps.ledger, deps.genome_dir);
          for (const std of deps.standards?.values() ?? []) {
            const agentsArr = std.agents as Agent[];
            for (let i = 0; i < agentsArr.length; i++) {
              if (agentsArr[i]!.slug === evolveSlug) agentsArr[i] = sealed.agent;
            }
          }
          // next_def is the seam's persistence source on a hosted surface (the store
          // upsert writes the MERGED definition, not the raw evolve args).
          deps.agents?.set(evolveSlug, sealed.agent);
          return {
            ok: true, requires_approval: approval,
            data: { new_version, evolved: sealed.agent, next_def: nextDef, content_hash: sealed.content_hash, effective_hash: sealed.effective_hash, cascade_check: { agents_affected: [], standards_affected } },
          };
        }
        return { ok: true, requires_approval: approval, data: { new_version, cascade_check: { agents_affected: [], standards_affected: [] } } };
      }
      case "access_grant_check": {
        // Real validation: TTL (is the grant live?) + optional plan-scope check
        // (does the proposed file set fit the grant's paths/limits?).
        const grant = args["grant"] as AccessGrant | undefined;
        if (grant) {
          const nowMs = typeof args["now_ms"] === "number" ? (args["now_ms"] as number) : Date.now();
          const ttl = checkGrantTTL(grant, nowMs);
          const plan = args["plan"] as PlanCheck | undefined;
          const planResult = plan ? validatePlanAgainstGrant(plan, grant) : { valid: true };
          const valid = ttl.valid && planResult.valid;
          return {
            ok: true, requires_approval: approval,
            data: { valid, granted: valid, ttl, plan_check: plan ? planResult : null, expires_in: ttl.remaining_ms ?? null, reason: ttl.reason ?? planResult.reason ?? null },
          };
        }
        const required = arr(args["required_permissions"]);
        return {
          ok: true, requires_approval: approval,
          data: { valid: required.length === 0, granted: required.length === 0, missing_permissions: required, expires_in: null },
        };
      }
      case "skill_define": {
        // The missing skill authoring tool. Persist (non-destructively) + ledger-seal
        // via the blessed write path, then write through to the LIVE skills map so a
        // gig in the same session resolves it into an agent's Skills layer.
        const skSlug = typeof args["slug"] === "string" ? (args["slug"] as string).trim() : "";
        if (!skSlug) return { ok: false, requires_approval: approval, error: "skill_define requires a non-empty slug" };
        // Validate against the single Zod source — skill_define is package-aware (meta + permission/
        // network + fixtures + code/md), not the retired flat {slug, domain, md}. Unknown keys are
        // dropped; a malformed declared field is rejected before the write/seal.
        const skParsed = SkillSchema.safeParse({ ...args, slug: skSlug });
        if (!skParsed.success) {
          const why = skParsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
          return { ok: false, requires_approval: approval, error: `skill_define: ${why}` };
        }
        const def: SkillRecord = skParsed.data;
        // Persist the LOADABLE PACKAGE (skills/<slug>/…), not a flat skills/<slug>.json the loader
        // skips — otherwise a defined skill seals fine but vanishes on reload (audit finding E). The
        // loader hard-fails an incomplete package, so require what it requires up front: ≥1 fixture
        // (the skill's pre-registered contract) + a code and/or reasoning half. Refuse here rather
        // than write a package that would crash the next genome load.
        if (!Array.isArray(def.fixtures) || def.fixtures.length === 0) {
          return { ok: false, requires_approval: approval, error: "skill_define requires ≥1 fixture — a skill ships its pre-registered contract (the loader rejects a fixtureless package)" };
        }
        if (typeof def.code !== "string" && typeof def.md !== "string") {
          return { ok: false, requires_approval: approval, error: "skill_define requires a code half (code) and/or a reasoning half (md) — an empty package can't load" };
        }
        const sealed = sealSkillPackage(def, deps.ledger, deps.genome_dir);
        deps.skills?.set(skSlug, def);
        return { ok: true, requires_approval: approval, data: { skill_id: skSlug, content_hash: sealed.content_hash, dependency_hash: sealed.dependency_hash, effective_hash: sealed.effective_hash } };
      }
      // ── the skill iteration loop ─────────────────────────────────────────────────────
      // Until now the surface was define + promote: a skill could be created and given
      // production status, and never RUN, TESTED, LISTED or REVISED through the engine. The
      // fixture gate on promotion made that gap sharper — you could be refused for failing
      // fixtures with no way to run them and see why.
      // ── the org context switch — set once, inherited by every member write ─────────────
      case "org_use": {
        const orgSlug = String(args["org_slug"] ?? "");
        if (!orgSlug) return { ok: false, requires_approval: approval, error: "org_use requires org_slug" };
        if (!deps.orgUse) {
          return {
            ok: false, requires_approval: approval,
            error: "org context is a store concept — a file genome has one implicit org (this working tree). On a hosted surface the host wires deps.orgUse to the store's coltrane_org_use RPC.",
          };
        }
        try {
          const set = await deps.orgUse(orgSlug);
          return { ok: true, requires_approval: approval, data: { org_slug: set, set: true } };
        } catch (e) {
          return { ok: false, requires_approval: approval, error: e instanceof Error ? e.message : String(e) };
        }
      }

      // ── discoverability parity — a dispatcher must be able to FIND a slug over MCP ──────
      // (tests/genome_browse_parity.test.ts). Backed by the deps maps, so the same handler
      // serves a working-tree load and a hosted store load identically; no filesystem.
      case "standard_browse": {
        if (!deps.standards) return { ok: false, not_implemented: true, requires_approval: approval, error: "standard_browse needs a standards map (bootstrap from a genome)" };
        let list = [...deps.standards.values()];
        if (args["domain"]) list = list.filter((s) => s.domain === args["domain"]);
        if (args["status"]) list = list.filter((s) => (s.status ?? "active") === args["status"]);
        const standards = list
          .map((s) => ({
            slug: s.slug, domain: s.domain, status: s.status ?? "active",
            phases: s.phases.map((p) => p.name), phase_count: s.phases.length,
            chair_count: s.phases.reduce((n, p) => n + p.chairs.length, 0),
            input_types: s.input_types ?? [], output_types: s.output_types ?? [],
            eval_slugs: s.eval_slugs ?? [], description: s.description ?? null,
          }))
          .sort((a, b) => (a.slug < b.slug ? -1 : 1));
        return { ok: true, requires_approval: approval, data: { standards, count: standards.length } };
      }

      case "standard_inspect": {
        // The single-record read, mirroring skill_inspect: browse lists shallow rows; this returns
        // ONE standard's full shape. Same failure postures as the browse handlers — no standards
        // map is "needs a standards map", an unknown slug is an honest error, never a silent null.
        if (!deps.standards) return { ok: false, not_implemented: true, requires_approval: approval, error: "standard_inspect needs a standards map (bootstrap from a genome)" };
        const target = String(args["slug"] ?? "");
        if (!target) return { ok: false, requires_approval: approval, error: "standard_inspect requires slug" };
        const std = deps.standards.get(target);
        if (!std) return { ok: false, requires_approval: approval, error: `unknown standard "${target}"` };
        return {
          ok: true, requires_approval: approval,
          data: {
            slug: std.slug, domain: std.domain, status: std.status ?? "active",
            phases: std.phases.map((p) => ({
              name: p.name,
              chairs: p.chairs.map((c) => ({
                role: c.role,
                agent_slug: c.agent_slug ?? null,
                skill_slug: c.skill_slug ?? null,
                human: c.human ?? false,
                input_contract: c.input_contract ?? [],
                output_contract: c.output_contract ?? [],
              })),
            })),
            input_types: std.input_types ?? [], output_types: std.output_types ?? [],
            eval_slugs: std.eval_slugs ?? [], description: std.description ?? null,
          },
        };
      }

      case "chart_browse": {
        if (!deps.charts) return { ok: false, not_implemented: true, requires_approval: approval, error: "chart_browse needs a charts map (bootstrap from a genome)" };
        let clist = [...deps.charts.values()];
        if (args["venue"]) clist = clist.filter((c) => c.venue === args["venue"]);
        if (args["standard_slug"]) clist = clist.filter((c) => c.movements.some((m) => m.standard_slug === args["standard_slug"]));
        const charts = clist
          .map((c) => {
            // The arrangement's identity, when it is computable. chartHash folds each movement's
            // standard PROJECTION, so a chart naming a standard this server does not hold has no
            // hash to report — and reporting null is the honest answer, not a fabricated prefix.
            const resolvedMovements: ResolvedMovement[] = [];
            for (const m of c.movements) {
              const s = deps.standards?.get(m.standard_slug);
              if (s) resolvedMovements.push({ movement_id: m.movement_id, standard: s, runtime_fills: m.runtime_fills, seatings: m.seatings });
            }
            const complete = resolvedMovements.length === c.movements.length;
            return {
              slug: c.slug,
              standard_slugs: c.movements.map((m) => m.standard_slug),
              movement_ids: c.movements.map((m) => m.movement_id),
              movement_count: c.movements.length,
              edge_count: c.edges.length,
              gate_count: c.approval_gates.length,
              venue: c.venue ?? null,
              budget_usd: c.budget_envelope?.total_usd ?? null,
              // A PREFIX: enough to tell two arrangements apart in a listing, not the identity
              // itself (which a caller reads off the define call or the ledger).
              chart_hash: complete ? chartHash({ movements: resolvedMovements, chart: c }).slice(0, 12) : null,
            };
          })
          .sort((a, b) => (a.slug < b.slug ? -1 : 1));
        return { ok: true, requires_approval: approval, data: { charts, count: charts.length } };
      }

      case "venue_browse": {
        if (!deps.venues) return { ok: false, not_implemented: true, requires_approval: approval, error: "venue_browse needs a venues map (bootstrap from a genome)" };
        let vlist = [...deps.venues.values()];
        if (args["institution_slug"]) vlist = vlist.filter((v) => v.institution_slug === args["institution_slug"]);
        if (args["flavor"]) vlist = vlist.filter((v) => v.flavor === args["flavor"]);
        const venues = vlist
          .map((v) => ({
            slug: v.slug, institution_slug: v.institution_slug, flavor: v.flavor ?? null,
            // COUNTS, not contents: the numbers are what a seating decision turns on ("does this
            // room hold anything at all", "can anything leave"), and the full lists are one
            // venue_define / file read away.
            tool_count: v.equipment.tools.length,
            tools: v.equipment.tools,
            ingress_count: v.doors?.ingress.length ?? 0,
            egress_count: v.doors?.egress.length ?? 0,
            install_count: v.installs.length,
            credential_surface: v.credential_surface,
            lifecycle: v.lifecycle.policy,
            rebuild_cadence: v.lifecycle.rebuild_cadence ?? null,
            responsible_chair: v.responsible_chair ?? null,
            description: v.description ?? null,
          }))
          .sort((a, b) => (a.slug < b.slug ? -1 : 1));
        return { ok: true, requires_approval: approval, data: { venues, count: venues.length } };
      }

      case "agent_browse": {
        if (!deps.agents) return { ok: false, not_implemented: true, requires_approval: approval, error: "agent_browse needs an agents map (bootstrap from a genome)" };
        let list = [...deps.agents.values()];
        if (args["domain"]) list = list.filter((a) => a.domain === args["domain"]);
        if (args["primitive"]) list = list.filter((a) => a.primitives.includes(args["primitive"] as Primitive));
        const agents = list
          .map((a) => ({
            slug: a.slug, primitives: a.primitives, domain: a.domain,
            input_types: a.input_types, output_types: a.output_types,
            behavioral_primitives: a.behavioral_primitives,
            skill_slugs: a.skill_slugs ?? [], model_tier: a.model_tier ?? null,
          }))
          .sort((x, y) => (x.slug < y.slug ? -1 : 1));
        return { ok: true, requires_approval: approval, data: { agents, count: agents.length } };
      }

      case "skill_browse": {
        if (!deps.skills) return { ok: false, not_implemented: true, requires_approval: approval, error: "skill_browse needs a skills map (bootstrap from a genome)" };
        let list = [...deps.skills.values()] as Array<Record<string, unknown>>;
        if (args["domain"]) list = list.filter((k) => k["domain"] === args["domain"]);
        if (args["status"]) list = list.filter((k) => (k["status"] ?? "draft") === args["status"]);
        if (args["skill_type"]) list = list.filter((k) => k["skill_type"] === args["skill_type"]);
        // `has_code` is the axis that matters for the promotion gate: only a code half can be
        // held to fixtures, so it is the filter an operator actually reaches for.
        if (args["has_code"] !== undefined) {
          const want = args["has_code"] === true || args["has_code"] === "true";
          list = list.filter((k) => (k["code_hash"] != null) === want);
        }
        const skills = list
          .map((k) => ({
            slug: k["slug"], version: k["version"], domain: k["domain"], status: k["status"] ?? null,
            skill_type: k["skill_type"], input_type: k["input_type"], output_type: k["output_type"],
            has_code: k["code_hash"] != null, code_hash: k["code_hash"] ?? null,
            tier: (k["permission"] as { tier?: number } | undefined)?.tier ?? 0,
          }))
          .sort((a, b) => (String(a.slug) < String(b.slug) ? -1 : 1));
        return { ok: true, requires_approval: approval, data: { skills, count: skills.length } };
      }

      case "skill_inspect": {
        if (!deps.skills) return { ok: false, not_implemented: true, requires_approval: approval, error: "skill_inspect needs a skills map (bootstrap from a genome)" };
        const target = String(args["slug"] ?? "");
        if (!target) return { ok: false, requires_approval: approval, error: "skill_inspect requires slug" };
        const sk = deps.skills.get(target) as Record<string, unknown> | undefined;
        if (!sk) return { ok: false, requires_approval: approval, error: `unknown skill "${target}"` };
        const dir = sk["package_dir"] as string | undefined;
        // Fixtures are the skill's contract with the promotion gate, so they are what an
        // operator most needs to see. Inputs only — an expected_output is an answer key.
        const fixtures = dir ? loadFixtures(dir).map((f) => ({ id: f.id, input: f.input, has_expected: f.expected_output !== undefined, assertions: (f.assertions ?? []).length })) : [];
        return {
          ok: true, requires_approval: approval,
          data: {
            slug: sk["slug"], version: sk["version"], domain: sk["domain"], status: sk["status"] ?? null,
            skill_type: sk["skill_type"], input_type: sk["input_type"], output_type: sk["output_type"],
            description: sk["description"] ?? null,
            permission: sk["permission"] ?? { tier: 0 },
            has_code: sk["code_hash"] != null, code_hash: sk["code_hash"] ?? null,
            has_md: sk["md"] !== undefined,
            fixture_count: fixtures.length, fixtures,
            package_dir: dir ?? null,
            // Said plainly, because it is the difference between "will promote" and "cannot".
            promotable: sk["code_hash"] == null ? true : fixtures.length > 0,
          },
        };
      }

      case "skill_execute": {
        if (!deps.skills) return { ok: false, not_implemented: true, requires_approval: approval, error: "skill_execute needs a skills map (bootstrap from a genome)" };
        const target = String(args["slug"] ?? "");
        if (!target) return { ok: false, requires_approval: approval, error: "skill_execute requires slug" };
        const sk = deps.skills.get(target) as Record<string, unknown> | undefined;
        if (!sk) return { ok: false, requires_approval: approval, error: `unknown skill "${target}"` };
        const dir = sk["package_dir"] as string | undefined;
        if (!dir || sk["code_hash"] == null) {
          return { ok: false, requires_approval: approval, error: `skill "${target}" has no code half — there is nothing to execute (it is a reasoning skill)` };
        }
        // mode:"test" runs the skill's own fixtures instead of a caller's input. This is the
        // command that makes the promotion gate actionable: refused for failing fixtures, run
        // this, see which and why.
        if (args["mode"] === "test") {
          const report = runSkillFixtures(dir);
          const threshold = report.deterministic ? 1.0 : 0.8;
          return {
            ok: true, requires_approval: approval,
            data: { ...report, threshold, would_promote: report.total > 0 && report.pass_rate >= threshold },
          };
        }
        const started = Date.now();
        const res = executeSkill(dir, args["input"] ?? {}, typeof args["timeout_ms"] === "number" ? (args["timeout_ms"] as number) : undefined);
        // A skill that threw is not a tool that failed: the CALL succeeded and its answer is
        // "the code errored". Collapsing those loses the distinction a caller needs.
        return {
          ok: true, requires_approval: approval,
          data: { slug: target, ...res, duration_ms: res.duration_ms ?? Date.now() - started },
        };
      }

      case "skill_evolve": {
        if (!deps.skills) return { ok: false, not_implemented: true, requires_approval: approval, error: "skill_evolve needs a skills map (bootstrap from a genome)" };
        const target = String(args["slug"] ?? "");
        const code = args["code"];
        if (!target || typeof code !== "string" || code.trim() === "") {
          return { ok: false, requires_approval: approval, error: "skill_evolve requires slug and a non-empty code half" };
        }
        const sk = deps.skills.get(target) as Record<string, unknown> | undefined;
        if (!sk) return { ok: false, requires_approval: approval, error: `unknown skill "${target}"` };
        const dir = sk["package_dir"] as string | undefined;
        if (!dir || sk["code_hash"] == null) {
          return { ok: false, requires_approval: approval, error: `skill "${target}" has no code half to evolve` };
        }
        if (loadFixtures(dir).length === 0) {
          return { ok: false, requires_approval: approval, error: `skill "${target}" has no fixtures, so there is nothing to hold a candidate to — add fixtures before evolving it` };
        }
        // The candidate runs against the CURRENT fixtures in a throwaway copy. Nothing is
        // written unless it passes, which is the whole point: a skill cannot regress through
        // this door. `evolveSkill` has implemented exactly this since before the open-source
        // split and had no caller.
        const tmpCode = join(mkdtempSync(join(tmpdir(), "coltrane-candidate-")), "skill.mjs");
        let verdict: { accepted: boolean; failing_fixtures: string[] };
        try {
          writeFileSync(tmpCode, code, "utf8");
          verdict = evolveSkill(dir, tmpCode);
        } catch (e) {
          return { ok: false, requires_approval: approval, error: `could not evaluate the candidate: ${e instanceof Error ? e.message : String(e)}` };
        } finally {
          try { rmSync(dirname(tmpCode), { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        if (!verdict.accepted) {
          return {
            ok: false, requires_approval: approval,
            error: `candidate for "${target}" is REJECTED — it fails fixture(s) the current code passes: ${verdict.failing_fixtures.join(", ")}`,
            data: { accepted: false, failing_fixtures: verdict.failing_fixtures },
          };
        }
        // Accepted: land the code and seal the new identity. Version bumps, because the bytes
        // that run changed — an evolved skill under an unchanged version is the edit-under-a-
        // stable-slug shape that `producers_sha` exists to catch.
        const nextVersion = Number(sk["version"] ?? 1) + 1;
        writeFileSync(join(dir, "skill.mjs"), code, "utf8");
        const sealed = recordIdentity("skill_evolve", `${target}@v${nextVersion}`, { slug: target, version: nextVersion, code }, deps.ledger,
          args["reason"] != null ? { reason: args["reason"] } : undefined);
        (sk as Record<string, unknown>)["version"] = nextVersion;
        return {
          ok: true, requires_approval: approval,
          data: {
            slug: target, accepted: true, new_version: nextVersion,
            content_hash: sealed.content_hash, effective_hash: sealed.effective_hash,
            note: "the code half changed; re-promote to carry the new version to active",
          },
        };
      }

      case "agent_promote":
      case "standard_promote":
      case "skill_promote": {
        // §7 lifecycle promotion. Forward-only state-machine transition is recorded
        // as an immutable ledger event (parity with OG's append-not-mutate evolution
        // discipline). Status enum per entity class:
        //   agent:    draft → review → approved → active → retired
        //   standard: draft → active → retired
        //   skill:    draft → testing → active → retired
        // Caller supplies (slug, status, [current]); when `current` is omitted the
        // call records the intent and skips the chain check (the writer is trusted
        // to know the prior state — same shape as OG handleAgentPromote).
        const order =
          slug === "agent_promote" ? AGENT_STATUS_ORDER :
          slug === "standard_promote" ? STANDARD_STATUS_ORDER :
          SKILL_STATUS_ORDER;
        const targetSlug = String(args["slug"] ?? "");
        const target = String(args["status"] ?? "");
        const current = args["current"] != null ? String(args["current"]) : null;
        // Carried into the ledger row: a promotion that passed a fixture gate should record the
        // evidence it passed on, or the audit trail says only that someone asked.
        let fixtureReport: ReturnType<typeof runSkillFixtures> | undefined;
        if (!targetSlug || !target) {
          return { ok: false, requires_approval: approval, error: "missing slug or status" };
        }
        try {
          if (current != null) checkPromotion(current, target, order);
          else if (order.indexOf(target) < 0) throw new PromotionError(`unknown target status "${target}"`);
        } catch (e) {
          if (e instanceof PromotionError) {
            return { ok: false, requires_approval: approval, error: e.message };
          }
          throw e;
        }
        // #254 — VALIDITY, not just transition legality. v1 checked only that the status move
        // was forward-legal and never looked at the definition at all: `targetSlug` was used
        // solely as a ledger subject, so a slug naming NOTHING promoted to `active` happily.
        //
        // Promotion is the transition that grants a definition production status. A definition
        // that could not be CREATED must not be able to become ACTIVE — otherwise the write-path
        // gate is a fiction, because anything already sitting at `draft` walks straight past it.
        // The check run here is deliberately the LOADER'S OWN check, not a parallel one: a
        // promote that validates differently from the loader is exactly the drift that produced
        // #254. (The loader's hard-fail stays too — hand-edited JSON is a deliberately open path
        // per CLAUDE.md, so the write path makes a malformed definition hard to create and the
        // load path makes it impossible to use.)
        //
        // An ABSENT genome map means the server was never bootstrapped from a genome, so absence
        // is not evidence that the slug names nothing — same discipline the runtime applies to an
        // absent skills map. bootstrapServerDeps always populates all three.
        const notFound = (kind: string): ToolResult => ({
          ok: false, requires_approval: approval,
          error: `${slug}: no ${kind} "${targetSlug}" in the genome — a promotion names a definition that must already exist (define it first, or fix the slug)`,
        });
        if (slug === "agent_promote" && deps.agents) {
          const ag = deps.agents.get(targetSlug);
          if (!ag) return notFound("agent");
          try {
            defineAgent(ag as unknown as AgentDef); // the loader's own gate
          } catch (e) {
            return {
              ok: false, requires_approval: approval,
              error: `${slug}: agent "${targetSlug}" does not pass validation and must not become "${target}" — ${e instanceof Error ? e.message : String(e)}`,
            };
          }
        } else if (slug === "standard_promote" && deps.standards) {
          if (!deps.standards.get(targetSlug)) return notFound("standard");
        } else if (slug === "skill_promote" && deps.skills) {
          const sk = deps.skills.get(targetSlug);
          if (!sk) return notFound("skill");
          const check = SkillSchema.safeParse(sk); // the loader's own gate
          if (!check.success) {
            const why = check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
            return {
              ok: false, requires_approval: approval,
              error: `${slug}: skill "${targetSlug}" does not pass validation and must not become "${target}" — ${why}`,
            };
          }
          // ── THE FIXTURE GATE ────────────────────────────────────────────────────────────
          // Promotion to `active` is the moment a definition acquires production status. For a
          // skill with a CODE half that has to mean its code demonstrably works, not that its
          // metadata parses — schema validity says nothing about behaviour.
          //
          // Restored from the pre-open-source engine, which enforced exactly this at
          // skill_evolve and skill_promote and refused the write on failure. The runner has been
          // here the whole time (`runSkillFixtures`) with no caller outside tests: a real gate
          // with nothing invoking it, the same shape as the capability gate this release closed.
          //
          // The threshold keys off MEASURED determinism, not the declared `determinism_ratio`:
          // a skill whose runs agree is held to every fixture passing; one that varies is held
          // to a supermajority. Claiming determinism therefore costs something, which is what
          // stops the claim being free.
          const gated = target === "active";
          const pkgDir = (sk as { package_dir?: string }).package_dir;
          const hasCode = (sk as { code_hash?: string | null }).code_hash != null;
          if (gated && hasCode && pkgDir) {
            let report: ReturnType<typeof runSkillFixtures>;
            try {
              report = runSkillFixtures(pkgDir);
            } catch (e) {
              return {
                ok: false, requires_approval: approval,
                error: `${slug}: could not run "${targetSlug}"'s fixtures, so it must not become "${target}" — ${e instanceof Error ? e.message : String(e)}`,
              };
            }
            // No fixtures is not a pass. A code skill nobody can test is precisely the thing
            // that must not carry production status, and silently allowing it would make this
            // gate opt-out by omission.
            if (report.total === 0) {
              return {
                ok: false, requires_approval: approval,
                error: `${slug}: skill "${targetSlug}" ships executable code and no fixtures, so nothing establishes that it works — add fixtures before promoting it to "${target}"`,
                data: { fixture_report: report },
              };
            }
            const threshold = report.deterministic ? 1.0 : 0.8;
            if (report.pass_rate < threshold) {
              const failing = report.results.filter((r) => !r.passed).map((r) => r.id);
              return {
                ok: false, requires_approval: approval,
                error: `${slug}: skill "${targetSlug}" passed ${report.passed}/${report.total} fixtures ` +
                  `(${(report.pass_rate * 100).toFixed(0)}%), below the ${(threshold * 100).toFixed(0)}% required of a ` +
                  `${report.deterministic ? "deterministic" : "non-deterministic"} skill — failing: ${failing.join(", ")}`,
                data: { fixture_report: report },
              };
            }
            fixtureReport = report;
          }
        }
        const promotion_id = randomUUID();
        // v1 recorded neither WHICH entity was promoted nor the transition — standard_slug held
        // the TOOL name. A lifecycle transition is exactly the event an audit trail exists for.
        deps.ledger.append(governanceRow(slug, targetSlug, {
          promotion_id, from_status: current, to_status: target,
          // The evidence the promotion rested on. A gate that passes and records nothing leaves
          // the audit trail saying only that someone asked, not what was true when they did.
          ...(fixtureReport
            ? { fixtures: { total: fixtureReport.total, passed: fixtureReport.passed, pass_rate: fixtureReport.pass_rate, deterministic: fixtureReport.deterministic } }
            : {}),
        }));
        return {
          ok: true, requires_approval: approval,
          data: {
            slug: targetSlug, status: target, promoted: true, promotion_id,
            ...(fixtureReport ? { fixture_report: fixtureReport } : {}),
          },
        };
      }
      case "session_review_write": {
        // §11 learning loop, half 1: record a quality review of a gig's output. The
        // review is an immutable ledger event; learning_synthesize aggregates many
        // reviews into evolution evidence.
        const gig_id = String(args["gig_id"] ?? "");
        const output_id = String(args["output_id"] ?? "");
        const agent_slug = String(args["agent_slug"] ?? "");
        const quality_scores = args["quality_scores"];
        if (!gig_id || !output_id || !agent_slug || quality_scores == null || typeof quality_scores !== "object") {
          return { ok: false, requires_approval: approval, error: "session_review_write requires gig_id, output_id, agent_slug, quality_scores" };
        }
        const review_id = randomUUID();
        // agent_slug / output_id / quality_scores were validated above and then thrown away,
        // because v1 LedgerEntry had nowhere to put them. That discard is the root cause of the
        // cross-agent evidence bug in learning_synthesize (#215).
        // #234 — `agent_version`, `domain` and `notes` were advertised and dropped on the
        // floor. `notes` is the reviewer's actual reasoning; discarding it while recording the
        // scores keeps the number and loses the why, which is the half a later evolution
        // decision needs. Recorded as null when absent rather than omitted, so a review with no
        // note is distinguishable from one written before the field was kept.
        deps.ledger.append(governanceRow("session_review_write", agent_slug, {
          review_id, output_id, quality_scores,
          agent_version: args["agent_version"] ?? null,
          domain: args["domain"] ?? null,
          notes: args["notes"] ?? null,
        }, gig_id));
        return { ok: true, requires_approval: approval, data: { review_id, recorded: true, agent_slug, gig_id } };
      }
      // ── improvement, as a measurement rather than a count ────────────────────────────
      // `learning_synthesize` answers "is there enough evidence to act?" — a count. It cannot
      // answer the question the whole typed-and-sealed design exists to make answerable: did
      // this producer get BETTER, and what did that cost?
      //
      // Every input was already sealed and nothing joined them. Outputs carry `agent_slug`,
      // `cost_usd` and `created_at`; reviews carry `quality_scores` against a specific
      // `output_id` and `agent_version`; `agent_evolve` rows carry the version boundaries. The
      // join is arithmetic over records this engine already writes — no new instrumentation,
      // which is precisely why a consumer cannot compute this for themselves from a bill.
      case "improvement_report": {
        const subject = String(args["agent_slug"] ?? "");
        if (!subject) return { ok: false, requires_approval: approval, error: "improvement_report requires agent_slug" };
        const win = parseWindow(args["window"], Date.now());
        if (win.error) return { ok: false, requires_approval: approval, error: win.error };

        const outs = deps.outputs.all().filter(
          (o) => o.agent_slug === subject && (!win.after || o.created_at >= win.after),
        );
        const reviews = deps.ledger.query({
          kind: "governance", event: "session_review_write", subject_slug: subject,
          ...(win.after ? { after: win.after } : {}),
        }) as unknown as Array<{ detail?: Record<string, unknown> }>;

        // A review names the output it judged, so quality attaches to a specific sealed record
        // rather than to a time bucket. That is what makes the cost and the score describe the
        // same unit of work.
        const scoreOf = (d: Record<string, unknown> | undefined): number | null => {
          const qs = d?.["quality_scores"];
          if (!qs || typeof qs !== "object") return null;
          const nums = Object.values(qs as Record<string, unknown>).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
          return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
        };
        const reviewByOutput = new Map<string, { score: number | null; version: number | null }>();
        for (const r of reviews) {
          const oid = String(r.detail?.["output_id"] ?? "");
          if (!oid) continue;
          const v = r.detail?.["agent_version"];
          reviewByOutput.set(oid, { score: scoreOf(r.detail), version: typeof v === "number" ? v : null });
        }

        // Bucket by producer VERSION where a review supplied one. Version is the axis that
        // matters: "did the edit help?" is a question about two definitions, not two dates.
        interface Bucket { version: number | null; outputs: number; reviewed: number; cost: number[]; scores: number[] }
        const buckets = new Map<string, Bucket>();
        const keyOf = (v: number | null): string => (v === null ? "unversioned" : String(v));
        for (const o of outs) {
          const rev = reviewByOutput.get(o.id);
          const k = keyOf(rev?.version ?? null);
          const b = buckets.get(k) ?? { version: rev?.version ?? null, outputs: 0, reviewed: 0, cost: [], scores: [] };
          b.outputs += 1;
          if (typeof o.cost_usd === "number" && Number.isFinite(o.cost_usd)) b.cost.push(o.cost_usd);
          if (rev && rev.score !== null) { b.reviewed += 1; b.scores.push(rev.score); }
          buckets.set(k, b);
        }
        const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
        const versions = [...buckets.values()]
          .sort((a, b) => (a.version ?? -1) - (b.version ?? -1))
          .map((b) => ({
            version: b.version,
            outputs: b.outputs,
            reviewed: b.reviewed,
            // NULL, not 0, when nothing was measured. A zero here would read as "free" and
            // "worthless" respectively, which is the exact class of fabricated number this
            // engine spent a release removing.
            mean_cost_usd: mean(b.cost),
            mean_quality: mean(b.scores),
            cost_basis: b.cost.length === b.outputs ? "complete"
              : b.cost.length === 0 ? "no output carried a cost"
              : `partial: ${b.cost.length} of ${b.outputs} outputs carried a cost`,
            quality_basis: b.reviewed === 0 ? "no output was reviewed"
              : `${b.reviewed} of ${b.outputs} outputs reviewed`,
          }));

        // The comparison, only where both ends are measured. A delta against an unmeasured
        // version would be a number with nothing behind it.
        const deltas: Array<Record<string, unknown>> = [];
        for (let i = 1; i < versions.length; i++) {
          const prev = versions[i - 1]!, cur = versions[i]!;
          if (prev.version === null || cur.version === null) continue;
          deltas.push({
            from_version: prev.version, to_version: cur.version,
            quality_delta: prev.mean_quality !== null && cur.mean_quality !== null ? cur.mean_quality - prev.mean_quality : null,
            cost_delta_usd: prev.mean_cost_usd !== null && cur.mean_cost_usd !== null ? cur.mean_cost_usd - prev.mean_cost_usd : null,
            // The sentence a person acts on. Only stated when BOTH ends are measured.
            verdict: prev.mean_quality !== null && cur.mean_quality !== null && prev.mean_cost_usd !== null && cur.mean_cost_usd !== null
              ? (cur.mean_quality >= prev.mean_quality && cur.mean_cost_usd <= prev.mean_cost_usd ? "better and cheaper"
                : cur.mean_quality > prev.mean_quality ? "better, and more expensive"
                : cur.mean_cost_usd < prev.mean_cost_usd ? "cheaper, and worse"
                : "worse and more expensive")
              : null,
          });
        }

        // The same arithmetic across MODEL TIER rather than producer version. This is the axis
        // the "spend expensive tokens once to find where the cheap ones hold" question turns on,
        // and it is only answerable because the seal now records which model produced an output.
        interface TierBucket { outputs: number; reviewed: number; cost: number[]; scores: number[] }
        const tierBuckets = new Map<string, TierBucket>();
        for (const o of outs) {
          const k = (o as { model_tier?: string }).model_tier ?? (o as { model?: string }).model ?? "unrecorded";
          const b = tierBuckets.get(k) ?? { outputs: 0, reviewed: 0, cost: [], scores: [] };
          b.outputs += 1;
          if (typeof o.cost_usd === "number" && Number.isFinite(o.cost_usd)) b.cost.push(o.cost_usd);
          const rev = reviewByOutput.get(o.id);
          if (rev && rev.score !== null) { b.reviewed += 1; b.scores.push(rev.score); }
          tierBuckets.set(k, b);
        }
        const tiers = [...tierBuckets.entries()].map(([tier, b]) => ({
          tier,
          outputs: b.outputs,
          reviewed: b.reviewed,
          mean_cost_usd: mean(b.cost),
          mean_quality: mean(b.scores),
        })).sort((a2, b2) => (a2.tier < b2.tier ? -1 : 1));

        const measurable = versions.filter((v) => v.version !== null && v.mean_quality !== null).length;
        return {
          ok: true, requires_approval: approval,
          data: {
            agent_slug: subject,
            ...(win.after ? { since: win.after } : {}),
            total_outputs: outs.length,
            versions, deltas, tiers,
            // Said plainly, because a report that cannot answer its own question should say so
            // rather than return empty arrays that read as "no change".
            comparable: measurable >= 2,
            basis: measurable >= 2
              ? `${measurable} versions carry both cost and quality`
              : "not comparable yet — a version-to-version delta needs reviews recorded against outputs from at least two versions (session_review_write with agent_version)",
          },
        };
      }

      case "learning_synthesize": {
        // §11 learning loop, half 2: aggregate session reviews into evolution evidence
        // for one agent. Returns evidence_sufficient=true only when review count meets
        // min_reviews (default 5, matching OG threshold). auto_propose creates a
        // proposal_create-shaped proposal_id (recorded against the same agent_slug).
        const agent_slug = String(args["agent_slug"] ?? "");
        if (!agent_slug) {
          return { ok: false, requires_approval: approval, error: "learning_synthesize requires agent_slug" };
        }
        const min_reviews = typeof args["min_reviews"] === "number" ? (args["min_reviews"] as number) : 5;
        const auto_propose = args["auto_propose"] === true;
        // Scoped to the named agent. v1 queried EVERY review row in the ledger and only
        // echoed agent_slug back, so five reviews of five different agents opened the
        // evolution gate for a sixth with none (#215). The typed discriminators replace a
        // load-bearing String.startsWith on a synthetic gig_id.
        // #234 — `since` was advertised and ignored, so "has this agent earned an evolution on
        // RECENT evidence?" was always answered over its entire history. That is the wrong
        // answer in the direction that matters: five poor reviews from a year ago kept counting
        // toward a gate that exists to act on how the agent behaves now.
        const sinceRaw = args["since"];
        let since: string | undefined;
        if (sinceRaw !== undefined && sinceRaw !== null && sinceRaw !== "") {
          const parsed = new Date(String(sinceRaw));
          if (Number.isNaN(parsed.getTime())) {
            return { ok: false, requires_approval: approval, error: `unparseable since "${String(sinceRaw)}" — use an ISO timestamp` };
          }
          since = parsed.toISOString();
        }
        const reviews = deps.ledger.query({
          kind: "governance", event: "session_review_write", subject_slug: agent_slug,
          ...(since ? { after: since } : {}),
        });
        const review_count = reviews.length;
        const evidence_sufficient = review_count >= min_reviews;
        let proposal_id: string | null = null;
        if (evidence_sufficient && auto_propose) {
          proposal_id = randomUUID();
          deps.ledger.append(governanceRow("learning_synthesize", agent_slug, {
            proposal_id, review_count, min_reviews,
          }));
        }
        return {
          ok: true, requires_approval: approval,
          data: {
            agent_slug, review_count, evidence_sufficient,
            summary: { min_reviews, threshold_met: evidence_sufficient },
            proposal_id,
          },
        };
      }
      case "venue_credential_mint": {
        // NOT the live path — minting is intercepted in callSurfaceTool (which holds the caller
        // identity and the deps.mintVenueCredential backend that dispatchTool never receives).
        // This block exists so the verb's advertised schema has a matching handler reading exactly
        // its two arguments, and so it must live INSIDE this case body, not before the label:
        // tests/advertised_args_are_read.test.ts slices each case's body from its own label to the
        // next one, so any argument-read text placed above this label would be attributed to the
        // PRECEDING case (learning_synthesize) — a control reported against a tool that never took
        // it. Reaching this block at runtime means the surface interception was bypassed — answer
        // honestly rather than pretend a mint happened.
        const org_slug = String(args["org_slug"] ?? "");
        const instance = String(args["instance"] ?? "");
        return {
          ok: false, refusal: "no_backend", requires_approval: approval,
          error:
            `venue_credential_mint is served by the tool surface (createToolSurface), which wires the ` +
            `caller and the deps.mintVenueCredential backend; the bare dispatcher cannot mint for ` +
            `org "${org_slug}" instance "${instance}". Call it through the surface.`,
        };
      }
      default:
        return { ok: false, not_implemented: true, requires_approval: approval, error: `"${slug}" has no v0 handler` };
    }
  } catch (e) {
    if (e instanceof LedgerError) {
      // #218 — the audit row did not land. Collapsing this into a generic {ok:false} told the
      // caller nothing happened, when in fact the side effect may have been applied. Callers
      // (and operators) need to distinguish a rejected request from an unrecorded one.
      return {
        ok: false,
        requires_approval: approval,
        audit_write_failed: true,
        error: `audit write failed — "${slug}" was NOT sealed: ${e.message}`,
      };
    }
    return { ok: false, requires_approval: approval, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── The exported tool surface (governor ruling: the hosted Coltrane MCP is the Coltrane
//    MCP) ─────────────────────────────────────────────────────────────────────────────────
//
// createToolSurface is a REORGANIZATION of what this file already had — the MCP_TOOLS
// declarations plus the dispatchTool routing — exported as one deps-injected, transport-
// agnostic registry, so a host (a Next.js route, the stdio entry below, a test harness)
// mounts the FULL engine surface per-request. In hosted mode (deps.hosted), tools whose
// semantics are inherently local-process (subprocess spawns, filesystem reads) still EXIST
// in the surface but return an honest typed error (`hosted_unsupported`) instead of
// spawning or reading a filesystem that isn't there.

export interface SurfaceToolResult extends ToolResult {
  /** Set when the tool exists but its semantics are local-process and deps.hosted is true. */
  hosted_unsupported?: boolean;
}

export interface ToolSurfaceDeps extends ServerDeps {
  /** True when this surface serves a hosted (per-request, store-backed, no-filesystem) host. */
  hosted?: boolean | undefined;
  /** Hosted gig queuing: queue a run (e.g. postgrestQueueGig(ctx) → the coltrane_gig_dispatch
   *  RPC). Without it, hosted gig_dispatch is an honest typed error — it NEVER spawns. */
  queueGig?: ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  /** Hosted member approval: approve a parked gig (e.g. postgrestApproveGig(ctx) → the
   *  coltrane_gig_approve RPC, which is member-JWT-only). Parallel to queueGig — the engine
   *  passes through, the store authorizes (an agent token is refused there). Without it, hosted
   *  gig_approve is an honest typed error. */
  approveGig?: ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  /** Hosted gig cancel: cancel a QUEUED gig before a drain worker claims it (e.g.
   *  postgrestCancelGig(ctx) → coltrane_gig_cancel for a member, or rpcCancelGig(ctx) →
   *  coltrane_mcp_gig_cancel for an agent token). Parallel to queueGig — the engine passes
   *  through, the store authorizes and refuses a claimed/running row. Without it, hosted
   *  gig_cancel is an honest typed error. */
  cancelGig?: ((args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined;
  /** Hosted genome persistence: a successful define/compose/register also upserts through
   *  this store (the governed RPC), or the definition evaporates at end-of-request. */
  store?: GenomeStore | undefined;
  /** Who is calling, as the transport authenticated them. The engine reads exactly ONE thing off
   *  this — whether the caller presented a gig-scoped credential — for the venue_credential_mint
   *  escalation refusal, which is a credential-SCOPE fact, not an authorization principal. Every
   *  other who-may-mint question belongs to the store. Absent on a bare surface (a test, a local
   *  process): no gig scope to refuse. */
  caller?: CallerIdentity | undefined;
  /** Deployment-wired venue credential minting: mint an org-scoped, instance-bound worker
   *  environment (the coltrane_venue_credential_mint backend a deployment stands up). Parallel to
   *  queueGig — the engine ships the verb, its schema, its shape validation and its refusals; the
   *  deployment ships the backend. Without it, venue_credential_mint is an honest typed refusal
   *  (`no_backend`) — the verb still answers, it never throws. */
  mintVenueCredential?: ((args: { org_slug: string; instance: string }) => Promise<VenueCredentialGrant>) | undefined;
}

export interface SurfaceTool {
  name: string;
  description: string;
  /** The existing generated JSON-schema properties (zodToMcpProps via mcp.ts) — same object. */
  input_schema: object;
  call(args: Record<string, unknown>): Promise<SurfaceToolResult>;
}

// Tools whose implementation is inherently local-process. Each entry names WHY, so the
// hosted refusal teaches instead of stonewalling.
const HOSTED_BLOCKED: Readonly<Record<string, string>> = {
  server_restart:
    "server_restart is a local-process concern (the stdio relay restarts its child); a hosted, per-request surface has no server process to restart",
  skill_execute:
    "skill_execute runs a skill's code half in a local subprocess against its on-disk package; hosted skills carry no local package — run code skills where the genome files live",
  skill_evolve:
    "skill_evolve runs candidate code against local fixtures in a subprocess; hosted skills carry no local package to evolve",
  charter_read:
    "charter_read reads a charter file from a local path; a hosted surface has no filesystem",
  gig_logs:
    "gig_logs tails per-chair log files under the local outputs dir; hosted runs are executed by the drain worker and their record lives in the store",
  genome_reload:
    "genome_reload re-reads genome files from disk; a hosted surface loads its genome from the store per-request, so there is nothing to reload",
};

// The genome-mutation tools whose success must ALSO land in the hosted store, and the class
// each persists as. Payload is filtered by the class's own Zod schema key list (the same
// single source the handlers copy from), so the store payload can't drift from the schema.
const HOSTED_UPSERT: Readonly<Record<string, { cls: GenomeClass; keys: readonly string[] }>> = {
  agent_define: { cls: "agent", keys: Object.keys(AgentSchema.shape) },
  agent_evolve: { cls: "agent", keys: Object.keys(AgentSchema.shape) },
  standard_compose: { cls: "standard", keys: Object.keys(StandardSchema.shape) },
  type_register: { cls: "domain_type", keys: Object.keys(DomainTypeSchema.shape) },
  skill_define: { cls: "skill", keys: Object.keys(SkillSchema.shape) },
  // The chart and the venue ride the same port. The store side is NOT built — coltrane_genome_upsert
  // has no branch for either class — so a hosted chart_define reaches the RPC and is refused there,
  // with the store's own message, and the mutation fails loudly. That is the right failure: the
  // class travels the port it is supposed to travel, and the missing half announces itself instead
  // of the engine quietly declining to try. (Store-side work: two tables + two upsert branches.)
  chart_define: { cls: "chart", keys: Object.keys(ChartSchema.shape) },
  venue_define: { cls: "venue", keys: Object.keys(VenueObjectSchema.shape) },
};

async function callSurfaceTool(
  slug: string,
  args: Record<string, unknown>,
  deps: ToolSurfaceDeps,
): Promise<SurfaceToolResult> {
  if (slug === "venue_credential_mint") {
    // The engine half of the venue credential: shape validation and the three refusals around
    // whatever backend a deployment injects. This fires for ALL callers, not only hosted, because
    // its refusals are structural facts about the credential — not a hosted-transport concern.
    //
    // (a) A gig-scoped caller may NOT mint a venue credential. This is decided from caller identity
    //     alone, BEFORE the backend is reached, because the escalation (a one-lease gig token
    //     minting an org-scoped key that outlives every gig) is a credential-scope fact no store-side
    //     gate catches. A refused mint must never touch the backend.
    const escalation = gigScopeRefusal(deps.caller);
    if (escalation) {
      return {
        ok: false,
        refusal: escalation,
        error:
          "a gig-scoped credential may not mint a venue credential: a gig token is issued to one " +
          "agent for one gig and expires with that gig's lease, while a venue credential is " +
          "org-scoped and outlives every gig. Mint from a member or venue credential instead.",
      };
    }
    // (b) No backend wired → the verb answers honestly rather than throwing, naming the seam to
    //     wire (the same shape gig_dispatch/gig_approve/gig_cancel use when their store seams are
    //     absent). A caller that cannot tell "minting is unwired here" from "your request was bad"
    //     retries the wrong thing forever.
    if (!deps.mintVenueCredential) {
      return {
        ok: false,
        refusal: "no_backend",
        error:
          "no minting backend is wired on this surface — venue_credential_mint ships its schema " +
          "and refusals, but a deployment supplies the credential. Wire deps.mintVenueCredential " +
          "(parallel to deps.queueGig) to stand up the worker environment.",
      };
    }
    // (c) Mint, then check the grant is COMPLETE. A backend that answers with a half-set is refused,
    //     not forwarded — handing an incomplete environment back moves the assembly problem to the
    //     caller while looking like success, which is the failure this verb exists to end.
    let grant: VenueCredentialGrant;
    try {
      grant = await deps.mintVenueCredential({
        org_slug: String(args["org_slug"] ?? ""),
        instance: String(args["instance"] ?? ""),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const missing = missingWorkerEnv(grant.env);
    if (missing.length) {
      return {
        ok: false,
        refusal: "incomplete_env",
        error:
          `the minted grant is missing required worker environment: ${missing.join(", ")}. A grant ` +
          "that is not complete is refused, not returned — a half-set moves the assembly problem to " +
          "the caller while looking like success.",
      };
    }
    // (d) The class names pass through UNCHANGED — the engine does not validate class vocabulary
    //     (that is the room contract's job, checked by realize before dispatch). The grant is the
    //     answer, returned exactly once; the engine does not persist it and there is no read-back.
    return { ok: true, data: grant };
  }
  if (deps.hosted) {
    const blocked = HOSTED_BLOCKED[slug];
    if (blocked) return { ok: false, hosted_unsupported: true, error: blocked };
    if (slug === "gig_dispatch") {
      // Hosted dispatch NEVER spawns. With a queue seam it queues (the gig table is the
      // queue; a drain worker claims and runs); without one it says so, typed.
      if (deps.queueGig) {
        try {
          const data = await deps.queueGig(args);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return {
        ok: false,
        hosted_unsupported: true,
        error:
          "hosted dispatch goes through the queue RPC (coltrane_gig_dispatch) — nothing spawns in a hosted " +
          "surface. Wire deps.queueGig (e.g. postgrestQueueGig(ctx) from ./genome_store) to queue the gig " +
          "for the drain worker.",
      };
    }
    if (slug === "gig_approve") {
      // Approval is a MEMBER act. The tool is a pure pass-through to the store's member-JWT-only
      // coltrane_gig_approve RPC — an AGENT token is refused THERE, which is where that
      // enforcement belongs, not in the engine. With the seam wired it approves; without it, typed.
      if (deps.approveGig) {
        try {
          const data = await deps.approveGig(args);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return {
        ok: false,
        hosted_unsupported: true,
        error:
          "hosted approval goes through the member RPC (coltrane_gig_approve) — a member act the store " +
          "authorizes, never the engine. Wire deps.approveGig (parallel to deps.queueGig) to approve the " +
          "parked gig over the wire.",
      };
    }
    if (slug === "gig_cancel") {
      // Cancelling a QUEUED gig reaches the org gig table, never a local run — so hosted cancel
      // is a pure pass-through to the store's cancel RPC (member JWT → coltrane_gig_cancel;
      // agent token → coltrane_mcp_gig_cancel). The store cancels only a queued row and REFUSES
      // a claimed/running one — that refusal, naming gig_abort, surfaces as a failed cancel.
      if (deps.cancelGig) {
        try {
          const data = await deps.cancelGig(args);
          return { ok: true, data };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      return {
        ok: false,
        hosted_unsupported: true,
        error:
          "hosted cancel goes through the cancel RPC (coltrane_gig_cancel for a member, " +
          "coltrane_mcp_gig_cancel for an agent token) — the gig table is the queue and the store " +
          "authorizes. Wire deps.cancelGig (parallel to deps.queueGig) to cancel the queued gig over the wire.",
      };
    }
  }
  const result = await dispatchTool(slug, args, deps);
  // Hosted persistence: without a genome_dir the handlers compute + validate + seal identity
  // but write no file (the validation path). The store upsert is the hosted write half; a
  // refused upsert fails the mutation loudly — a definition that only ever lived in this
  // request's memory must not report success.
  const up = HOSTED_UPSERT[slug];
  if (deps.hosted && deps.store && result.ok && up) {
    // No org rides the call: the caller set a working org ONCE (org_use) and the store's
    // resolver supplies it — explicit-per-call disambiguators are exactly the bookkeeping
    // the surface must not push onto agents.
    // agent_evolve persists the MERGED definition the handler computed, not the raw args.
    const source: Record<string, unknown> =
      slug === "agent_evolve" && result.data && typeof result.data === "object" && (result.data as Record<string, unknown>)["next_def"]
        ? ((result.data as Record<string, unknown>)["next_def"] as Record<string, unknown>)
        : args;
    const payload: Record<string, unknown> = {};
    for (const k of up.keys) if (source[k] !== undefined) payload[k] = source[k];
    try {
      await deps.store.upsert(up.cls, payload);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return result;
}

/** The engine's FULL MCP tool surface as a transport-agnostic registry. The stdio server
 *  below consumes this internally; a hosted host mounts it per-request with hosted deps. */
export function createToolSurface(deps: ToolSurfaceDeps): SurfaceTool[] {
  return MCP_TOOLS.map((t) => ({
    name: t.slug,
    description: `${t.category} tool`,
    input_schema: t.input_schema,
    call: (args: Record<string, unknown>): Promise<SurfaceToolResult> => callSurfaceTool(t.slug, args, deps),
  }));
}

// Reserved relay↔child request schemas (restart guard, venue/8). The MCP SDK keys a request
// handler by the `method` literal in its schema; `.passthrough()` lets the full JSON-RPC envelope
// (jsonrpc/id/params) pass validation. These carry no params — the relay asks, the child answers
// from deps.gig_runs. Registering them as request handlers (not tools) is what keeps them off
// tools/list, so they are invisible to Claude Code and callable only by the parent relay.
const RunningGigsRequestSchema = z.object({ method: z.literal(RUNNING_GIGS_METHOD) }).passthrough();
const AbortForRestartRequestSchema = z.object({ method: z.literal(ABORT_FOR_RESTART_METHOD) }).passthrough();

/** Build the low-level MCP Server with ListTools + CallTool wired to the tool surface. */
export function createColtraneServer(deps: ServerDeps, recorder?: SubthreadRecorder): Server {
  const server = new Server(
    { name: "coltrane", version: COLTRANE_VERSION },
    { capabilities: { tools: {} } },
  );

  const surface = createToolSurface(deps);
  const byName = new Map(surface.map((t) => [t.name, t] as const));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: surface.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = byName.get(req.params.name);
    // A name outside the surface falls through to the dispatcher's own unknown-tool answer,
    // keeping the reply byte-identical to the pre-surface path.
    const result = tool ? await tool.call(args) : await dispatchTool(req.params.name, args, deps);
    if (recorder) {
      recorder.recordToolCall(req.params.name);
      recorder.recordObservability(`call:${req.params.name}`, { ok: result.ok });
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      isError: !result.ok,
    };
  });

  // ── Restart guard (venue/8): the child's half of the relay↔child conversation ──────────────
  // The stdio relay (src/server_relay.ts) holds NO gig state, so before it kills this child to pick
  // up new bytes it ASKS the child what a restart would destroy. These two reserved methods answer.
  // They are deliberately NOT MCP tools — they are not in `createToolSurface`, so they never appear
  // in tools/list and Claude Code cannot call them; only the parent relay, over the same stdio pipe,
  // does. That is what keeps the relay's blindness structural: it asks, the child answers from the
  // ONE authority (deps.gig_runs), the relay acts on the answer.
  const runningGigIds = (): string[] =>
    [...(deps.gig_runs?.entries() ?? [])]
      .filter(([, s]) => s.status === "running")
      .map(([id]) => id);

  // "Which gigs are running right now?" — the pre-restart check. Answering with the empty list is a
  // POSITIVE statement ("nothing in flight, restart freely"); the relay only treats a NON-answer
  // (timeout) as unhealthy, never an empty answer.
  server.setRequestHandler(RunningGigsRequestSchema, async () => ({ running: runningGigIds() }));

  // The FORCE path: the operator chose to restart with gigs in flight. Abort each running gig and —
  // the whole point — LEDGER the abort BEFORE this child dies, so a killed gig is a recorded fact
  // rather than an absence (the defect: two publish seats, gigs 8146142e / 18726459, died mid-phase
  // with sealed outputs banked and no row saying they were killed). This reuses the EXACT sanctioned
  // gig_abort path: mark the run, abort its controller, then governanceRow('gig_abort', …).
  server.setRequestHandler(AbortForRestartRequestSchema, async () => {
    const aborted: string[] = [];
    for (const [gid, live] of deps.gig_runs?.entries() ?? []) {
      if (live.status !== "running") continue;
      live.abort_requested = true;
      live.abort_reason = "server_restart override";
      let cancelled = false;
      if (live.controller) {
        try { live.controller.abort(live.abort_reason); } catch { /* an already-aborted signal is fine */ }
        cancelled = true;
      }
      deps.ledger.append(
        governanceRow("gig_abort", gid, { reason: "server_restart override", status: "aborting", cancelled }, gid),
      );
      aborted.push(gid);
    }
    return { aborted };
  });

  return server;
}

/**
 * Deterministic hash of the loaded genome (types + agents + standards). Identical
 * source trees produce identical hashes, regardless of which session boots the server.
 */
function loadedGenomeHash(genome: LoadedGenome): string {
  const types = [...genome.domain_types.values()]
    .map((t) => ({ slug: t.slug, extends: t.extends, domain: t.domain, required_fields: t.required_fields, schema: t.schema }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const agents = [...genome.agents.values()]
    .map((a) => ({ slug: a.slug, primitives: a.primitives, input_types: a.input_types, output_types: a.output_types, domain: a.domain }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const standards = [...genome.standards.values()]
    .map((s) => ({ slug: s.slug, domain: s.domain, agent_slugs: s.agents.map((x) => x.slug), phases: s.phases }))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return createHash("sha256").update(canonJson({ types, agents, standards })).digest("hex");
}

/**
 * stdio entry. Boots a server and connects over stdin/stdout. By default the
 * AgentInvoker is the REAL Claude CLI (Claude Code = the cognition) — so a prod
 * server runs gigs against the live model. Tests inject deps (incl. a mock invoke).
 */
/**
 * Boot a full ServerDeps from the genome FILES on disk — so a bare `node dist/src/server_entry.js`
 * serves the repo's genome (types, agents, standards), not an empty registry. The genome
 * root is COLTRANE_GENOME or the cwd. Pure + testable (no stdio); fails loud if the cwd
 * isn't a genome (loadGenome rejects a missing/invalid core_types/).
 */
// #185 — the MCP servers a deployment makes available, keyed by server slug. The repo's .mcp.json
// IS that registry (coltrane ships its own "coltrane" server; a deployment adds e.g. a browser
// server there). Per-agent grant resolution wires only the servers an agent's allowed_tools name
// into its spawn — deny-by-default. Falls back to coltrane's own server if .mcp.json is absent.
function readMcpServerConfigs(root: string): Record<string, unknown> {
  const path = join(root, ".mcp.json");
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") return parsed.mcpServers;
    } catch { /* fall through to the default */ }
  }
  return { [ENGINE_MCP_SERVER]: { command: "node", args: ["dist/src/server_entry.js"] } };
}

export function bootstrapServerDeps(genomeRoot?: string): ServerDeps {
  const root = genomeRoot ?? process.env["COLTRANE_GENOME"] ?? process.cwd();
  const genome = resolveGenome(root); // manifest-aware: honors a consumer's `extends` base
  const registry = loadRegistry(genome);
  const mcpServerConfigs = readMcpServerConfigs(root);
  // #185 — the genome→provider bridge the resolver needs to be reachable in production. Each
  // registered engine tool slug (the coltrane MCP surface + anything tool_register added) becomes an
  // in_house provider, so an agent that grants a real engine tool resolves instead of failing closed.
  // Without this the resolver only ever saw the browser cage, so any non-playwright grant was a dead
  // name. Shared by reference with the invoker so tool_register stays live (no restart needed).
  // #204 — tag each in-house tool with the engine's own MCP server ("coltrane", the slug the
  // repo's .mcp.json ships). An in-house grant then wires that server into the spawn AND advertises
  // the tool as mcp__coltrane__<slug> — the name the server exposes — so a bare-slug grant (the form
  // agent_define accepts) is actually callable instead of a silent dead name that seals nothing.
  const toolProviders = new Map<string, ToolProvider>(
    [...REGISTERED_TOOL_SLUGS].map((slug) => [slug, { tool: slug, kind: "in_house" as const, server: ENGINE_MCP_SERVER }]),
  );
  // The two-tier local mirror, rooted at `<root>/.coltrane` (gitignored, beside the ledger).
  // The SAME instance is handed to the OutputStore and exposed as `output_mirror`, so every
  // sealed output — whether this process ran the gig or a separate CLI process did — lands in
  // one content-addressed store MCP retrieval reads. COLTRANE_MIRROR_DIR overrides (tests).
  const output_mirror = createOutputMirror(defaultMirrorDir(root));
  return {
    registry,
    toolProviders,
    mcpServerConfigs, // the SAME object handed to the invoker — the preflight guard resolves against it
    // A chair's spawn sets COLTRANE_OUTPUT_WRITE_MODE=validate so this child's coltrane server
    // adjudicates the chair's in-band output_write calls against the full seal predicate WITHOUT
    // persisting — the runtime that captures the validated payload is the one that seals. A bare
    // server start (no env) keeps "seal": a human/agent output_write durably writes as before.
    ...(process.env["COLTRANE_OUTPUT_WRITE_MODE"] === "validate" ? { output_write_mode: "validate" as const } : {}),
    output_mirror,
    // PR #78 follow-up: persist outputs to disk so the audit chain survives an
    // MCP session close (Rob cold-trial requirement). COLTRANE_OUTPUTS_DIR
    // overrides the default ~/.eir/coltrane_outputs path (tests + sandboxes).
    outputs: createOutputStore(registry, { persistDir: defaultOutputsPersistDir(), mirror: output_mirror }),
    // #209 — the audit spine is durable by default. The line above gives OUTPUTS a persistDir
    // under an explicit "the audit chain must survive an MCP session close" requirement
    // (PR #78); the ledger sat in RAM directly beneath it, which made absence-of-row mean
    // "we forgot" instead of "the run did not finish" — inverting the invariant
    // tests/e2e/recorder_durability_mid_crash.spec.ts deliberately pins.
    // FileLedger creates nothing until the first append (#210), so merely bootstrapping deps
    // — as tests/dispatch_tool_resolution.test.ts does with no root — leaves no trace.
    ledger: new FileLedger(defaultLedgerPath(root)),
    standards: genome.standards, // ← gig_dispatch can now resolve file-defined standards
    charts: genome.charts,   // ← gig_dispatch resolves a chart_slug; chart_browse lists them
    venues: genome.venues,   // ← the ceiling a chart's venue imposes has to resolve to something
    // The production construction of a realizer — the wire from dispatch to the container substrate.
    // A venue-with-mcp_servers gig is stood up on this (real docker by default; the seam's `run` is
    // the daemon-free test substitute). Before this, dockerComposeRealizer was defined and reachable
    // from nowhere in src/, so a venue-named gig got no room. runGig only realizes when the venue
    // declares servers, so wiring it here changes no server-less venue's behaviour.
    venueRealizer: dockerComposeRealizer(),
    invoke: makeClaudeInvoker({
      registry,
      model: process.env["COLTRANE_MODEL"],
      // #185 — per-agent grant resolution wires each agent's MCP servers into its spawn (coltrane's
      // own server + any the deployment registers in .mcp.json). An unresolvable grant fails closed.
      mcpServerConfigs,
      toolProviders, // the genome→provider bridge (above) — makes in_house grants resolvable
      // The production seal path: a model chair SEALS IN-BAND by calling output_write (validated at
      // the full write boundary, corrected in-band), and the invoker captures what passed. The
      // engine server config above is bridged into the spawn and its validate-mode env set, so the
      // chair's output_write adjudicates-not-persists and the runtime seals exactly once.
      sealVia: "output_write",
      // per-chair wall-clock bound; COLTRANE_CHAIR_TIMEOUT_MS overrides for slow deployments
      ...(process.env["COLTRANE_CHAIR_TIMEOUT_MS"] ? { timeout_ms: Number(process.env["COLTRANE_CHAIR_TIMEOUT_MS"]) } : {}),
      // The reserve grant (#329) had no reachable caller: it was built, tested, and set by nothing,
      // so a chair that spent its budget still died silently at the cap. This is the operator-level
      // door to it. Absent = no reserve, which is the prior behaviour exactly — an extension nobody
      // asked for is spend nobody authorised. The DURABLE fix is a per-chair `turn_reserve` declared
      // in the standard (PR #331), because a budget is a property of the work rather than of the
      // player; this env is the deployment-level stopgap until that lands, not a substitute for it.
      ...(process.env["COLTRANE_TURN_RESERVE"] ? { turn_reserve: Number(process.env["COLTRANE_TURN_RESERVE"]) } : {}),
    }),
    model_version: process.env["COLTRANE_MODEL"] ?? "claude-cli-default",
    skills: genome.skills, // ← skill substrate — runGig resolves agent.skill_slugs into prompt
    // skill-backed chairs (Chair.skill_slug) run the skill's code half — map slug → package dir.
    skill_dirs: new Map([...genome.skills.values()].map((s): [string, string] => [s.slug, String(s.package_dir)])),
    evals: genome.evals, // ← 5th-class eval substrate — runGig judges declared eval_slugs
    genome_dir: root, // ← genome-mutation tools persist + ledger-seal into the live genome
    load_errors: [...genome.load_errors], // ← Rob #129 — surfaced via system_health
    agents: new Map(genome.agents), // ← Rob #130 + #132 — slug-resolve + reload-diff
    provenance: genome.provenance, // ← genome extension — which layer supplied each def
    gig_runs: new Map(), // ← async dispatch — live gig state gig_monitor reads
    gig_log_base: defaultOutputsPersistDir(), // ← per-gig agent logs at <base>/gigs/<id>/<role>.jsonl
    // Checkpoints + the reuse cache live alongside outputs/ and refs/ under the same root.
    checkpoints: createCheckpointStore(defaultOutputsPersistDir()),
    reuse: createReuseStore(defaultOutputsPersistDir()),
  };
}

/** The slice of `process` the shutdown path uses. Injected in tests — signal handling is
 *  otherwise untestable without spawning a server. */
export interface ShutdownProcess {
  on(event: string, listener: () => void): unknown;
  exit(code?: number): void;
}

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
// 128 + signal number, the shell convention.
const SIGNAL_EXIT_CODE: Readonly<Record<string, number>> = { SIGTERM: 143, SIGINT: 130 };

/**
 * Install the server's shutdown path (#252).
 *
 * The bug this closes: the old wiring was `process.on("SIGTERM", flush)` where `flush()` sets
 * a flag and returns. In Node, installing a SIGINT/SIGTERM listener REPLACES the default
 * terminate behaviour — so a recorder-enabled server survived SIGTERM indefinitely. The relay's
 * 2s SIGKILL escalation masked it; a direct `kill <pid>` did not terminate the server at all.
 *
 * The second half: the server's own `claude` grandchildren are spawned WITHOUT `detached`, so
 * they are not in a separate process group and POSIX delivers them nothing when the server is
 * signalled. They keep running, orphaned, still billing — and gig tracking is dropped by the
 * restart, so nothing records that the orphans exist. So the server kills them itself on the
 * way out. (Killing the process GROUP would be airtight but takes children out of the server's
 * group, so an operator Ctrl-C would stop reaching them — deliberately not taken.)
 */
/**
 * The SIGTERM→SIGKILL grace the SHUTDOWN path passes to `killLiveChairChildren` — zero, on
 * purpose (#260).
 *
 * `terminateChild` implements its grace as a `setTimeout(...).unref()`, and `shutdown()` below
 * calls `proc.exit()` on the very next line. An unref'd timer in a process that is already
 * leaving can never fire, so any POSITIVE grace here means the escalation is skipped entirely
 * and a SIGTERM-trapping `claude` child survives exactly the shutdown that #252 added to take
 * it with us — still running, still billing, and now with no parent tracking it. A zero grace
 * escalates inline instead: SIGTERM then SIGKILL, both before we exit.
 *
 * The cooperative window is not lost, only relocated: the CANCELLATION path
 * (`spawnStreaming`'s abort listener) keeps running afterwards, so it keeps
 * `DEFAULT_ABORT_GRACE_MS` and its timer genuinely fires.
 */
export const SHUTDOWN_CHILD_GRACE_MS = 0;

export function installShutdownHandlers(
  opts: { flush?: (() => void) | undefined; killChildren?: (() => void) | undefined },
  proc: ShutdownProcess = process as unknown as ShutdownProcess,
): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // an impatient double Ctrl-C must not re-enter the flush
    shuttingDown = true;
    try { opts.flush?.(); } catch { /* a failed flush must not block the exit */ }
    try { opts.killChildren?.(); } catch { /* nor must a failed kill */ }
    proc.exit(SIGNAL_EXIT_CODE[signal] ?? 0);
  };
  for (const sig of SHUTDOWN_SIGNALS) proc.on(sig, () => shutdown(sig));
  // Normal-exit paths still flush; they do not need (or want) an explicit exit call.
  const flushOnly = (): void => { try { opts.flush?.(); } catch { /* best-effort */ } };
  proc.on("beforeExit", flushOnly);
  proc.on("exit", flushOnly);
}

export async function runStdioServer(deps?: ServerDeps): Promise<void> {
  // Tests inject deps; a bare prod start bootstraps the genome from files.
  const resolved = deps ?? bootstrapServerDeps();
  const recorder = openSubthreadRecorderFromEnv(resolved);
  const server = createColtraneServer(resolved, recorder ?? undefined);
  installShutdownHandlers({
    ...(recorder ? { flush: (): void => { recorder.flush(); } } : {}),
    // unconditional: the orphan half has nothing to do with the recorder.
    // Zero grace — see SHUTDOWN_CHILD_GRACE_MS: the default grace is an unref'd timer that
    // cannot fire in a process that exits on the next line.
    killChildren: (): void => { killLiveChairChildren(SHUTDOWN_CHILD_GRACE_MS); },
  });
  await server.connect(new StdioServerTransport());
}

/**
 * Open a sub-thread recorder if the harness/parent supplied env wiring. Reads
 * COLTRANE_SESSION_ID + COLTRANE_RECORDER_PATH (mandatory pair); optional
 * COLTRANE_API_VERSION (default "1.0.0"), COLTRANE_PARENT_SESSION_ID,
 * COLTRANE_MODEL. On api_version mismatch with a prior turn for this session,
 * writes a typed error entry to the recorder, prints the typed error to stderr
 * (best-effort observability), and exits non-zero so the seam fails CLOSED.
 */
function openSubthreadRecorderFromEnv(deps: ServerDeps): SubthreadRecorder | null {
  const session_id = process.env["COLTRANE_SESSION_ID"];
  const path = process.env["COLTRANE_RECORDER_PATH"]
    ?? (deps.genome_dir ? join(deps.genome_dir, ".coltrane-recorder.jsonl") : undefined);
  if (!session_id || !path) return null;
  const api_version = process.env["COLTRANE_API_VERSION"] ?? "1.0.0";
  const parent_session_id = process.env["COLTRANE_PARENT_SESSION_ID"] ?? null;
  const model_version = process.env["COLTRANE_MODEL"] ?? deps.model_version ?? "claude-cli-default";
  const genome = deps.genome_dir ? resolveGenome(deps.genome_dir) : null;
  const genome_hash = genome ? loadedGenomeHash(genome) : "no-genome";
  const run_fp = runFingerprint({
    genome_hash,
    model_version,
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores: {},
    output_hashes: [],
  });
  try {
    return SubthreadRecorder.open({
      path,
      session_id,
      parent_session_id,
      api_version,
      genome_hash,
      run_fingerprint: run_fp,
    });
  } catch (e) {
    if (e instanceof ApiVersionMismatchError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
}
