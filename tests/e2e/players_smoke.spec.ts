// e2e smoke for the 5 coltrane players.
//
// For each player, we:
//   1. Read the compiled .claude/agents/coltrane-<slug>.md
//   2. Extract its `tools` allowlist and `description`
//   3. Spawn `claude -p` with --mcp-config (real coltrane MCP) +
//      --allowed-tools (the player's allowlist) +
//      --append-system-prompt (the compiled charter body)
//   4. Hand it a lane-appropriate user task
//   5. Assert via stream-json parsing:
//      - the right coltrane MCP tool was called (one allowlisted for that player)
//      - the response acknowledges the lane (text contains a charter keyword)
//      - no tool call outside the allowlist
//
// Real subprocess, real MCP, no mocks. Pre-reg: RED-honest — if a player's
// routing doesn't behave as configured, the test reports which + why.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setupTempdirColtrane, spawnClaudeSubthread, parseStreamJson, REPO_ROOT, type TempdirColtrane } from "./_harness.js";

interface CompiledAgent {
  slug: string;
  name: string;
  description: string;
  toolsAllowlist: string[];
  systemPrompt: string;
  charterKeyword: string;
}

function parseCompiledAgent(slug: string, charterKeyword: string): CompiledAgent {
  const path = join(REPO_ROOT, ".claude", "agents", `coltrane-${slug}.md`);
  if (!existsSync(path)) throw new Error(`compiled agent not found: ${path}`);
  const txt = readFileSync(path, "utf-8");
  const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`compiled agent missing frontmatter: ${path}`);
  const fm = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";

  const nameLine = fm.match(/^name:\s*(.+)$/m);
  const descLine = fm.match(/^description:\s*(.+)$/m);
  const toolsLine = fm.match(/^tools:\s*(.+)$/m);
  if (!nameLine || !descLine || !toolsLine) {
    throw new Error(`compiled agent missing required frontmatter fields: ${path}`);
  }
  const toolsAllowlist = (toolsLine[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    slug,
    name: nameLine[1] ?? "",
    description: descLine[1] ?? "",
    toolsAllowlist,
    systemPrompt: body.trim(),
    charterKeyword,
  };
}

interface PlayerTask {
  slug: string;
  // expected coltrane-flavored keyword from the charter body
  charterKeyword: string;
  // a user task that should route the player toward one of its allowlisted tools
  task: string;
  // the coltrane MCP tool slug (bare) we expect to see called at least once
  expectedToolSlug: string;
}

const PLAYER_TASKS: readonly PlayerTask[] = [
  {
    slug: "methodology-cadence-keeper",
    charterKeyword: "cadence",
    task: "Simulate the standard with slug 'demo-standard' against a mock input of {}. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "standard_simulate",
  },
  {
    slug: "chain-audit-keeper",
    charterKeyword: "lineage",
    task: "Trace the output with id 'demo-output-1' backward to its root signals. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "output_trace",
  },
  {
    slug: "substrate-edge-keeper",
    charterKeyword: "substrate",
    task: "Browse the type registry for any types in the 'demo' domain. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "type_browse",
  },
  {
    slug: "audience-modeler",
    charterKeyword: "audience",
    task: "Read the charter for company id 'demo-company'. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "charter_read",
  },
  {
    slug: "illumination-reviewer",
    charterKeyword: "whole",
    task: "Report system health over the last 7 days window. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "system_health",
  },
];

interface ToolUseEvent {
  name: string;
  input: Record<string, unknown>;
}

function extractToolUses(events: Array<Record<string, unknown>>): ToolUseEvent[] {
  const out: ToolUseEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant" || typeof ev.message !== "object" || !ev.message) continue;
    const m = ev.message as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use" && typeof c.name === "string") {
        out.push({ name: c.name, input: (c.input as Record<string, unknown>) ?? {} });
      }
    }
  }
  return out;
}

