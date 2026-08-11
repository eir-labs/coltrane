// The Bifrost AgentInvoker — the model-port swap that makes the runtime
// model-agnostic. Same pure prompt stack as the Claude invoker (buildPrompt) and
// the same tolerant parse (extractJson); only the cognition transport differs:
// an HTTP call to a Bifrost deployment's /v1/generate instead of a `claude` CLI
// subprocess. v0 is deliberately text-in/JSON-out — no tools, no MCP; a chair
// that needs tools keeps the Claude invoker. Zero new dependencies (global fetch).
import type { AgentInvocationContext, AgentInvoker } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { ModelTier } from "./pricing.js";
import {
  buildPrompt,
  extractJson,
  extractOptionsForChair,
  promptSchemaFor,
} from "./claude_invoker.js";

// One model invocation's wall-clock bound. Far below the Claude invoker's 10min
// chair bound: this path is a single completion, not a tool-using child.
export const DEFAULT_BIFROST_TIMEOUT_MS = 60_000;

export interface BifrostInvokerOptions {
  /** Bifrost base URL, e.g. https://bifrost.example — /v1/generate is appended. */
  url: string;
  /** The deployment's device token (rides in the request body, Bifrost-style). */
  deviceToken: string;
  /** Resolves each output type's JSON schema into the prompt (same as Claude invoker). */
  registry?: Registry | undefined;
  /**
   * ModelTier → Bifrost tier-string mapping. Bifrost tier names are
   * deployment-defined passthroughs (context.override_tier), so no names are
   * hardcoded here. An unmapped tier omits override_tier — Bifrost's own
   * default (economy-class) routing applies.
   */
  tierMap?: Partial<Record<ModelTier, string>> | undefined;
  /** Per-invocation token budget sent to Bifrost. Default 700 (Bifrost's own default). */
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  /** Injectable transport (tests). Default: global fetch. */
  fetchFn?: typeof fetch | undefined;
}

// The /v1/generate response envelope (what this invoker reads of it).
interface BifrostReply {
  kind?: string;
  body?: unknown;
  cost?: unknown;
}

/**
 * Build an AgentInvoker backed by Bifrost /v1/generate. Wire shape mirrors the
 * canonical client: body {query, messages, budget:{tokens,usd,ms}, context:
 * {intent, target_seam, override_tier}, device_token} → {kind, body, cost}.
 * Bifrost's `cost` is surfaced through ctx.onEvent as a `result` event shaped
 * like the CLI's stream-json result, so runGig's usage accounting (#195) folds
 * Bifrost spend into GigResult.usage with no runtime changes.
 */
export function makeBifrostInvoker(opts: BifrostInvokerOptions): AgentInvoker {
  const doFetch = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BIFROST_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? 700;
  const endpoint = `${opts.url.replace(/\/$/, "")}/v1/generate`;

  return async (ctx: AgentInvocationContext) => {
    // Same schema-into-prompt resolution as the Claude invoker (#174 subset rules).
    // EFFECTIVE schema, same as the seal enforces — the producer/enforcer unification
    // holds on this path too (review finding on the 2026-08-08 PR: the raw-schema
    // pattern removed from the Claude invoker had survived here).
    const schemaOf = (slug: string | undefined) => promptSchemaFor(opts.registry, slug);
    const sealTypes = ctx.output_types?.length ? ctx.output_types : ctx.agent.output_types;
    const schema = schemaOf(sealTypes[0]);
    const outputSchemas = sealTypes.length > 1
      ? Object.fromEntries(sealTypes.map((t) => [t, schemaOf(t)]))
      : undefined;
    const prompt = buildPrompt(ctx, schema, outputSchemas);

    const overrideTier = ctx.agent.model_tier ? opts.tierMap?.[ctx.agent.model_tier] : undefined;
    const query = `coltrane chair "${ctx.agent.slug}" (${ctx.phase})`;
    const extractOpts = extractOptionsForChair(sealTypes, schema);

    // One /v1/generate round-trip for the given prompt → the raw answer text. Bifrost spend is
    // surfaced through the CLI-shaped `result` event so runGig's usage accounting folds it in
    // untouched (#235: report only what Bifrost actually said — an absent cost means "not
    // reported", not "free").
    const runOnce = async (promptText: string): Promise<string> => {
      const body: Record<string, unknown> = {
        query,
        messages: [{ role: "user", content: promptText }],
        budget: { tokens: maxTokens, usd: 0.05, ms: timeoutMs },
        // context.query is REQUIRED by /v1/generate (422 without it), mirroring the
        // canonical client, which repeats the top-level query inside context.
        context: {
          query,
          intent: "coltrane",
          target_seam: "generate",
          ...(overrideTier ? { override_tier: overrideTier } : {}),
        },
        device_token: opts.deviceToken,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reply: BifrostReply;
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`bifrost /v1/generate ${res.status}: ${text.slice(0, 300)}`);
        }
        reply = (await res.json()) as BifrostReply;
      } finally {
        clearTimeout(timer);
      }
      const cost = reply.cost as Record<string, unknown> | number | undefined;
      const usd = typeof cost === "number" ? cost
        : cost && typeof cost === "object" && typeof cost["usd"] === "number" ? (cost["usd"] as number)
        : undefined;
      ctx.onEvent?.({ type: "result", raw: { ...(usd !== undefined ? { total_cost_usd: usd } : {}) } });
      return typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? "");
    };

    // Bifrost v0 is text-in/JSON-out — a single completion with NO tool surface, so a chair here
    // cannot seal in-band via output_write and cannot self-correct within its run. The honest
    // boundary for this transport is therefore the runtime's own seal (executeChair → the full
    // checkWritable): the earliest frame the predicate is answerable for a single-shot completion.
    // Extract the payload and hand it back; there is no invoker re-prompt (removed with the Claude
    // invoker's repair loop — the governor's ruling that a chair self-corrects in-band, not by the
    // invoker re-invoking it, holds here too, and a tool-less transport has no in-band frame).
    return extractJson(await runOnce(prompt), extractOpts);
  };
}
