// The chat-completions wire adapter: a `ModelPort` for the function-calling chat API. It is the ONE
// place that speaks the wire — the loop above it is provider-neutral, and this file turns a neutral
// `ModelRequest` into an HTTP call and a wire reply back into a neutral `ModelReply`.
//
// It NAMES NO VENDOR and READS NO ENVIRONMENT (law 18). The base URL, the key and the fetch
// implementation all arrive through the factory's `opts`; a deployment that wants a different
// endpoint supplies a different base URL, and the engine hardcodes none.
//
// It owns tool-name encoding AND decoding (law 17). Wire function names are constrained to
// `[A-Za-z0-9_-]{1,64}`; MCP names are not. Outbound, a name is encoded to a wire-legal form;
// inbound, a reply's tool calls are decoded back to the MCP name — resolved through the offered
// list when possible, so even a name too long to invert stays callable.
import type {
  ModelPort,
  ModelReply,
  ModelRequest,
  ToolCall,
  ToolDef,
  TurnMessage,
  TurnUsage,
} from "./turn_loop.js";

// ── MCP ↔ function-calling, losslessly ───────────────────────────────────────────────────────────
//
// A readable name survives unchanged (the model reasons better about `mcp__coltrane__output_query`
// than about a hex blob), and anything else is escaped reversibly. A name too long for either form
// is truncated with a digest — legal and collision-resistant, but no longer invertible on its own,
// which is why the reply is resolved through the offered list rather than by inverting the name.

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ESCAPE = "x0_";
/** The wire's own bound on a function name. Legality is a SEPARATE property from losslessness — a
 *  round-trip law proves the second and says nothing about the first, which is how a 68-character
 *  name came to encode to 139 and pass every test. */
const NAME_LIMIT = 64;
const TRUNC = "x1_";

/** One tool as the function-calling wire expects it. */
export interface FunctionDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

/** A short deterministic digest, so two distinct long names cannot collapse onto one wire name. */
function shortDigest(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36).padStart(7, "0") + h2.toString(36).padStart(7, "0");
}

/**
 * An MCP name → a name the wire will actually accept: `[A-Za-z0-9_-]{1,64}`.
 *
 * Three tiers, and the third is the one this needed. A safe short name passes through unchanged,
 * because a model reasons better about `mcp__coltrane__output_query` than about a hex blob. Anything
 * else is hex-escaped, which is reversible. And a name too long for EITHER form is truncated with a
 * digest — legal and collision-resistant, but no longer invertible on its own.
 *
 * That last tier is why the caller resolves replies through the tool list it holds rather than by
 * inverting the name: a long-named tool stays callable instead of being refused for the shape of its
 * name.
 */
export function encodeToolName(name: string): string {
  if (SAFE_NAME.test(name) && !name.startsWith(ESCAPE) && !name.startsWith(TRUNC)) return name;
  let hex = "";
  for (const byte of new TextEncoder().encode(name)) hex += byte.toString(16).padStart(2, "0");
  const escaped = ESCAPE + hex;
  if (escaped.length <= NAME_LIMIT) return escaped;
  const digest = shortDigest(name);
  const room = NAME_LIMIT - TRUNC.length - digest.length - 1;
  return `${TRUNC}${hex.slice(0, Math.max(0, room))}_${digest}`;
}

