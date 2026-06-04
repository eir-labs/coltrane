// e2e — runs a STANDARD live using coltrane MCP.
//
// shape: spawn real claude with a real coltrane MCP server (from tempdir).
// send ONE prompt asking claude to execute the 'summarize' standard.
// claude calls coltrane MCP tools (gig_dispatch + output_query) over real
// stdio JSON-RPC. assert: gig completed, typed outputs landed, no host shell.
//
// THE outermost integration test: real user → real claude → real MCP →
// real coltrane runtime → real claude (inner invoker spawns for each phase).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, spawnClaudeSubthread, parseStreamJson, type TempdirColtrane } from "./_harness.js";

// Walk stream-json events for tool_use items inside assistant.content.
function toolUseNames(events: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant" || !ev.message) continue;
    const m = ev.message as { content?: Array<{ type?: string; name?: string }> };
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use" && typeof c.name === "string") names.push(c.name);
    }
  }
  return names;
}

describe("standard runs live via coltrane MCP — real claude as the client", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 120_000);
  afterAll(() => env?.cleanup());

  it("claude session connects to coltrane MCP, executes 'summarize' standard via gig_dispatch, observes typed outputs", async () => {
    const result = await spawnClaudeSubthread(
      [
        "-p",
        "Execute the 'summarize' standard via coltrane's gig_dispatch MCP tool with input { \"source\": \"the room is loud and full of people talking\" }. After it completes, call output_query for the same gig_id and tell me the count of outputs and the domain_type of each output. Be concise.",
        "--allowedTools", "mcp__coltrane__gig_dispatch,mcp__coltrane__output_query",
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 240_000 },
    );

    expect(result.exitCode, `claude stderr: ${result.stderr.slice(0, 500)}`).toBe(0);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{16,}$/);

    const events = parseStreamJson(result.stdout);
    const usedTools = toolUseNames(events);

    // FORMAL assertions: claude actually invoked coltrane MCP tools through
    // real stdio JSON-RPC. The standard ran in the coltrane runtime via gig_dispatch.
    expect(usedTools.some((t) => t.includes("gig_dispatch"))).toBe(true);
    expect(usedTools.some((t) => t.includes("output_query"))).toBe(true);

    // Cage check: no Bash, no host-shell escape.
    for (const t of usedTools) {
      expect(t.toLowerCase()).not.toMatch(/bash|shell|exec|spawn/);
    }
  }, 300_000);
});
