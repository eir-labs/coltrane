// The shared turn loop's contract AS TYPES, plus runtime loaders for the not-yet-authored
// src/turn_loop.ts and src/chat_completions_port.ts. Shared by tests/spec_turn_loop.test.ts.
//
// Same technique as spec_completions_fixtures.ts: the specifier is a runtime URL so tsc stays green
// while the modules are absent, and a THROWING PROXY keeps every law individually executable — each
// fails where it asserts, instead of the file failing to collect and its laws reading as skipped.

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
  /** Fires on the caller's abort OR the per-call timeout, whichever comes first. */
  signal: AbortSignal;
}

export interface ModelReply {
  /** The model the transport says SERVED this round. */
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

export type TurnStop = "done" | "round_limit" | "timeout" | "aborted" | "transport_failed";

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
  /** Per model call. Applies whether or not `signal` is supplied. */
  timeout_ms?: number;
  signal?: AbortSignal;
  prices?: PriceTable;
  max_tokens?: number;
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

export interface TurnLoopModule {
  runTurn(messages: readonly TurnMessage[], opts: TurnLoopOptions): Promise<TurnResult>;
  TURN_STOPS: readonly TurnStop[];
}

export interface ChatCompletionsPortOptions {
  /** Chat-completions base URL. `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

export interface ChatPortModule {
  makeChatCompletionsPort(opts: ChatCompletionsPortOptions): ModelPort;
}

function absent<T extends object>(file: string, cause: unknown): T {
  const why =
    `${file} does not exist yet — this law is RED until it is authored to the surface in ` +
    `spec_turn_loop_fixtures.ts [${String((cause as Error)?.message ?? cause).slice(0, 100)}]`;
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      throw new Error(`${String(prop)}: ${why}`);
    },
  });
}

export async function loadTurnLoop(): Promise<TurnLoopModule> {
  const href = new URL("../src/turn_loop.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as TurnLoopModule;
  } catch (cause) {
    return absent<TurnLoopModule>("src/turn_loop.ts", cause);
  }
}

export async function loadChatPort(): Promise<ChatPortModule> {
  const href = new URL("../src/chat_completions_port.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as ChatPortModule;
  } catch (cause) {
    return absent<ChatPortModule>("src/chat_completions_port.ts", cause);
  }
}

/** A port that replays scripted replies and records a SNAPSHOT of every request it was sent. */
export function scriptedPort(
  script: readonly ModelReply[] | ((req: ModelRequest, i: number) => ModelReply | Promise<ModelReply>),
) {
  const requests: { model: string; messages: TurnMessage[]; tools: ToolDef[] }[] = [];
  const port: ModelPort = async (req) => {
    // A snapshot, not a reference: if the loop later mutates what it sent, this still shows what
    // was actually on the wire at the time.
    requests.push({
      model: req.model,
      messages: JSON.parse(JSON.stringify(req.messages)) as TurnMessage[],
      tools: JSON.parse(JSON.stringify(req.tools)) as ToolDef[],
    });
    const i = requests.length - 1;
    return typeof script === "function" ? script(req, i) : script[Math.min(i, script.length - 1)]!;
  };
  return { port, requests };
}

export const user = (content: string): TurnMessage => ({ role: "user", content });

export function answers(text: string, usage?: TurnUsage, model = "m-1"): ModelReply {
  return { model, message: { content: text }, ...(usage ? { usage } : {}), stop: "end" };
}

export function calls(
  name: string,
  args: Record<string, unknown>,
  id = "t1",
  usage?: TurnUsage,
  model = "m-1",
): ModelReply {
  return { model, message: { content: null, tool_calls: [{ id, name, args }] }, ...(usage ? { usage } : {}), stop: "tool_use" };
}

/** A port that hangs until its request signal fires, or answers after `lateMs` if it never does. */
export function hangingPort(lateMs = 1500): ModelPort {
  return (req) =>
    new Promise<ModelReply>((resolve, reject) => {
      const late = setTimeout(() => resolve(answers("answered late — nothing stopped the call")), lateMs);
      req.signal.addEventListener("abort", () => {
        clearTimeout(late);
        reject(new Error("request signal fired"));
      });
    });
}
