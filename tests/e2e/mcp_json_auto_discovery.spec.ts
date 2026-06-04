// e2e: ".mcp.json auto-discovery on directory open" — the load-bearing README
// claim that Coltrane's MCP server auto-starts when Claude opens the repo,
// without any --mcp-config flag or ~/.claude/settings.json wiring.
//
// README (line 16):
//   "The repo ships its own `.mcp.json`, so Coltrane's MCP server auto-starts
//    when Claude opens the directory — no `~/.claude/settings.json` edits,
//    no manual server start."
//
// Background. Every other e2e in this suite passes `--mcp-config <path>`
// explicitly. That proves coltrane MCP works WHEN wired up — it does NOT prove
// the README's frictionless onboarding claim. The whole "open the repo and go"
// pitch hinges on Claude Code reading `.mcp.json` from cwd automatically.
//
// Pre-reg shape (RED / GREEN):
//   1. Tempdir contains a `.mcp.json` that points at coltrane's MCP server
//      (via the tempdir-clone _server_entry.mjs, so this test stays hermetic
//      and doesn't depend on `npm run build` having produced dist/server.js).
//   2. Spawn `claude -p ...` with cwd=tempdir, NO --mcp-config, NO
//      --strict-mcp-config. --dangerously-skip-permissions is used to skip
//      the project-trust dialog (which would otherwise block .mcp.json server
//      spawning in a non-interactive run).
//   3. Prompt: "call mcp__coltrane__system_health".
//   4. PASS iff the stream-json output shows a tool_use whose name begins with
//      `mcp__coltrane__` — proving Claude actually discovered AND loaded the
//      MCP server from `.mcp.json`, not just read the file.
//
// Honesty kill-conditions (any of these → RED, file the bug, don't paper over):
//   - claude exits non-zero (auto-discovery isn't a supported flow here)
//   - claude runs but never calls a coltrane tool (server present, didn't load)
//   - claude reports the tool is unavailable (auto-discovery is dark)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  setupTempdirColtrane,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
} from "./_harness.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const SKIP_PERMS = "--dangerously-skip-permissions";

interface SpawnResult {
  sessionId: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Bare claude spawn — deliberately does NOT inject --mcp-config. This is the
 * whole point of the test: prove auto-discovery from cwd's `.mcp.json` works.
 * The harness's spawnClaudeSubthread always appends --mcp-config when given a
 * config path, so we re-implement the minimal launch here.
 */
async function spawnClaudeAutoDiscovery(
  prompt: string,
  cwd: string,
  timeoutMs = 240_000,
): Promise<SpawnResult> {
  const sessionId = randomUUID();
  const args = [
    "-p", prompt,
    SKIP_PERMS,
    "--session-id", sessionId,
    "--output-format", "stream-json",
    "--verbose",
  ];
  return new Promise((resolveP) => {
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let observedSid: string | null = null;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      if (!observedSid) {
        for (const line of s.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt.session_id) {
              observedSid = evt.session_id;
              break;
            }
          } catch { /* not json */ }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ sessionId: observedSid, stdout, stderr, exitCode: code });
    });
  });
}

interface ToolUseObservation {
  name: string;
  input: Record<string, unknown>;
}

function coltraneToolUses(stdout: string): ToolUseObservation[] {
  const events = parseStreamJson(stdout);
  const calls: ToolUseObservation[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const msg = ev.message as
      | { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }
      | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (
        block.type === "tool_use" &&
        typeof block.name === "string" &&
        block.name.startsWith("mcp__coltrane__")
      ) {
        calls.push({ name: block.name, input: block.input ?? {} });
      }
    }
  }
  return calls;
}

/**
 * Inspect the system init event for the list of MCP servers Claude actually
 * loaded. Newer claude CLI versions emit { type: "system", subtype: "init",
 * mcp_servers: [{ name, status }] } as the first stream-json event. If present
 * and "coltrane" is missing OR not connected, that's the proximate
 * auto-discovery failure signal.
 */
function mcpServersFromInit(stdout: string): Array<{ name: string; status?: string }> | null {
  const events = parseStreamJson(stdout);
  for (const ev of events) {
    if (ev.type === "system" && Array.isArray((ev as Record<string, unknown>)["mcp_servers"])) {
      return (ev as { mcp_servers: Array<{ name: string; status?: string }> }).mcp_servers;
    }
  }
  return null;
}

