// The completions-invoker contract AS TYPES, plus a runtime loader for the not-yet-authored
// src/completions_invoker.ts. Shared by tests/spec_completions_*.test.ts.
//
// The loader specifier is a runtime URL, not a string literal, so tsc does not resolve it and the
// shared build stays green while the module is absent — and a THROWING PROXY keeps every law
// individually executable, so each fails where it asserts rather than the whole file failing to
// collect and reporting its laws as `skipped`. Same technique as spec_reside_fixtures.ts, and for
// the same reason: laws that never ran must not read as legitimate.

import type { AgentInvoker } from "../src/runtime.js";
import type { ModelTier } from "../src/pricing.js";
import type { Registry } from "../src/registry.js";

/** One MCP tool as its server advertises it. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The hands. A deployment supplies this; the engine ships the loop and the refusals. */
export interface McpToolSource {
  list: () => Promise<readonly McpToolDef[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** The OpenAI function-calling shape an MCP tool converts into. */
export interface FunctionDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface CompletionsInvokerOptions {
  /** OpenAI-compatible base URL. No provider is named in the engine — this is the whole point. */
  baseUrl: string;
  apiKey: string;
  registry?: Registry | undefined;
  /** ModelTier → concrete model id. Deployment-defined; no names hardcoded in the engine. */
  tierMap?: Partial<Record<ModelTier, string>> | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  /** Absent = a chair with any tool grant is refused; the loop needs hands to run one. */
  tools?: McpToolSource | undefined;
  /** Served model id → USD per million tokens (turn-loop spec). Absent = spend is unpriced, not free. */
  prices?: Readonly<Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }>> | undefined;
}

/** Typed, never thrown. `hosted_unsupported` is deliberately not reused for any of these. */
export type CompletionsRefusal =
  | "host_tool_denied"
  | "no_tool_source"
  | "transport_failed"
  | "unresolved_tier"
  // The turn loop's typed stops, surfaced as refusals (docs/specs/turn-loop.red-spec.md).
  | "round_limit"
  | "timeout"
  | "aborted";

export interface CompletionsModule {
  makeCompletionsInvoker(opts: CompletionsInvokerOptions): AgentInvoker;
  /** MCP tool → OpenAI function definition. Pure, so the round-trip is a law. */
  toFunctionDef(tool: McpToolDef): FunctionDef;
  /** MCP name -> a wire-legal function name. Lossless AND within the 64-char bound. */
  encodeToolName(name: string): string;
  /** The inverse read: a function name back to the MCP tool name it addresses. */
  fromFunctionName(name: string): string;
  COMPLETIONS_REFUSALS: readonly CompletionsRefusal[];
}

export async function loadCompletions(): Promise<CompletionsModule> {
  const href = new URL("../src/completions_invoker.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as CompletionsModule;
  } catch (cause) {
    const why =
      `src/completions_invoker.ts does not exist yet — this law is RED until the invoker is ` +
      `authored to the surface in spec_completions_fixtures.ts ` +
      `[${String((cause as Error)?.message ?? cause).slice(0, 100)}]`;
    return new Proxy({} as CompletionsModule, {
      get(_t, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        throw new Error(`${String(prop)}: ${why}`);
      },
    });
  }
}

/** A chat-completions transport that records what it was asked and replays canned turns. */
export function fakeCompletions(turns: readonly unknown[], status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let i = 0;
  const fn = (async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** An assistant turn that just answers. */
export function saysJson(obj: unknown, usage?: Record<string, unknown>) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
    model: "test-model-x",
    ...(usage ? { usage } : {}),
  };
}

/** An assistant turn that calls a tool. */
export function callsTool(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    model: "test-model-x",
  };
}

/** A tool source that records every call and answers canned results. */
export function recordingTools(defs: readonly McpToolDef[], answers: Record<string, unknown> = {}) {
  const called: { name: string; args: Record<string, unknown> }[] = [];
  const source: McpToolSource = {
    list: async () => defs,
    call: async (name, args) => {
      called.push({ name, args });
      return answers[name] ?? { ok: true };
    },
  };
  return { source, called };
}