export function fromFunctionName(name: string): string {
  if (!name.startsWith(ESCAPE)) return name;
  const hex = name.slice(ESCAPE.length);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

export function toFunctionDef(tool: {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}): FunctionDef {
  return {
    type: "function",
    function: {
      name: encodeToolName(tool.name),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  };
}

// ── the wire ─────────────────────────────────────────────────────────────────────────────────────

export interface ChatCompletionsPortOptions {
  /** Chat-completions base URL. `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string;
}
interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  // cache_write_tokens: tokens WRITTEN to the cache this round, a part of prompt_tokens priced at
  // their own rate (reported by a provider for models with explicit caching and cache-write pricing).
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** What the provider charged for this round, in USD ("the total amount charged to your account"). */
  cost?: number;
  // A provider that reports cache hits and misses as SEPARATE counts (rather than folding hits into
  // prompt_tokens_details.cached_tokens). Both shapes describe the same whole prompt; only the way
  // the split is reported differs.
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
interface WireReply {
  choices?: WireChoice[];
  model?: string;
  usage?: WireUsage;
}

/** A neutral transcript message → its wire shape. Assistant tool calls are encoded to wire names
 *  and their args serialized; a tool result carries its id and content. */
function toWireMessage(m: TurnMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    const out: Record<string, unknown> = { role: "assistant", content: m.content };
    if (m.tool_calls && m.tool_calls.length > 0) {
      out["tool_calls"] = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: encodeToolName(tc.name), arguments: JSON.stringify(tc.args) },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
}

/** Split the wire's `prompt_tokens` into uncached input and cache reads (law 16). A cached prompt is
 *  still the full prompt; the split is what makes the cache visible without inventing a class the
 *  wire did not report. Absent usage stays absent — an unreported round is not a zero-token one.
 *
 *  Two wire shapes report the same split. The OpenAI shape folds hits into
 *  `prompt_tokens_details.cached_tokens` and leaves `prompt_tokens` whole. A provider that reports
 *  hits and misses SEPARATELY names them `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`;
 *  there the cache hits are the hit count and the uncached input is the reported miss count directly.
 *  Either way the prompt stays whole and only the reported split differs — pricing cache hits as
 *  uncached input (the pre-cache-hit bug) would overcharge a run priced in cents.
 *
 *  Cache WRITES (`prompt_tokens_details.cache_write_tokens`) are a third part of the same
 *  prompt: taken out of the uncached input and reported as their own class, so a price table charges
 *  them at the cache-write rate. That they are a SUBSET of prompt_tokens is what the provider's documented
 *  example implies (prompt_tokens 194 with 100 written); a recorded live response settles it. */
function mapUsage(u: WireUsage | undefined): TurnUsage | undefined {
  if (!u) return undefined;
  const cached = typeof u.prompt_cache_hit_tokens === "number"
    ? u.prompt_cache_hit_tokens
    : typeof u.prompt_tokens_details?.cached_tokens === "number"
      ? u.prompt_tokens_details.cached_tokens
      : 0;
  const written = u.prompt_tokens_details?.cache_write_tokens;
  const usage: TurnUsage = {};
  if (typeof u.prompt_cache_miss_tokens === "number") usage.input_tokens = u.prompt_cache_miss_tokens;
  else if (typeof u.prompt_tokens === "number") usage.input_tokens = u.prompt_tokens - cached - (typeof written === "number" ? written : 0);
  if (cached > 0) usage.cache_read_tokens = cached;
  // A reported write count is a class of its own, even when 0: it is priced at the cache-write rate,
  // never as uncached input.
  if (typeof written === "number") usage.cache_write_tokens = written;
  if (typeof u.completion_tokens === "number") usage.output_tokens = u.completion_tokens;
  return usage;
}

function mapStop(finish: string | undefined): ModelReply["stop"] {
  switch (finish) {
    case "stop":
      return "end";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return finish ? "other" : undefined;
  }
}

/**
 * Build a `ModelPort` bound to one chat-completions endpoint. Each call POSTs the request and turns
 * the reply into a neutral `ModelReply`; a non-2xx response THROWS with its status, so the loop can
 * type it as `transport_failed` rather than the port swallowing it into a shrug.
 */
/** The engine's effort levels (EffortSchema) → the provider's `reasoning.effort` scale. */
function wireEffort(effort: string): "low" | "medium" | "high" {
  return effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
}

export function makeChatCompletionsPort(opts: ChatCompletionsPortOptions): ModelPort {
  const doFetch = opts.fetchFn ?? fetch;
  // Strip trailing '/' in LINEAR time (CodeQL js/polynomial-redos, PR #534). The old `/\/+$/` regex
  // retries its slash run from every start position, so a long run of INTERIOR slashes backtracks
  // quadratically (measured 2,707 ms at 40,000 slashes). A backward char-code scan (47 === '/') is
  // linear by construction and touches only the trailing run — interior slashes and the rest of the
  // URL are left exactly as given.
  let end = opts.baseUrl.length;
  while (end > 0 && opts.baseUrl.charCodeAt(end - 1) === 47) end--;
  const url = `${opts.baseUrl.slice(0, end)}/chat/completions`;

  return async (req: ModelRequest): Promise<ModelReply> => {
    // contract-tool-wire-name-collision-v1 (O3) — before building the reverse map or fetching, check
    // that the request's tools INVERT: two tools that encode to one wire name would be sent as two
    // identical function definitions, and `new Map(entries)` silently keeps only the last, so a reply
    // naming that wire name resolves to whichever tool won. Fail closed HERE, the reachable layer the
    // K6 witness named — throw (as this port's other unrecoverable argument faults do), naming both
    // tools and the wire name they collapsed onto; never build the map from a set it cannot invert.
    const wireNames = req.tools.map((t: ToolDef) => encodeToolName(t.name));
    if (new Set(wireNames).size !== wireNames.length) {
      const byWire = new Map<string, string[]>();
      req.tools.forEach((t: ToolDef, i: number) => {
        const w = wireNames[i]!;
        const names = byWire.get(w);
        if (names) names.push(t.name);
        else byWire.set(w, [t.name]);
      });
      const detail = [...byWire.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([w, names]) => `${names.join(", ")} → ${w}`)
        .join("; ");
      throw new Error(
        `chat-completions tools collide on the wire (indistinguishable to the model): ${detail}. ` +
          `Refusing rather than resolving a reply to whichever tool won the reverse map.`,
      );
    }

    // The offered list is the authority on what a wire name means: build the reverse map from it so
    // a reply resolves to the MCP name even when that name was too long to invert.
    const byWireName = new Map(req.tools.map((t: ToolDef) => [encodeToolName(t.name), t.name]));

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWireMessage),
      ...(req.tools.length > 0 ? { tools: req.tools.map(toFunctionDef) } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      // The seat's reasoning effort, on the wire's low/medium/high scale. A reasoning model spends its
      // reasoning INSIDE max_tokens (measured 22 Sep): without a bound it can spend all of it and return
      // null content. Levels above `high` saturate there, never an unknown value.
      ...(req.effort !== undefined ? { reasoning: { effort: wireEffort(req.effort) } } : {}),
    };

    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`chat completions ${res.status}: ${text.slice(0, 300)}`);
    }

    const wire = (await res.json()) as WireReply;
    const choice = wire.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
      const wireName = tc.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      return { id: tc.id ?? "", name: byWireName.get(wireName) ?? fromFunctionName(wireName), args };
    });

    const reply: ModelReply = {
      message: {
        content: message.content ?? null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    };
    if (typeof wire.model === "string") reply.model = wire.model;
    const usage = mapUsage(wire.usage);
    if (usage !== undefined) reply.usage = usage;
    // The provider's own charge, when it reports one. A reported 0 is a known price; an absent cost
    // is not 0 — the loop falls back to the price table, or leaves the round unpriced.
    if (typeof wire.usage?.cost === "number") reply.cost_usd = wire.usage.cost;
    const stop = mapStop(choice?.finish_reason);
    if (stop !== undefined) reply.stop = stop;
    return reply;
  };
}
