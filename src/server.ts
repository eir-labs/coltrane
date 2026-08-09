// §7 MCP server — the stdio entry that exposes MCP_TOOLS and routes calls.
// Two layers: a PURE dispatcher (dispatchTool — testable, no transport) and the
// stdio wiring (runStdioServer). Tools needing gig-execution context (output_write,
// gig_*) are honest `not_implemented` until src/runtime lands; the context-free
// tools (type_resolve/register/browse, standard_simulate) are wired now.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
import { SkillSchema, AgentSchema, StandardSchema } from "./genome_schema.js";
import { runSkillFixtures, executeSkill, loadFixtures } from "./skill_subprocess.js";
import { evolveSkill } from "./skills.js";
import { sealAgentDefinition, sealDefinition, sealSkillPackage, recordIdentity } from "./genome_writer.js";
import { createOutputStore, defaultOutputsPersistDir, type OutputStore } from "./outputs.js";
import {
  FileLedger, LedgerError, LEDGER_SCHEMA_VERSION, defaultLedgerPath,
  type Ledger, type GovernanceLedgerEntry,
} from "./ledger.js";
import { sealDrill } from "./seal_drill.js";
import { standardSimulate } from "./simulate.js";
import { runGig, BudgetExhausted, GigAborted, ResumeRefused, partialGigUsage, partialBudgetState, type AgentInvoker } from "./runtime.js";
import { createCheckpointStore, createReuseStore, type CheckpointStore, type ReuseStore } from "./reuse.js";
import { makeClaudeInvoker, killLiveChairChildren } from "./claude_invoker.js";
import { isDepth, DEPTHS, type Depth } from "./pricing.js";
import type { ToolProvider } from "./tool_providers.js";
import { ENGINE_MCP_SERVER } from "./tool_providers.js";
import type { ToolHook, ToolCallContext, PreOutcome } from "./hooks.js";
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
  // #206 — the interception seam. A wrapping layer (control plane) injects pre/post hooks that
  // gate/observe/rewrite tool calls in-process. The engine ships ZERO hooks and ZERO policy; it only
  // CALLS whatever is injected here. Absent/empty → dispatch is byte-identical to no seam.
  hooks?: readonly ToolHook[] | undefined;
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
        let outs = deps.outputs.all();
        if (args["domain_type"]) outs = outs.filter((o) => o.domain_type === args["domain_type"]);
        if (args["gig_id"]) outs = outs.filter((o) => o.gig_id === args["gig_id"]);
        if (args["agent_slug"]) outs = outs.filter((o) => o.agent_slug === args["agent_slug"]);
        // #234 — `data_filter` was advertised and ignored, so a caller narrowing a query by
        // payload got the UNFILTERED set back and a `total_count` describing it. Every key must
        // match (AND), compared structurally so an object or array value filters as written.
        const dataFilter = args["data_filter"];
        if (dataFilter && typeof dataFilter === "object" && !Array.isArray(dataFilter)) {
          const entries = Object.entries(dataFilter as Record<string, unknown>);
          outs = outs.filter((o) => {
            const data = (o.data ?? {}) as Record<string, unknown>;
            return entries.every(([k, v]) => canonJson(data[k]) === canonJson(v));
          });
        }
        return { ok: true, requires_approval: approval, data: { outputs: outs, total_count: outs.length } };
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
        const upstream = direction === "downstream"
          ? []
          : deps.outputs.trace(id, maxDepth !== undefined ? { max_depth: maxDepth } : undefined);
        // Forward walk: a node's children are the outputs naming it in their input_refs.
        const downstream: typeof upstream = [];
        if (direction !== "upstream") {
          const all = deps.outputs.all();
          const seen = new Set<string>([id]);
          let frontier = [id];
          for (let depth = 0; frontier.length && (maxDepth === undefined || depth < maxDepth); depth++) {
            const next: string[] = [];
            for (const o of all) {
              if (seen.has(o.id)) continue;
              if (o.input_refs.some((r) => frontier.includes(r))) {
                seen.add(o.id); downstream.push(o); next.push(o.id);
              }
            }
            frontier = next;
          }
        }
        const nodes = direction === "upstream" ? upstream
          : direction === "downstream" ? downstream
          : [...upstream, ...downstream.filter((d) => !upstream.some((u) => u.id === d.id))];
        return {
          ok: true, requires_approval: approval,
          data: {
            graph: { nodes }, direction,
            root_signals: nodes.filter((o) => o.input_refs.length === 0),
            // The other end of the chain: outputs nothing else was derived from.
            terminal_outputs: nodes.filter((o) => !deps.outputs.all().some((x) => x.input_refs.includes(o.id))),
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
        return { ok: true, requires_approval: approval, data: { output_id: rec.id, primitive, output: rec } };
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
        const slug2 = String(args["standard_slug"] ?? "");
        const standard = deps.standards.get(slug2);
        if (!standard) return { ok: false, requires_approval: approval, error: `unknown standard "${slug2}"` };
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
        const stdStatus = (standard as { status?: string }).status;
        if (stdStatus === "retired") {
          return {
            ok: false, requires_approval: approval,
            error: `standard "${slug2}" is retired and cannot be dispatched. ` +
              `Promote it back to active (standard_promote) if it should run again.`,
          };
        }
        const warnings: string[] = stdStatus === "deprecated"
          ? [`standard "${slug2}" is deprecated — it still runs, but should not be built on.`]
          : [];
        // WU-0008 preflight: run the same sealDrill used by standard_simulate BEFORE spending
        // on any chair. A structurally-unsealable standard is refused here (pennies) instead of
        // after a chair runs and aborts. Gate is placed once, above the wait/async split, so a
        // single check covers both runGig call-sites below.
        const drill = sealDrill(
          { phases: standard.phases.map((p) => ({ name: p.name, chairs: p.chairs.map((c) => ({ role: c.role, output_contract: c.output_contract })) })) },
          deps.registry,
        );
        if (!drill.ok) {
          return {
            ok: false, requires_approval: approval,
            error: `standard "${slug2}" cannot seal: ` +
              drill.failures.map((f) => `${f.phase}/${f.role} → ${f.domain_type} (${f.errors.join("; ")})`).join(", "),
            data: { seal_drill: drill },
          };
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
        const reuseWiring = {
          ...(deps.checkpoints ? { checkpoints: deps.checkpoints } : {}),
          ...(resumeArg !== undefined ? { resume_from: resumeArg } : {}),
          ...(reuseOn && deps.reuse ? { reuse: deps.reuse } : {}),
        };
        /** What a run skipped, and why — echoed on every reply so a saving is never silent. */
        const savings = (res: Awaited<ReturnType<typeof runGig>>): Record<string, unknown> => ({
          ...(res.skipped ? { skipped: res.skipped } : {}),
          ...(res.resumed_from ? { resumed_from: res.resumed_from } : {}),
          ...(res.reuse ? { reuse: res.reuse } : {}),
          ...(res.checkpoint_error ? { checkpoint_error: res.checkpoint_error } : {}),
        });

        // Synchronous mode (opt-in via wait:true) — block, return the manifest. The
        // deterministic test path and any caller that wants the answer in one call.
        const wait = args["wait"] === true;
        if (wait) {
          try {
            const res = await runGig(standard, gigInput, {
              outputs: deps.outputs, ledger: deps.ledger, invoke: deps.invoke,
              model_version: deps.model_version, skills: deps.skills, skill_dirs: deps.skill_dirs, evals: deps.evals, budget,
              ...(depth ? { depth } : {}), ...reuseWiring,
            });
            return {
              ok: true, requires_approval: approval,
              data: {
                gig_id: res.gig_id,
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
          gig_id: gigId, onProgress, signal: controller.signal, ...(depth ? { depth } : {}), ...reuseWiring,
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
            state.status = "complete"; state.finished_at = new Date().toISOString();
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
        if (live) {
          const outs = deps.outputs.all().filter((o) => o.gig_id === gid);
          return {
            ok: true, requires_approval: approval,
            data: {
              status: live.status,
              standard_slug: live.standard_slug,
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
        const outs = deps.outputs.all().filter((o) => o.gig_id === gid);
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
          const sAgentsRaw = (args["agents"] as unknown[]) ?? [];
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
              },
              modified: {
                domain_types: typeDiff.modified,
                standards: standardsDiff.modified,
                skills: skillsDiff.modified,
                evals: evalsDiff.modified,
                agents: agentsDiff.modified,
              },
              removed: {
                domain_types: typeDiff.removed,
                standards: standardsDiff.removed,
                skills: skillsDiff.removed,
                evals: evalsDiff.removed,
                agents: agentsDiff.removed,
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
        if (evolveSlug && changes && deps.genome_dir) {
          const agentPath = join(deps.genome_dir, "agents", `${evolveSlug}.json`);
          if (!existsSync(agentPath)) {
            return { ok: false, requires_approval: approval, error: `agent_evolve: unknown agent "${evolveSlug}" (no agents/${evolveSlug}.json)` };
          }
          const currentDef = JSON.parse(readFileSync(agentPath, "utf-8")) as AgentDef;
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
          return {
            ok: true, requires_approval: approval,
            data: { new_version, evolved: sealed.agent, content_hash: sealed.content_hash, effective_hash: sealed.effective_hash, cascade_check: { agents_affected: [], standards_affected } },
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

/** Build the low-level MCP Server with ListTools + CallTool wired to the dispatcher. */
export function createColtraneServer(deps: ServerDeps, recorder?: SubthreadRecorder): Server {
  const server = new Server(
    { name: "coltrane", version: COLTRANE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({
      name: t.slug,
      description: `${t.category} tool`,
      inputSchema: t.input_schema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatchTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, deps);
    if (recorder) {
      recorder.recordToolCall(req.params.name);
      recorder.recordObservability(`call:${req.params.name}`, { ok: result.ok });
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      isError: !result.ok,
    };
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
  return {
    registry,
    toolProviders,
    // PR #78 follow-up: persist outputs to disk so the audit chain survives an
    // MCP session close (Rob cold-trial requirement). COLTRANE_OUTPUTS_DIR
    // overrides the default ~/.eir/coltrane_outputs path (tests + sandboxes).
    outputs: createOutputStore(registry, { persistDir: defaultOutputsPersistDir() }),
    // #209 — the audit spine is durable by default. The line above gives OUTPUTS a persistDir
    // under an explicit "the audit chain must survive an MCP session close" requirement
    // (PR #78); the ledger sat in RAM directly beneath it, which made absence-of-row mean
    // "we forgot" instead of "the run did not finish" — inverting the invariant
    // tests/e2e/recorder_durability_mid_crash.spec.ts deliberately pins.
    // FileLedger creates nothing until the first append (#210), so merely bootstrapping deps
    // — as tests/dispatch_tool_resolution.test.ts does with no root — leaves no trace.
    ledger: new FileLedger(defaultLedgerPath(root)),
    standards: genome.standards, // ← gig_dispatch can now resolve file-defined standards
    invoke: makeClaudeInvoker({
      registry,
      model: process.env["COLTRANE_MODEL"],
      // #185 — per-agent grant resolution wires each agent's MCP servers into its spawn (coltrane's
      // own server + any the deployment registers in .mcp.json). An unresolvable grant fails closed.
      mcpServerConfigs,
      toolProviders, // the genome→provider bridge (above) — makes in_house grants resolvable
      // per-chair wall-clock bound; COLTRANE_CHAIR_TIMEOUT_MS overrides for slow deployments
      ...(process.env["COLTRANE_CHAIR_TIMEOUT_MS"] ? { timeout_ms: Number(process.env["COLTRANE_CHAIR_TIMEOUT_MS"]) } : {}),
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
