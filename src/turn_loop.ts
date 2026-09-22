// The shared turn loop: one place a seat takes turns, a model thinks, tools run, and spend is
// counted. Spec: docs/specs/turn-loop.red-spec.md. Three callers — gig chairs, residents and the
// terminal — want the same four things, and the loop the completions invoker carried inline did
// each of them badly: it counted only the last round, offered every tool the source listed, lost
// its timeout whenever a caller signal existed, and parsed empty content when it ran out of rounds.
//
// The loop resolves NOTHING itself. A model call goes out through a `ModelPort` the caller supplies;
// a tool call goes back out through a `ToolSource` the caller supplies. The engine ships the loop
// and the accounting and NAMES NO PROVIDER — the port speaks the wire, the source holds the hands,
// and the deployment supplies both. Config (base URL, key, prices) arrives in `opts`; this file
// reads no environment.
//
// Why accounting is here from the first commit: a 30-day census of the operator's own transcripts
// priced ~$18.6k, 77% of it cache reads, 346k tokens of context per call. A replacement harness
// saves money only by keeping contexts small and routing turns cheaply, and neither is steerable
// without context size and cost on every round. The same fact makes the transcript APPEND-ONLY: a
// rewritten prefix forfeits the cache, and preserved-thinking models reject edited history.

