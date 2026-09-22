/**
 * The chat-completions AgentInvoker — a cheap model port whose HANDS ARE MCP.
 *
 * THE GAP THIS FILLS. A non-CLI invoker already existed and closed itself off from the work that
 * matters — "v0 is deliberately text-in/JSON-out — no tools, no MCP; a chair that needs tools keeps
 * the Claude invoker." A research or synthesis chair must retrieve,
 * vet, seal and write — every one of those a governed verb over MCP. A toolless cheap invoker
 * cannot do the job at all, so cheap and capable stayed mutually exclusive.
 *
 * WHY THIS IS THE CHEAP HALF, AND NOT A REWRITE OF THE HARNESS. Almost all the difficulty in
 * reimplementing a coding harness is the HOST tool surface — Bash, Edit, the filesystem, and the
 * permission machinery that makes them safe. This invoker refuses every host builtin BY NAME and
 * carries only MCP tools, which arrive already governed by the server that serves them. That is a
 * real deferral of the venue tool runtime, stated out loud, rather than a pretence that it is done.
 *
 * THREE THINGS IT DOES NOT DO, DELIBERATELY:
 *   * It names no provider, no vendor and no service. The base URL, the key and the tier→model map
 *     all arrive through `opts`, because a standard says what work IS and the executor is fungible.
 *   * It reads no environment. Config is the caller's job — the pattern the sibling HTTP invoker
 *     set — which is what keeps the worker-env contract honest about who reads what.
 *   * It never throws. Every failure is a typed refusal in the gig_dispatch shape, so an unwired
 *     deployment, a denied grant and a dead upstream are three distinguishable facts.
 *
 * It reuses the pure prompt stack — `buildPrompt`, `extractJson`, `promptSchemaFor`,
 * `extractOptionsForChair` — because three invokers composing prompts three ways is the drift the
 * shared stack exists to prevent.
 */
import type { AgentInvocationContext, AgentInvoker } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { ModelTier } from "./pricing.js";
import { ENGINE_MCP_SERVER, isHostBuiltin, mcpServerOf, toolBaseName, toolSlugOf } from "./tool_providers.js";
import { venueEffectiveTools } from "./chart.js";
import {
  buildPrompt,
  extractJson,
  extractOptionsForChair,
  promptSchemaFor,
  sessionUuidFor,
  MAX_SEALED_RECORDS_PER_TYPE,
  type OutputWriteSeal,
} from "./claude_invoker.js";
import { CORE_TYPES } from "./core_types.js";
import type { TranscriptStore } from "./transcript_store.js";
// The provider-neutral loop and the chat-completions wire it runs on. The invoker no longer carries
// a loop of its own: it hands `runTurn` a port and a tool source and reads back typed stops. The
// tool-name encoding lives in the port now (the one place that speaks the wire) and is re-exported
// here UNCHANGED so the existing completions-invoker laws keep their import path (Laws 4 & 12 import
// encodeToolName/fromFunctionName/toFunctionDef from this module).
import { runTurn, type PriceTable, type ToolSource, type TurnMessage, type TurnResult } from "./turn_loop.js";
import {
  encodeToolName,
  fromFunctionName,
  makeChatCompletionsPort,
  toFunctionDef,
  type FunctionDef,
} from "./chat_completions_port.js";
export { encodeToolName, fromFunctionName, toFunctionDef };
export type { FunctionDef };

