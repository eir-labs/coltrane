// Independent re-measurement of the gig_dispatch contract.
//
// Primary path:   in-process call to dispatchTool("gig_dispatch", …) with a
//                 deterministic AgentInvoker.
// Secondary path: spawn the MCP stdio server (tests/honest_broker/_server_entry.mjs)
//                 as a real subprocess; talk raw JSON-RPC via the SDK's
//                 StdioClientTransport; invoke gig_dispatch via callTool.
//                 The subprocess uses the same deterministic invoker as the
//                 in-process call (wired by the entry file).
//
// Agreement = the MCP transport layer faithfully forwards arguments + result
// to/from the dispatcher. Divergence = the wire format adds/drops fields, the
// CallToolRequestSchema wrapping changes shape, or the subprocess and
// in-process bootstrap diverge.
//
// Volatile fields scrubbed before comparison: gig_id (randomUUID per run),
// every output.id (randomUUID), output_count is structural (kept).

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  bootstrapServerDeps,
  dispatchTool,
  type ServerDeps,
} from "../../src/server.js";
import type { AgentInvoker } from "../../src/runtime.js";
import {
  compareHonestBroker,
  scrubKeys,
} from "../../src/test_honest_broker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const SERVER_ENTRY = resolve(__dirname, "_server_entry.mjs");

// The same deterministic invoker the subprocess entry uses — must match
// _server_entry.mjs exactly so the two paths produce identical structural
// outputs for the same gig input.
const deterministicInvoke: AgentInvoker = (ctx) => {
  const slug = ctx.agent.slug;
  const gig_input = (ctx.gig_input ?? {}) as Record<string, unknown>;
  const topic = typeof gig_input["topic"] === "string" ? gig_input["topic"] : "default";
  if (slug === "sensor") return { text: `note about ${topic}` };
  if (slug === "summarizer") return { gist: `summary of ${topic}` };
  return {};
};

function makeInProcessDeps(): ServerDeps {
  const base = bootstrapServerDeps(REPO_ROOT);
  return { ...base, invoke: deterministicInvoke, model_version: "honest-broker-deterministic-v1" };
}

// Fields whose values are randomly generated or wall-clock-derived per run,
// so they must be scrubbed before structural comparison.
const VOLATILE_KEYS: readonly string[] = [
  "gig_id",
  "id",
  "started_at",
  "finished_at",
  "created_at",
  "run_fingerprint",
  "output_hashes",
];

interface DispatchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  requires_approval?: boolean;
  not_implemented?: boolean;
}

async function callPrimary(args: Record<string, unknown>): Promise<DispatchResult> {
  const deps = makeInProcessDeps();
  const r = await dispatchTool("gig_dispatch", args, deps);
  return JSON.parse(JSON.stringify(r)) as DispatchResult;
}

async function callSecondary(args: Record<string, unknown>): Promise<DispatchResult> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_ENTRY],
    env: { ...process.env, COLTRANE_GENOME: REPO_ROOT } as Record<string, string>,
  });
  const client = new Client(
    { name: "honest-broker", version: "0.0.1" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: "gig_dispatch", arguments: args });
    // CallToolResult wraps the dispatcher's text-encoded JSON in content[0].text.
    const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const first = content[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      throw new Error(`unexpected MCP CallToolResult shape: ${JSON.stringify(res).slice(0, 200)}`);
    }
    return JSON.parse(first.text) as DispatchResult;
  } finally {
    try {
      await client.close();
    } catch {
      /* best effort */
    }
  }
}

// Three-gig sample.
const cases: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
  {
    name: "straightforward — summarize with a simple topic",
    args: { standard_slug: "summarize", input: { topic: "noise" } },
  },
  {
    name: "optional fields — depth + company_id alongside the required pair",
    args: { standard_slug: "summarize", input: { topic: "weather" }, depth: "shallow", company_id: "acme" },
  },
  {
    name: "edge case — unknown standard returns a structured error, not a crash",
    args: { standard_slug: "no-such-standard", input: {} },
  },
];

describe("R7 honest-broker: gig_dispatch contract", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const cmp = await compareHonestBroker<DispatchResult>(
        () => callPrimary(c.args),
        () => callSecondary(c.args),
        (a, b) => {
          const aScrub = scrubKeys(a, VOLATILE_KEYS);
          const bScrub = scrubKeys(b, VOLATILE_KEYS);
          return JSON.stringify(aScrub) === JSON.stringify(bScrub);
        },
      );
      if (!cmp.agreement) {
        // surface the scrubbed divergence too so RED-honest findings are legible.
        const aScrub = scrubKeys(cmp.primary, VOLATILE_KEYS);
        const bScrub = scrubKeys(cmp.secondary, VOLATILE_KEYS);
        throw new Error(
          `honest-broker divergence on "${c.name}":\n` +
            `  primary  (scrubbed): ${JSON.stringify(aScrub).slice(0, 400)}\n` +
            `  secondary(scrubbed): ${JSON.stringify(bScrub).slice(0, 400)}`,
        );
      }
      expect(cmp.agreement).toBe(true);
      // sanity: both paths reported the same ok/not_implemented disposition.
      expect(cmp.primary.ok).toBe(cmp.secondary.ok);
    }, 60_000);
  }
});