describe("e2e: .mcp.json auto-discovery on directory open (README line 16)", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();

    // Write a `.mcp.json` AT THE TEMPDIR ROOT — this is what Claude Code is
    // supposed to read automatically when launched with cwd=tempdir. The
    // shape mirrors the harness's strict-mcp-config (tsx + _server_entry.mjs)
    // so we don't depend on `npm run build` having produced dist/server.js
    // in the tempdir clone. This isolates the test to ONE question: does
    // claude auto-discover and load servers from cwd's `.mcp.json`?
    const dotMcpJson = {
      mcpServers: {
        coltrane: {
          command: "npx",
          args: ["tsx", env.mcpServerEntry],
          env: {
            COLTRANE_GENOME: env.tempDir,
          },
        },
      },
    };
    writeFileSync(join(env.tempDir, ".mcp.json"), JSON.stringify(dotMcpJson, null, 2));

    // sanity: file landed where we expect
    if (!existsSync(join(env.tempDir, ".mcp.json"))) {
      throw new Error("test setup failed: .mcp.json was not written to tempdir");
    }
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("claude launched in repo root auto-loads coltrane MCP from .mcp.json and can call its tools", async () => {
    const result = await spawnClaudeAutoDiscovery(
      [
        "Without using --mcp-config (you're running in a repo that ships its own .mcp.json),",
        "call the coltrane MCP tool mcp__coltrane__system_health (no arguments) exactly once,",
        "then in one short sentence report the value of the 'outputs' field you got back.",
        "If the tool is not available, say exactly: TOOL_UNAVAILABLE.",
      ].join(" "),
      env.tempDir,
    );

    // Surface stderr eagerly — if claude rejected the auto-discovery (e.g.
    // trust-prompt blocked it) the diagnostic lives there.
    const stderrTail = result.stderr.slice(-1200);

    expect(result.exitCode, `claude exited non-zero. stderr tail:\n${stderrTail}`).toBe(0);
    expect(result.sessionId, "claude did not emit a session_id (no stream-json output at all)").not.toBeNull();

    // If the CLI surfaced an init event, the cleanest diagnostic is the server
    // list. Don't fail on this directly (older CLIs may omit it) — but if it
    // IS there and coltrane is missing or non-connected, log it for the
    // tool-use assertion to anchor on.
    const servers = mcpServersFromInit(result.stdout);
    if (servers !== null) {
      const coltraneEntry = servers.find((s) => s.name === "coltrane");
      expect(
        coltraneEntry,
        `claude's system init did not list 'coltrane' as a loaded MCP server. ` +
        `mcp_servers=${JSON.stringify(servers)}. ` +
        `Auto-discovery from .mcp.json appears dark.`,
      ).toBeDefined();
      if (coltraneEntry?.status && coltraneEntry.status !== "connected") {
        // Don't hard-fail here — the tool-use check below is the real
        // load-bearing assertion — but include the status in the failure
        // path so the diagnosis points at server startup, not at Claude's
        // tool-calling reasoning.
        // eslint-disable-next-line no-console
        console.warn(
          `[mcp_json_auto_discovery] coltrane server present but status='${coltraneEntry.status}' ` +
          `(expected 'connected'). Tool-use assertion will fail next if this is the real bug.`,
        );
      }
    }

    const toolCalls = coltraneToolUses(result.stdout);
    const calledHealth = toolCalls.find((c) => c.name === "mcp__coltrane__system_health");

    // The load-bearing assertion: a `mcp__coltrane__*` tool_use appears in
    // the assistant stream. This can ONLY happen if Claude auto-discovered
    // the server from `.mcp.json` (we passed no --mcp-config).
    expect(
      calledHealth,
      [
        ".mcp.json auto-discovery did NOT load coltrane.",
        `coltrane tool calls observed: ${JSON.stringify(toolCalls.map((c) => c.name))}`,
        `assistant text (first 600 chars):`,
        assistantText(parseStreamJson(result.stdout)).slice(0, 600),
        `stderr tail:`,
        stderrTail,
      ].join("\n"),
    ).toBeDefined();

    // Sanity: the model's natural-language reply shouldn't be the explicit
    // unavailability sentinel either.
    const reply = assistantText(parseStreamJson(result.stdout));
    expect(
      reply.includes("TOOL_UNAVAILABLE"),
      `claude reported TOOL_UNAVAILABLE, meaning auto-discovery failed at the surface even if a tool_use slipped through. reply:\n${reply}`,
    ).toBe(false);

    // Persist the artifact for the band's audit trail — what tools were
    // actually visible to claude under pure auto-discovery.
    writeFileSync(
      join(env.tempDir, ".mcp_json_auto_discovery.result.json"),
      JSON.stringify(
        {
          exitCode: result.exitCode,
          sessionId: result.sessionId,
          mcpServersInit: servers,
          coltraneToolCalls: toolCalls,
          assistantText: reply.slice(0, 1500),
          stderrTail,
        },
        null,
        2,
      ),
    );

    // Re-read & spot-check so a corrupted write surfaces here, not in CI.
    const written = readFileSync(join(env.tempDir, ".mcp_json_auto_discovery.result.json"), "utf-8");
    expect(written.length).toBeGreaterThan(0);
  }, 600_000);
});