/** One model invocation's wall-clock bound — a completion plus its tool turns, not a whole chair. */
export const DEFAULT_COMPLETIONS_TIMEOUT_MS = 120_000;
/** How many tool round-trips one chair may take before the loop refuses to keep paying. */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** One MCP tool as its server advertises it. */
export interface McpToolDef {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/**
 * The hands. A deployment supplies this — in-process against the engine's own surface, or over the
 * wire to a governed one. The engine ships the loop, the conversion and the refusals; it does not
 * ship a transport, for the same reason it ships no hosted seat backing.
 */
export interface McpToolSource {
  list: () => Promise<readonly McpToolDef[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface CompletionsInvokerOptions {
  /** Chat-completions base URL. `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  registry?: Registry | undefined;
  /** ModelTier → the concrete model id. Deployment-defined; the engine hardcodes no names. */
  tierMap?: Partial<Record<ModelTier, string>> | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  /** Engine-default round cap, the LAST fallback under the chair budget and the agent's own cap. */
  maxToolRounds?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  tools?: McpToolSource | undefined;
  /** Served model id → USD per million tokens. Supplied by the deployment; absent = spend is
   *  UNPRICED (reported unpriced, never as $0). Handed straight to the loop's accounting. */
  prices?: PriceTable | undefined;
  /** contract-completions-seat-transcript-v1 — where a seat's conversation is kept, so a maker amend
   *  resumes the transcript it already had rather than being handed a trimmed "resuming the
   *  conversation…" note over a request that holds none. Absent = no transcript is saved or resumed
   *  (the stateless door as it was): a maker amend then falls back to the full cold prompt. */
  transcripts?: TranscriptStore | undefined;
  /**
   * How the seat SEALS. `"output_write"`: in-band, by an `output_write` call the tool source adjudicates
   * against the full contract (validate mode — the runtime is the one sealer), corrected by the seat
   * within its own run; the seat's final text is never sealed. A seat that ends without ever calling it
   * gets ONE repair turn, then is refused `no_seal`. Requires `tools`. Absent: the legacy text seal —
   * the final answer is parsed as JSON, once, with no correction.
   */
  sealVia?: "output_write" | undefined;
}

export type CompletionsRefusal =
  | "host_tool_denied"
  | "no_tool_source"
  | "transport_failed"
  | "unresolved_tier"
  // The turn loop's typed stops, surfaced to the chair as named refusals so the runtime's typed
  // refusal read (runtime.ts) turns a loop that ran out of rounds, timed out or was aborted into a
  // legible chair failure rather than an empty-answer parse error.
  | "round_limit"
  | "timeout"
  | "aborted"
  // contract-seat-context-ceiling-v1 (O4) — the turn loop stopped because the seat's per-round context
  // crossed its declared max_context_tokens. Surfaced as a typed refusal (never a sealed partial) that
  // names the tokens reached and the ceiling.
  | "context_limit"
  // contract-tool-wire-name-collision-v1 (O2) — the offered set held two tools that encode to one wire
  // name. Surfaced as a typed refusal naming the colliding tools, never an insertion-order winner, and
  // caught before any model call.
  | "tool_name_collision"
  // The output_write seal path: the seat ended — after its one repair turn, when it never knocked —
  // with no write accepted by the boundary. Its text is not sealed in the write's place.
  | "no_seal";

export const COMPLETIONS_REFUSALS: readonly CompletionsRefusal[] = [
  "host_tool_denied",
  "no_tool_source",
  "transport_failed",
  "unresolved_tier",
  "round_limit",
  "timeout",
  "aborted",
  "context_limit",
  "tool_name_collision",
  "no_seal",
];

/** The engine's own seal verb, as the tool source lists it. */
const OUTPUT_WRITE_TOOL = `mcp__${ENGINE_MCP_SERVER}__output_write`;
/** The repair turn's round cap: enough to make the call it should have made, not to redo the work. */
const SEAL_REPAIR_ROUNDS = 3;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** One grant pattern matched against one listed name — the turn loop's own rule (exact, or `*` prefix). */
const patternCovers = (pattern: string, name: string): boolean =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

const refuse = (refusal: CompletionsRefusal, message: string): Record<string, unknown> => ({
  ok: false,
  refusal,
  message,
});

// ── The invoker ──────────────────────────────────────────────────────────────────────────────────

/** A bare in-house grant `x` addresses the engine server's tool `mcp__coltrane__x` (#204); an
 *  already-namespaced grant (`mcp__<server>__<tool>`, including a `*` prefix) is kept verbatim. This
 *  is the SAME bridge resolveAgentGrants applies internally — sharing the one constant keeps the
 *  bare-slug/namespaced-surface split (#204) from drifting without dragging a provider registry into
 *  this invoker's options. */
function mapGrant(grant: string): string {
  return mcpServerOf(grant) ? grant : `mcp__${ENGINE_MCP_SERVER}__${toolBaseName(grant)}`;
}

export function makeCompletionsInvoker(opts: CompletionsInvokerOptions): AgentInvoker {
  const port = makeChatCompletionsPort({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPLETIONS_TIMEOUT_MS;

  return async (ctx: AgentInvocationContext): Promise<Record<string, unknown>> => {
    const grants = ctx.agent.allowed_tools ?? [];

    // (1) HOST BUILTINS ARE REFUSED BY NAME, before anything is spent. Naming the tool is the
    // difference between a usable refusal and a shrug — and refusing before the wire means a
    // misconfigured chair costs nothing to discover.
    const host = grants.filter((g) => isHostBuiltin(g));
    if (host.length > 0) {
      return refuse(
        "host_tool_denied",
        `agent "${ctx.agent.slug}" grants host builtin(s) [${host.join(", ")}], which this invoker ` +
          `does not carry — its hands are MCP tools only, which arrive governed by the server that ` +
          `serves them. Run this chair on the host-tool invoker, or narrow its grants.`,
      );
    }

    // (2) Grants with no source to satisfy them: a chair advertising tools it cannot reach would
    // confabulate. Absent must mean DECLINE.
    if (grants.length > 0 && !opts.tools) {
      return refuse(
        "no_tool_source",
        `agent "${ctx.agent.slug}" grants [${grants.join(", ")}] but no MCP tool source is wired — ` +
          `a deployment supplies it. Refusing rather than running the chair without its hands.`,
      );
    }

    const sealViaWrite = opts.sealVia === "output_write";
    if (sealViaWrite && !opts.tools) {
      return refuse(
        "no_tool_source",
        `agent "${ctx.agent.slug}" seals through output_write, but no tool source is wired to serve it — ` +
          `a seat that cannot reach the write boundary cannot seal.`,
      );
    }

    // (3) The tier must resolve to a concrete model. Guessing one spends real money against a
    // model nobody chose.
    const tier = ctx.agent.model_tier as ModelTier | undefined;
    const model = tier ? opts.tierMap?.[tier] : undefined;
    if (!model) {
      return refuse(
        "unresolved_tier",
        `no model configured for tier "${String(tier ?? "(none)")}" — the tier map is supplied by the ` +
          `deployment, and an unmapped tier is a misconfiguration, not a default.`,
      );
    }

    const types = ctx.output_types?.length ? ctx.output_types : ctx.agent.output_types;
    const single = types.length === 1 ? promptSchemaFor(opts.registry, types[0]) : undefined;
    const many =
      types.length > 1
        ? Object.fromEntries(types.map((t) => [t, promptSchemaFor(opts.registry, t)]))
        : undefined;
    // THE OFFERED SET. The chair's grants — narrowed by the room when the chair sits in one (the SAME
    // venueEffectiveTools oracle claude_invoker uses, never a re-inlined intersection) — mapped so a
    // bare in-house grant addresses the engine server's tool. Those mapped grants ARE the loop's allow
    // list, whichever server serves the tool: a grant is the chair's ceiling, and a tool the source
    // lists but the chair never named is not authorization to offer it. The loop offers exactly
    // `listed ∩ allow`, re-sent byte-identical every round, and refuses any call outside it before it
    // reaches source.
    const chairGrants = ctx.venue ? venueEffectiveTools(ctx.agent, ctx.venue) : grants;
    const allow = [...new Set([...chairGrants.map(mapGrant), ...(sealViaWrite ? [OUTPUT_WRITE_TOOL] : [])])];

    // A grant the source does not LIST would be silently not offered — the seat would run without a
    // hand it was promised. Refuse before any model call, naming what is missing.
    if (opts.tools && allow.length > 0) {
      const listed = (await opts.tools.list()).map((t) => t.name);
      const unprovided = allow.filter((p) => !listed.some((n) => patternCovers(p, n)));
      if (unprovided.length > 0) {
        return refuse(
          "no_tool_source",
          `agent "${ctx.agent.slug}" is granted [${unprovided.join(", ")}], which the wired tool source ` +
            `does not provide — refusing rather than running the chair without a hand it was promised.`,
        );
      }
    }

    // THE WRITE BOUNDARY, per invocation. Every output_write the seat makes is pinned to THIS chair —
    // its gig, its agent, its phase, and one of the types it seals (a single-output chair may omit the
    // type) — and recorded with the boundary's verdict. What passed is the seal; nothing else is.
    const sealTypes = ctx.output_types?.length ? ctx.output_types : ctx.agent.output_types;
    const coreOf = (t: string): string =>
      (CORE_TYPES as readonly string[]).includes(t) ? t : (opts.registry?.listTypes().find((d) => d.slug === t)?.extends ?? "");
    const writes: Array<{ domain_type: string; data: unknown; ok: boolean; error?: string }> = [];
    const source: ToolSource | undefined = !opts.tools
      ? undefined
      : !sealViaWrite
        ? (opts.tools as ToolSource)
        : {
            list: (opts.tools as ToolSource).list,
            call: async (name, args) => {
              if (toolSlugOf(name) !== "output_write") return opts.tools!.call(name, args);
              const asked = typeof args["domain_type"] === "string" ? (args["domain_type"] as string) : "";
              const dt = asked !== "" ? asked : sealTypes.length === 1 ? sealTypes[0]! : "";
              if (!sealTypes.includes(dt)) {
                const error = `this chair seals only [${sealTypes.join(", ")}] — "${dt}" is not one of them. Call output_write with one of those domain_types.`;
                writes.push({ domain_type: dt, data: args["data"], ok: false, error });
                return { ok: false, error };
              }
              const r = await opts.tools!.call(name, {
                ...args, domain_type: dt, core_type: coreOf(dt),
                gig_id: ctx.gig_id ?? "", agent_slug: ctx.agent.slug, phase: ctx.phase,
              });
              const ok = isObj(r) && r["ok"] === true;
              writes.push({ domain_type: dt, data: args["data"], ok, ...(!ok && isObj(r) ? { error: String(r["error"] ?? "") } : {}) });
              return r;
            },
          };
    const seal: OutputWriteSeal | undefined = sealViaWrite
      ? {
          via: "output_write", gig_id: ctx.gig_id ?? "", agent_slug: ctx.agent.slug, phase: ctx.phase,
          core_by_type: Object.fromEntries(sealTypes.map((t) => [t, coreOf(t)])),
        }
      : undefined;

    // THE ROUND CAP. Chair budget, then the agent's own cap, then the invoker default, then the
    // engine default — the turn-budget contract's order. `ctx.turn_budget === 0` is a deliberate hard
    // floor and does NOT fall through (0 is not nullish).
    const maxRounds =
      ctx.turn_budget ?? ctx.agent.max_tool_calls ?? opts.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    // contract-completions-seat-transcript-v1 — the seat's conversation lives in a store keyed by its
    // (gig_id, role) session id, the SAME id the Claude door resumes under. A MAKER amend (`resume`,
    // and NOT `resume_keep_prompt` — a re-verify keeps the full cold prompt, out of scope) resumes that
    // saved transcript; everything else — a first invocation, a re-verify — seeds exactly the full
    // prompt buildPrompt returns and never reads the store (I2's "only a resume reads" half).
    const store = opts.transcripts;
    const sid = sessionUuidFor(ctx.gig_id, ctx.role);
    const isMakerAmend = ctx.resume === true && ctx.resume_keep_prompt !== true;
    const loaded = isMakerAmend && store && sid ? store.load(sid) : undefined;
    let seed: TurnMessage[];
    if (isMakerAmend && loaded && loaded.length > 0) {
      // O2 / I1 — re-send the saved transcript UNCHANGED as the prefix (a provider prefix cache can
      // serve it), then EXACTLY ONE new user message: the trimmed amend prompt buildPrompt returns on a
      // resume (its one new thing is the failing verdict). Append-only over the prior round.
      seed = [...loaded, { role: "user", content: buildPrompt(ctx, single, many, seal) }];
    } else if (isMakerAmend) {
      // F1 — a maker amend with no saved transcript (no store wired, or nothing under this id) has no
      // conversation to resume. Seed the FULL cold prompt (buildPrompt with resume OFF: identity,
      // method, gig input) — NEVER the resume-only prompt that claims a conversation the seat does not
      // hold — and emit the SAME `resume_fallback` event the Claude invoker does, which the runtime
      // folds into chair_complete.resume_fallback. The chair does not fail for this.
      seed = [{ role: "user", content: buildPrompt({ ...ctx, resume: false }, single, many, seal) }];
      ctx.onEvent?.({
        type: "resume_fallback",
        raw: {
          agent: ctx.agent.slug,
          session_id: sid,
          resumed: false,
          reason:
            "no saved transcript for this session — re-seeding cold with the full prompt rather than " +
            "the resume-only prompt, which would claim a conversation that is not held",
        },
      });
    } else {
      seed = [{ role: "user", content: buildPrompt(ctx, single, many, seal) }];
    }
    const turnOpts = {
      port,
      model,
      ...(source ? { tools: source } : {}),
      allow,
      max_rounds: maxRounds,
      timeout_ms: timeoutMs,
      // contract-tool-wire-name-collision-v1 (O2) — hand the loop the SAME encoding the port speaks, so
      // it refuses an offered set two of whose tools collapse to one wire name before any model call.
      wire_name: encodeToolName,
      // #seat-effort (O4) — carry the resolved effort onto the model request. The runtime set it on
      // the ctx (resolveEffort); the provider wire mapping is a lower layer, out of scope.
      ...(ctx.effort ? { effort: ctx.effort } : {}),
      // contract-seat-context-ceiling-v1 (O3) — hand the resolved ceiling to runTurn, which stops
      // `context_limit` the round its measured context crosses it. Absent ⇒ nothing passed, so the turn
      // runs uncapped exactly as today (I1).
      ...(ctx.max_context_tokens !== undefined ? { max_context_tokens: ctx.max_context_tokens } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(opts.prices ? { prices: opts.prices } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
    const turns: TurnResult[] = [await runTurn(seed, turnOpts)];

    // THE CHANNEL REPAIR — once. A seat that finished its turn without ever calling output_write
    // answered on the wrong channel; its work is still in the transcript, so one short continuation
    // is enough to make the call. Not for a seat that knocked and was refused (it already had its
    // correction in-band, and re-prompting it is the loop the governor rejected), and not for a typed
    // stop (a seat out of rounds gets no more rounds here).
    if (sealViaWrite && writes.length === 0 && turns[0]!.stop === "done") {
      const calls = sealTypes
        .map((t) => `  output_write({ "domain_type": "${t}", "data": <your result> })`)
        .join("\n");
      ctx.onEvent?.({
        type: "seal_boundary_repair",
        raw: { agent: ctx.agent.slug, unsealed: [...sealTypes], note: "the seat finished without calling output_write; continued ONCE to seal" },
      });
      const correction =
        `STOP — your turn finished but sealed NOTHING. Not one output_write call was made for ` +
        `[${sealTypes.join(", ")}]. Text is not sealed; it will be discarded.\n\n` +
        `Do NOT redo the work. Seal it now by calling output_write — the only channel that seals:\n${calls}\n\n` +
        `This is the LAST attempt.`;
      turns.push(await runTurn([...turns[0]!.messages, { role: "user", content: correction }], { ...turnOpts, max_rounds: SEAL_REPAIR_ROUNDS }));
    }
    const result = turns[turns.length - 1]!;

    // O1 — save the seat's transcript under its (gig_id, role) session id AFTER the turn, whatever the
    // stop, so a later maker amend resumes the conversation it actually had. runTurn.messages is the
    // seed plus everything appended this turn (a new array). No store or no session id ⇒ nothing saved.
    if (store && sid) store.save(sid, result.messages);

    // Settle what RAN, whatever the stop. The full prompt (uncached input + cache reads + cache
    // writes) preserves GigUsage.input_tokens' "whole prompt" meaning — reporting the uncached part
    // alone would silently narrow the field, unseen by any fixture that caches nothing. Cost is
    // emitted ONLY when every round was priced; a round the transport left unpriced or unreported is
    // never folded in as $0 (#235). The per-model breakdown is keyed by the model the transport
    // NAMED as serving the round, never the configured tier.
    // Every turn this invocation ran — the repair turn's rounds were spent too, and a round spent and
    // not settled is the defect #235 names.
    const allRounds = turns.flatMap((t) => t.rounds);
    const sum = (k: "input_tokens" | "cache_read_tokens" | "cache_write_tokens" | "output_tokens" | "cost_usd"): number =>
      turns.reduce((n, t) => n + t.totals[k], 0);
    const totalInput = sum("input_tokens") + sum("cache_read_tokens") + sum("cache_write_tokens");
    const totalOutput = sum("output_tokens");
    const byModel: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
    for (const r of allRounds) {
      if (r.model === undefined || r.usage === undefined) continue;
      const slot = (byModel[r.model] ??= { inputTokens: 0, outputTokens: 0, costUSD: 0 });
      slot.inputTokens +=
        (r.usage.input_tokens ?? 0) + (r.usage.cache_read_tokens ?? 0) + (r.usage.cache_write_tokens ?? 0);
      slot.outputTokens += r.usage.output_tokens ?? 0;
      slot.costUSD += r.cost_usd ?? 0;
    }
    const everyRoundPriced =
      allRounds.length > 0 && allRounds.every((r) => r.cost_usd !== undefined);
    if (totalInput > 0 || totalOutput > 0) {
      ctx.onEvent?.({
        type: "result",
        raw: {
          usage: { input_tokens: totalInput, output_tokens: totalOutput },
          ...(everyRoundPriced ? { total_cost_usd: sum("cost_usd") } : {}),
          ...(Object.keys(byModel).length > 0 ? { modelUsage: byModel } : {}),
        },
      });
    }

    // THE SEAL, on the output_write path: every write the boundary ACCEPTED, as a list per type (a
    // chair may seal many records of one type; the runtime seals one record per element). What passed
    // is kept even if the turn then hit a typed stop — the boundary already adjudicated it good.
    if (sealViaWrite) {
      const blob: Record<string, unknown[]> = {};
      for (const w of writes) {
        if (!w.ok) continue;
        const list = (blob[w.domain_type] ??= []);
        if (list.length >= MAX_SEALED_RECORDS_PER_TYPE) {
          throw new Error(
            `chair sealed more than MAX_SEALED_RECORDS_PER_TYPE (${MAX_SEALED_RECORDS_PER_TYPE}) records of type ` +
              `"${w.domain_type}" — refusing the surplus loudly rather than dropping it.`,
          );
        }
        list.push(w.data);
      }
      if (Object.keys(blob).length > 0) return blob;
    }

    // A typed stop is a NAMED refusal, never a throw and never a parse of empty content. The runtime
    // reads `{ok:false, refusal, message}` and fails the chair with the reason, so running out of
    // rounds no longer falls through to "the model produced no answer".
    if (result.stop === "round_limit") {
      return refuse(
        "round_limit",
        `chair "${ctx.agent.slug}" ran ${result.totals.rounds} model round(s) — its turn budget of ` +
          `${maxRounds} — without answering. Raise the chair's turn_budget or the agent's ` +
          `max_tool_calls, or narrow the work.`,
      );
    }
    if (result.stop === "timeout") {
      return refuse("timeout", `a model call exceeded the ${timeoutMs}ms per-call timeout.`);
    }
    if (result.stop === "aborted") {
      return refuse("aborted", `the invocation was aborted by its caller before the chair answered.`);
    }
    if (result.stop === "transport_failed") {
      return refuse(
        "transport_failed",
        `the completions endpoint failed: ${result.error ?? "no reason reported"}`,
      );
    }
    // contract-tool-wire-name-collision-v1 (O2) — the offered set held two tools indistinguishable on
    // the wire. A TYPED refusal naming the colliding tools, caught before any model call, never an
    // insertion-order winner and never a sealed partial.
    if (result.stop === "tool_name_collision") {
      return refuse(
        "tool_name_collision",
        `chair "${ctx.agent.slug}" was offered tools that collide on the wire: ` +
          `${result.error ?? "two tools encode to one wire name"}. Two tools that map to one wire ` +
          `name cannot be told apart; refusing rather than running whichever won the reverse map.`,
      );
    }
    // contract-seat-context-ceiling-v1 (O4) — a context_limit stop is a TYPED refusal that names the
    // context tokens reached (the loop's peak) and the declared ceiling; it NEVER falls through to
    // extractJson, so no partial answer is sealed as complete.
    if (result.stop === "context_limit") {
      return refuse(
        "context_limit",
        `chair "${ctx.agent.slug}" crossed its context ceiling: reached ` +
          `${result.totals.peak_context_tokens} context token(s) against a ceiling of ` +
          `${ctx.max_context_tokens}. No partial answer is sealed; raise the seat's ` +
          `max_context_tokens or narrow the work.`,
      );
    }

    if (sealViaWrite) {
      const last = [...writes].reverse().find((w) => !w.ok);
      return refuse(
        "no_seal",
        `chair "${ctx.agent.slug}" sealed nothing: ` +
          (writes.length === 0
            ? `it never called output_write, including after its one repair turn. Its text was not sealed.`
            : `none of its ${writes.length} output_write call(s) passed the boundary` +
              (last?.error ? ` — the last was refused: ${last.error}` : ".")),
      );
    }
    return extractJson(result.text, extractOptionsForChair(types, single));
  };
}
