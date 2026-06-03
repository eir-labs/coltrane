// e2e smoke for the 4 universal phase-agents (domain-explorer, problem-definer,
// solution-developer, delivery-finalizer). Same shape as players_smoke.spec.ts:
// real subprocess, real MCP, no mocks. Each spec spawns `claude -p` with the
// phase-agent's tool allowlist + charter as the system prompt, hands it a
// phase-appropriate task, and asserts:
//   1. an expected MCP tool was called from within the allowlist
//   2. no tool outside the allowlist + harness exemptions
//
// Honesty note: the problem-definer charter names a `prereg_seal` capability
// that has no MCP tool slug in src/mcp.ts as of this branch. That spec routes
// the agent at `standard_compose` (the closest extant tool); if it instead
// blocks waiting for prereg_seal, the spec records the gap rather than faking.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setupTempdirColtrane, spawnClaudeSubthread, parseStreamJson, REPO_ROOT, type TempdirColtrane } from "../_harness.js";

interface PhaseAgent {
  slug: string;
  name: string;
  description: string;
  toolsAllowlist: string[];
  systemPrompt: string;
  laneKeyword: string;
}

function parsePhaseAgent(slug: string, laneKeyword: string): PhaseAgent {
  const path = join(REPO_ROOT, "agents", "phase_agents", `${slug}.md`);
  if (!existsSync(path)) throw new Error(`phase-agent not found: ${path}`);
  const txt = readFileSync(path, "utf-8");
  const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`phase-agent missing frontmatter: ${path}`);
  const fm = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();

  const nameLine = fm.match(/^name:\s*(.+)$/m);
  const descLine = fm.match(/^description:\s*(.+)$/m);
  const toolsLine = fm.match(/^tools:\s*(.+)$/m);
  if (!nameLine || !descLine || !toolsLine) {
    throw new Error(`phase-agent missing required frontmatter fields: ${path}`);
  }
  const toolsAllowlist = (toolsLine[1] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    slug,
    name: nameLine[1] ?? "",
    description: descLine[1] ?? "",
    toolsAllowlist,
    systemPrompt: body,
    laneKeyword,
  };
}

interface PhaseTask {
  slug: string;
  laneKeyword: string;
  task: string;
  expectedToolSlug: string;
}

const PHASE_TASKS: readonly PhaseTask[] = [
  {
    slug: "domain-explorer",
    laneKeyword: "discover",
    task: "Survey the type registry for any types in the 'code-changes' domain. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "type_browse",
  },
  {
    slug: "problem-definer",
    laneKeyword: "define",
    task: "Compose a draft standard named 'demo-change-protocol' in the 'code-changes' domain with phases [{name:'develop', agent:'solution-developer'}]. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "standard_compose",
  },
  {
    slug: "solution-developer",
    laneKeyword: "develop",
    task: "Dispatch the standard with slug 'code-change-protocol' against input {task: 'add a TODO comment'} at depth 'full' for company 'demo-company'. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "gig_dispatch",
  },
  {
    slug: "delivery-finalizer",
    laneKeyword: "deliver",
    task: "Trace the output with id 'demo-output-1' backward to its root signals. Use only the coltrane MCP tools you have access to.",
    expectedToolSlug: "output_trace",
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

function assistantTextLower(events: Array<Record<string, unknown>>): string {
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
  return parts.join("\n").toLowerCase();
}

describe("phase_agents — 4 universal phase-agents, real MCP, real claude CLI", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  for (const task of PHASE_TASKS) {
    it(`phase-agent ${task.slug}: routes to ${task.expectedToolSlug} within allowlist`, async () => {
      const agent = parsePhaseAgent(task.slug, task.laneKeyword);
      const expectedToolFull = `mcp__coltrane__${task.expectedToolSlug}`;

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

      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[${task.slug}] claude exit=${result.exitCode}\nstderr (tail):\n${result.stderr.slice(-1500)}\nstdout (head):\n${result.stdout.slice(0, 800)}`,
        );
      }

      const events = parseStreamJson(result.stdout);
      const toolCalls = extractToolUses(events);
      const text = assistantTextLower(events);

      // Assertion 1 — the expected tool was called at least once
      const calledExpected = toolCalls.some((c) => c.name === expectedToolFull);
      expect(
        calledExpected,
        `expected ${expectedToolFull} to be called. actual tool calls: ${toolCalls.map((c) => c.name).join(", ") || "(none)"}`,
      ).toBe(true);

      // Assertion 2 — no tool call OUTSIDE the allowlist + harness exemption
      const HARNESS_EXEMPT = new Set(["ToolSearch"]);
      const outsideAllowlist = toolCalls.filter(
        (c) => !agent.toolsAllowlist.includes(c.name) && !HARNESS_EXEMPT.has(c.name),
      );
      expect(
        outsideAllowlist,
        `tool calls outside allowlist: ${outsideAllowlist.map((c) => c.name).join(", ")}`,
      ).toEqual([]);

      // Assertion 3 — lane keyword acknowledgement (soft; hard-fail only if both
      // the keyword absent AND no expected tool called — i.e. system prompt ignored)
      const toolInputBlob = JSON.stringify(toolCalls).toLowerCase();
      const keywordSeen = text.includes(task.laneKeyword) || toolInputBlob.includes(task.laneKeyword);
      if (!keywordSeen && !calledExpected) {
        expect(
          keywordSeen,
          `neither the lane keyword "${task.laneKeyword}" nor the expected tool ${expectedToolFull} surfaced — system prompt likely not loaded`,
        ).toBe(true);
      }
    }, 300_000);
  }
});