/** One tool as the model sees it. MCP-shaped and provider-neutral. */
export interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The hands. The loop resolves nothing itself: every call goes back out through the source. */
export interface ToolSource {
  list: () => Promise<readonly ToolDef[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The provider-neutral transcript. APPEND-ONLY: the loop never rewrites an earlier entry. `raw` is
 * the port's own representation of an assistant turn (thinking blocks, signatures) — opaque to the
 * loop and replayed verbatim to the same port.
 */
export type TurnMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error?: boolean };

/** Token counts AS THE TRANSPORT REPORTED THEM. An absent class was not reported; it is not zero. */
export interface TurnUsage {
  /** Uncached prompt tokens. */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface ModelRequest {
  model: string;
  messages: readonly TurnMessage[];
  tools: readonly ToolDef[];
  max_tokens?: number;
  /** The seat's resolved reasoning effort (engine vocabulary). The PORT maps it onto its provider's
   *  wire; absent = send nothing and let the provider default stand. */
  effort?: string;
  /** Fires on the caller's abort OR the per-call timeout, whichever comes first. */
  signal: AbortSignal;
}

export interface ModelReply {
  /** The model the transport says SERVED this round. Absent = the round is unpriced; the requested model does not stand in. */
  model?: string;
  message: { content: string | null; tool_calls?: ToolCall[]; raw?: unknown };
  usage?: TurnUsage;
  stop?: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
}

/** One model call. May throw; the loop converts a throw into a typed stop. */
export type ModelPort = (req: ModelRequest) => Promise<ModelReply>;

/** USD per million tokens. Supplied by the deployment — the engine names no model and no price. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}
export type PriceTable = Readonly<Record<string, ModelPrice>>;

export type TurnStop =
  | "done"
  | "round_limit"
  | "timeout"
  | "aborted"
  | "transport_failed"
  | "context_limit"
  | "tool_name_collision";

/** The seven typed stops, exported so a caller can surface them without re-listing the literals. */
export const TURN_STOPS: readonly TurnStop[] = [
  "done",
  "round_limit",
  "timeout",
  "aborted",
  "transport_failed",
  "context_limit",
  "tool_name_collision",
];

export interface RoundRecord {
  round: number;
  model?: string;
  /** Absent when the transport reported no usage for this round. */
  usage?: TurnUsage;
  /** input + cache_read + cache_write. Absent when usage is absent. */
  context_tokens?: number;
  /** Absent when the served model, or a reported token class, has no price. Never a stand-in 0. */
  cost_usd?: number;
  tool_calls: string[];
}

export interface TurnTotals {
  rounds: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Sum over PRICED rounds only. Read it together with unpriced_rounds. */
  cost_usd: number;
  /** Rounds that reported usage but could not be priced. */
  unpriced_rounds: number;
  /** Rounds that reported no usage at all. */
  unreported_rounds: number;
  peak_context_tokens: number;
}

export type TurnEvent =
  | { type: "tool_use"; round: number; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; round: number; tool: string; is_error: boolean }
  | { type: "round_end"; round: number; record: RoundRecord };

export interface TurnLoopOptions {
  port: ModelPort;
  model: string;
  tools?: ToolSource;
  /** Tool names the model may see and call: exact, or a trailing `*` prefix. Absent = none. */
  allow?: readonly string[];
  /** Model calls this turn may make. */
  max_rounds: number;
  /**
   * A context ceiling in tokens. After any round whose MEASURED context (input + cache_read +
   * cache_write) exceeds this, the turn stops with `context_limit` before the next model call.
   * Absent = no ceiling: the turn is bounded only by max_rounds, the timeout, or the model
   * answering. A seat's context is the cost lever, so this is the seam that caps it.
   */
  max_context_tokens?: number;
  /** Per model call. Applies whether or not `signal` is supplied. */
  timeout_ms?: number;
  signal?: AbortSignal;
  prices?: PriceTable;
  max_tokens?: number;
  /**
   * #seat-effort (O4) — the resolved reasoning effort the seat runs at, carried on the model request
   * the completions invoker hands the loop. A provider-neutral pass-through: the loop never
   * interprets it (the level was validated upstream at the dispatch door / genome schema), and the
   * PROVIDER WIRE MAPPING of effort is a lower layer, out of scope here. Typed `string` deliberately
   * so this leaf file keeps its no-import posture; the level vocabulary lives in EffortSchema.
   */
  effort?: string;
  /**
   * contract-tool-wire-name-collision-v1 (O1) — the transport's MCP-name → wire-name encoding, supplied
   * by the caller so this leaf file keeps its no-import posture. When present, the offered set is
   * mapped through it once before the first model call; two offered tools that collapse to the same
   * wire name are a refusal (`tool_name_collision`), never sent to the model as two indistinguishable
   * function definitions. Absent = no check, and the turn behaves exactly as today.
   */
  wire_name?: (name: string) => string;
  onEvent?: (ev: TurnEvent) => void;
}

export interface TurnResult {
  stop: TurnStop;
  /** The input messages plus everything appended this turn. A new array. */
  messages: TurnMessage[];
  /** The final assistant text, "" when there is none. */
  text: string;
  rounds: RoundRecord[];
  totals: TurnTotals;
  error?: string;
}

/** A tool name is offered iff SOME allow entry matches it: exact, or a trailing `*` prefix. */
function isAllowed(name: string, allow: readonly string[]): boolean {
  for (const pattern of allow) {
    if (pattern.endsWith("*")) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

/** The pairing between a reported token class and its price key. Iterated so a reported class with
 *  no rate makes the whole round unpriced, rather than being dropped or priced at another rate. */
const PRICE_CLASSES: readonly [keyof TurnUsage, keyof ModelPrice][] = [
  ["input_tokens", "input"],
  ["output_tokens", "output"],
  ["cache_read_tokens", "cache_read"],
  ["cache_write_tokens", "cache_write"],
];

/**
 * The cost of one round, or `undefined` when it cannot be priced. A round is unpriced when the
 * transport named no served model, when the deployment supplied no price for that model, or when
 * ANY reported token class has no rate — the requested model never stands in for the served one,
 * and an unpriced class is never priced at some other rate (laws 5–6).
 */
function priceRound(
  model: string | undefined,
  usage: TurnUsage,
  prices: PriceTable | undefined,
): number | undefined {
  if (model === undefined || !prices) return undefined;
  const price = prices[model];
  if (!price) return undefined;
  let cost = 0;
  for (const [uKey, pKey] of PRICE_CLASSES) {
    const tokens = usage[uKey];
    if (tokens === undefined) continue;
    const rate = price[pKey];
    if (rate === undefined) return undefined;
    cost += (tokens * rate) / 1_000_000;
  }
  return cost;
}

/**
 * Take turns until the model answers, the rounds run out, the caller aborts, the call times out or
 * the transport fails. NEVER throws: every failure is one of the five `TurnStop`s, so a caller can
 * treat "the model answered" and "the upstream died" as two values of the same type.
 */
export async function runTurn(
  messages: readonly TurnMessage[],
  opts: TurnLoopOptions,
): Promise<TurnResult> {
  // A NEW array: the caller's transcript is never mutated (law 15). Everything this turn produces is
  // appended here, and earlier entries keep their identity so a continuation re-sends them byte for
  // byte and the cache prefix survives.
  const transcript: TurnMessage[] = [...messages];
  const rounds: RoundRecord[] = [];
  const totals: TurnTotals = {
    rounds: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    unpriced_rounds: 0,
    unreported_rounds: 0,
    peak_context_tokens: 0,
  };

  // The offered set is computed ONCE and re-sent identical every round (law 8, cache stability). No
  // allow list means no tools — absent is decline, never "offer everything the source lists".
  const listed = opts.tools ? await opts.tools.list() : [];
  const offered = opts.allow ? listed.filter((t) => isAllowed(t.name, opts.allow!)) : [];
  const offeredNames = new Set(offered.map((t) => t.name));

  // contract-tool-wire-name-collision-v1 (O1) — two OFFERED tools a seat cannot tell apart ON THE WIRE
  // are a refusal, never an insertion-order winner. When a `wire_name` encoding is supplied, map the
  // offered names through it BEFORE any model call: if two collapse onto one wire name the model would
  // be sent two identical function definitions and a reply naming that wire name could not be inverted.
  // Stop `tool_name_collision`, naming both MCP names and the wire name they share. No `wire_name` (F1),
  // or a distinct set, leaves the turn exactly as today.
  if (opts.wire_name) {
    const wire = opts.wire_name;
    const byWire = new Map<string, string[]>();
    for (const t of offered) {
      const w = wire(t.name);
      const names = byWire.get(w);
      if (names) names.push(t.name);
      else byWire.set(w, [t.name]);
    }
    const collisions = [...byWire.entries()].filter(([, names]) => names.length > 1);
    if (collisions.length > 0) {
      const detail = collisions.map(([w, names]) => `${names.join(", ")} → ${w}`).join("; ");
      return {
        stop: "tool_name_collision",
        messages: transcript,
        text: "",
        rounds,
        totals,
        error: `offered tools collide on the wire (indistinguishable to the model): ${detail}`,
      };
    }
  }

  // Default stop is round_limit: the loop that completes its rounds still tool-calling ran out.
  let stop: TurnStop = "round_limit";
  let text = "";
  let error: string | undefined;

  for (let i = 0; i < opts.max_rounds; i++) {
    const round = i + 1;

    // The per-call timeout fires EVEN when the caller supplies a signal (law 11). Both the caller's
    // abort and the timeout feed ONE controller, and that controller's signal is what the port sees
    // — the `ctx.signal ?? controller.signal` that switched the timeout off whenever a caller signal
    // existed is precisely the shape this avoids.
    const callController = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => callController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) callController.abort();
      else opts.signal.addEventListener("abort", onCallerAbort);
    }
    const timer =
      opts.timeout_ms !== undefined
        ? setTimeout(() => {
            timedOut = true;
            callController.abort();
          }, opts.timeout_ms)
        : undefined;

    let reply: ModelReply;
    try {
      reply = await opts.port({
        model: opts.model,
        messages: transcript,
        tools: offered,
        ...(opts.max_tokens !== undefined ? { max_tokens: opts.max_tokens } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        signal: callController.signal,
      });
    } catch (e) {
      // A throw is TYPED, never re-thrown (law 13). WHICH stop it is is decided by CAUSE, not by the
      // error text: a caller abort outranks a per-call timeout outranks a bare transport failure.
      if (opts.signal?.aborted) stop = "aborted";
      else if (timedOut) stop = "timeout";
      else {
        stop = "transport_failed";
        error = e instanceof Error ? e.message : String(e);
      }
      break;
    } finally {
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onCallerAbort);
    }

    // The round record: usage is MEASURED, never inferred. An absent class stays absent (no `?? 0`
    // fabrication), no usage at all is UNREPORTED (not a zero-token round), and a served model with
    // no price is UNPRICED (not $0).
    const record: RoundRecord = { round, tool_calls: [] };
    if (reply.model !== undefined) record.model = reply.model;
    const usage = reply.usage;
    if (usage !== undefined) {
      record.usage = usage;
      const contextTokens =
        (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
      record.context_tokens = contextTokens;
      totals.input_tokens += usage.input_tokens ?? 0;
      totals.output_tokens += usage.output_tokens ?? 0;
      totals.cache_read_tokens += usage.cache_read_tokens ?? 0;
      totals.cache_write_tokens += usage.cache_write_tokens ?? 0;
      if (contextTokens > totals.peak_context_tokens) totals.peak_context_tokens = contextTokens;
      const cost = priceRound(reply.model, usage, opts.prices);
      if (cost !== undefined) {
        record.cost_usd = cost;
        totals.cost_usd += cost;
      } else {
        totals.unpriced_rounds += 1;
      }
    } else {
      totals.unreported_rounds += 1;
    }

    // Append the assistant turn append-only: content, any tool calls, and the port's opaque `raw`
    // replayed verbatim so a preserved-thinking continuation is byte-identical.
    const toolCalls = reply.message.tool_calls ?? [];
    const assistantMsg: TurnMessage = {
      role: "assistant",
      content: reply.message.content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(reply.message.raw !== undefined ? { raw: reply.message.raw } : {}),
    };
    transcript.push(assistantMsg);
    rounds.push(record);
    totals.rounds += 1;

    if (toolCalls.length === 0) {
      stop = "done";
      text = reply.message.content ?? "";
      opts.onEvent?.({ type: "round_end", round, record });
      break;
    }

    // CONTEXT CEILING. This round's MEASURED context crossed the ceiling; the turn stops here, before
    // another model call is made. AFTER the done-check (a model that has answered needs no ceiling)
    // and BEFORE the tool calls run — a turn over its context budget does no more work.
    if (
      opts.max_context_tokens !== undefined &&
      record.context_tokens !== undefined &&
      record.context_tokens > opts.max_context_tokens
    ) {
      stop = "context_limit";
      opts.onEvent?.({ type: "round_end", round, record });
      break;
    }

    // Run the calls. A call to a tool that was NEVER offered does not reach the source (law 9): it
    // is answered with an is_error tool result naming the tool, so the model can recover, and the
    // source is untouched. Events fire LIVE, before the next model call (law 14).
    for (const call of toolCalls) {
      record.tool_calls.push(call.name);
      opts.onEvent?.({ type: "tool_use", round, tool: call.name, args: call.args });
      let content: string;
      let isError = false;
      if (!offeredNames.has(call.name) || !opts.tools) {
        isError = true;
        content = `tool "${call.name}" was not offered to this turn and was not called`;
      } else {
        try {
          const result = await opts.tools.call(call.name, call.args);
          content = typeof result === "string" ? result : JSON.stringify(result);
        } catch (e) {
          isError = true;
          content = `tool "${call.name}" failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      opts.onEvent?.({ type: "tool_result", round, tool: call.name, is_error: isError });
      transcript.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content,
        ...(isError ? { is_error: true } : {}),
      });
    }

    opts.onEvent?.({ type: "round_end", round, record });
  }

  return {
    stop,
    messages: transcript,
    text,
    rounds,
    totals,
    ...(error !== undefined ? { error } : {}),
  };
}