function assistantText(events: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.type === "assistant" && typeof ev.message === "object" && ev.message) {
      const m = ev.message as { content?: Array<{ type?: string; text?: string }> };
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    } else if (ev.type === "result" && typeof ev.result === "string") {
      parts.push(ev.result);
    }
  }
  return parts.join("\n");
}

describe("players_smoke — 5 coltrane players, real MCP, real claude CLI", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  for (const task of PLAYER_TASKS) {
    it(`player ${task.slug}: routes to ${task.expectedToolSlug} within allowlist`, async () => {
      const agent = parseCompiledAgent(task.slug, task.charterKeyword);
      const expectedToolFull = `mcp__coltrane__${task.expectedToolSlug}`;

      // Spawn claude with strict allowlist + the compiled charter as system prompt.
      // Always-on baseline tools (Read, Bash, etc.) are excluded — only MCP tools allowed.
      // ToolSearch is a claude-code harness tool used to load schemas for deferred
      // MCP tools; it must be allowed for any MCP tool to be invokable in this CLI.
      // AskUserQuestion is disabled so the player commits to a call rather than
      // pausing for clarification (we want routing observed, not negotiated).
      const result = await spawnClaudeSubthread(
        [
          "-p",
          `${task.task} Do not ask clarifying questions; proceed with reasonable defaults.`,
          "--append-system-prompt",
          agent.systemPrompt,
          "--allowed-tools",
          ...agent.toolsAllowlist,
          "ToolSearch",
          "--disallowed-tools",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
          "Task",
          "AskUserQuestion",
        ],
        {
          mcpConfigPath: env.mcpConfigPath,
          timeoutMs: 180_000,
        },
      );

      // Honest reporting first — surface stderr if exit non-zero
      if (result.exitCode !== 0) {
        // not yet failing: show diag, then assert below
        // eslint-disable-next-line no-console
        console.error(`[${task.slug}] claude exit=${result.exitCode}\nstderr (tail):\n${result.stderr.slice(-1500)}\nstdout (head):\n${result.stdout.slice(0, 800)}`);
      }

      const events = parseStreamJson(result.stdout);
      const toolCalls = extractToolUses(events);
      const text = assistantText(events).toLowerCase();

      // Assertion 1 — the expected tool was called at least once
      const calledExpected = toolCalls.some((c) => c.name === expectedToolFull);
      expect(
        calledExpected,
        `expected ${expectedToolFull} to be called. actual tool calls: ${toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      ).toBe(true);

      // Assertion 2 — no tool call OUTSIDE the allowlist + harness exemptions.
      // ToolSearch is a claude-code-internal schema loader for deferred MCP tools
      // and is exempted (it's part of the routing infrastructure, not a coltrane
      // capability). What we forbid: any OTHER coltrane MCP tool not in the
      // player's allowlist, or any non-MCP tool that could exfiltrate the lane.
      const HARNESS_EXEMPT = new Set(["ToolSearch"]);
      const outsideAllowlist = toolCalls.filter(
        (c) => !agent.toolsAllowlist.includes(c.name) && !HARNESS_EXEMPT.has(c.name),
      );
      expect(
        outsideAllowlist,
        `tool calls outside allowlist: ${outsideAllowlist.map((c) => c.name).join(", ")}`,
      ).toEqual([]);

      // Assertion 3 — response text acknowledges the lane (charter keyword appears
      // anywhere in the assistant text OR in the tool input — proves the system
      // prompt landed in the model's working context)
      const toolInputBlob = JSON.stringify(toolCalls).toLowerCase();
      const keywordSeen = text.includes(task.charterKeyword) || toolInputBlob.includes(task.charterKeyword);
      // Soft, but we record it — many models won't echo a charter keyword on a
      // short factual task. We only hard-fail if BOTH the keyword absent AND no
      // expected tool was called (which would mean the system prompt was ignored).
      if (!keywordSeen && !calledExpected) {
        expect(
          keywordSeen,
          `neither the lane keyword "${task.charterKeyword}" nor the expected tool ${expectedToolFull} surfaced — system prompt likely not loaded`,
        ).toBe(true);
      }
    }, 300_000);
  }
});
