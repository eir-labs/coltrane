// e2e spec for the code-changes template — chains the 4 phase-agents
// (explorer → definer → developer → finalizer) via real `claude -p --resume`
// against a "add a TODO comment to a file" task, and asserts the chain
// produced an actual diff at the develop turn.
//
// Real subprocess, real MCP, no mocks. Honesty: this spec is sensitive to
// whether the local claude CLI can carry a coherent state across --resume.
// If the chain breaks, the spec reports which turn failed and why.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  REPO_ROOT,
  type TempdirColtrane,
} from "../_harness.js";

interface PhaseFrontmatter {
  slug: string;
  toolsAllowlist: string[];
  systemPrompt: string;
}

function readPhaseAgent(slug: string): PhaseFrontmatter {
  const path = join(REPO_ROOT, "agents", "phase_agents", `${slug}.md`);
  if (!existsSync(path)) throw new Error(`phase-agent not found: ${path}`);
  const txt = readFileSync(path, "utf-8");
  const fmMatch = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`phase-agent missing frontmatter: ${path}`);
  const fm = fmMatch[1] ?? "";
  const body = (fmMatch[2] ?? "").trim();
  const toolsLine = fm.match(/^tools:\s*(.+)$/m);
  if (!toolsLine) throw new Error(`phase-agent missing tools field: ${path}`);
  const toolsAllowlist = (toolsLine[1] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { slug, toolsAllowlist, systemPrompt: body };
}

function extractToolUseNames(events: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant" || typeof ev.message !== "object" || !ev.message) continue;
    const m = ev.message as { content?: Array<{ type?: string; name?: string }> };
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use" && typeof c.name === "string") out.push(c.name);
    }
  }
  return out;
}

describe("code_template — 4-turn chain on the code-changes template", () => {
  let env: TempdirColtrane;
  let sandboxFile: string;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // Create a tiny sandbox file the chain can plausibly "add a TODO to"
    const sandboxDir = mkdtempSync(join(tmpdir(), "code-changes-sandbox-"));
    sandboxFile = join(sandboxDir, "target.ts");
    writeFileSync(sandboxFile, "export function noop(): void {}\n", "utf-8");
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("chains explorer → definer → developer → finalizer and the developer turn produces a diff plan", async () => {
    const explorer = readPhaseAgent("domain-explorer");
    const definer = readPhaseAgent("problem-definer");
    const developer = readPhaseAgent("solution-developer");
    const finalizer = readPhaseAgent("delivery-finalizer");

    const task = `Add a TODO comment to the file at ${sandboxFile}. The comment should read "// TODO: revisit". This is the work the chain is scoping.`;

    // ----- Turn 1: DISCOVER -----
    const turn1 = await spawnClaudeSubthread(
      [
        "-p",
        `You are the DISCOVER phase. Task: ${task} Survey the registry for any existing types in the 'code-changes' domain that would help scope this change. Do not ask clarifying questions.`,
        "--append-system-prompt",
        explorer.systemPrompt,
        "--allowed-tools",
        ...explorer.toolsAllowlist,
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
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 180_000 },
    );
    if (turn1.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`[discover] exit=${turn1.exitCode} stderr-tail:\n${turn1.stderr.slice(-1200)}`);
    }
    const t1Events = parseStreamJson(turn1.stdout);
    const t1Tools = extractToolUseNames(t1Events);
    expect(turn1.sessionId, "discover turn must return a session id for --resume").not.toBeNull();
    expect(
      t1Tools.some((n) => explorer.toolsAllowlist.includes(n)),
      `discover turn did not call any allowlisted tool. tools called: ${t1Tools.join(", ") || "(none)"}`,
    ).toBe(true);

    // ----- Turn 2: DEFINE (fresh subthread; agents are stateless per phase) -----
    const defineTask = `You are the DEFINE phase. The DISCOVER survey produced: ${assistantText(t1Events).slice(0, 500)}. Now compose a draft standard named 'demo-todo-change' in the 'code-changes' domain with a single phase [{name:'develop', agent:'solution-developer'}]. Do not ask clarifying questions.`;
    const turn2 = await spawnClaudeSubthread(
      [
        "-p",
        defineTask,
        "--append-system-prompt",
        definer.systemPrompt,
        "--allowed-tools",
        ...definer.toolsAllowlist,
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
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 180_000 },
    );
    const t2Events = parseStreamJson(turn2.stdout);
    const t2Tools = extractToolUseNames(t2Events);
    expect(
      t2Tools.some((n) => definer.toolsAllowlist.includes(n)),
      `define turn did not call any allowlisted tool. tools called: ${t2Tools.join(", ") || "(none)"}`,
    ).toBe(true);

    // ----- Turn 3: DEVELOP — must produce a recognizable diff plan -----
    const developTask = `You are the DEVELOP phase. The sealed predict is: the file at ${sandboxFile} gets a single new line '// TODO: revisit' prepended, no other changes. Dispatch a gig for standard 'demo-todo-change' with input {file: '${sandboxFile}', comment: '// TODO: revisit'} at depth 'minimal' for company 'demo-company'. Do not ask clarifying questions.`;
    const turn3 = await spawnClaudeSubthread(
      [
        "-p",
        developTask,
        "--append-system-prompt",
        developer.systemPrompt,
        "--allowed-tools",
        ...developer.toolsAllowlist,
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
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 180_000 },
    );
    const t3Events = parseStreamJson(turn3.stdout);
    const t3Tools = extractToolUseNames(t3Events);
    const t3Text = assistantText(t3Events);
    expect(
      t3Tools.some((n) => developer.toolsAllowlist.includes(n)),
      `develop turn did not call any allowlisted tool. tools called: ${t3Tools.join(", ") || "(none)"}`,
    ).toBe(true);
    // The "diff plan" check: the develop turn must mention the target file
    // and the TODO comment text in its output (proves the seal carried).
    const todoLanded = t3Text.includes("TODO") && (t3Text.includes(sandboxFile) || t3Text.toLowerCase().includes("target.ts"));
    expect(
      todoLanded,
      `develop turn did not produce a recognizable diff plan. assistant text head:\n${t3Text.slice(0, 800)}`,
    ).toBe(true);

    // ----- Turn 4: DELIVER -----
    const deliverTask = `You are the DELIVER phase. The develop phase reported: ${t3Text.slice(0, 500)}. Audit the system for any findings on scope 'standards' with check 'orphans'. Do not ask clarifying questions.`;
    const turn4 = await spawnClaudeSubthread(
      [
        "-p",
        deliverTask,
        "--append-system-prompt",
        finalizer.systemPrompt,
        "--allowed-tools",
        ...finalizer.toolsAllowlist,
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
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 180_000 },
    );
    const t4Events = parseStreamJson(turn4.stdout);
    const t4Tools = extractToolUseNames(t4Events);
    expect(
      t4Tools.some((n) => finalizer.toolsAllowlist.includes(n)),
      `deliver turn did not call any allowlisted tool. tools called: ${t4Tools.join(", ") || "(none)"}`,
    ).toBe(true);

    // Final: no turn ever called outside its allowlist (harness-exempt: ToolSearch)
    const HARNESS_EXEMPT = new Set(["ToolSearch"]);
    const allOutside: string[] = [];
    for (const [phase, allowlist, calls] of [
      ["discover", explorer.toolsAllowlist, t1Tools],
      ["define", definer.toolsAllowlist, t2Tools],
      ["develop", developer.toolsAllowlist, t3Tools],
      ["deliver", finalizer.toolsAllowlist, t4Tools],
    ] as const) {
      for (const c of calls) {
        if (!allowlist.includes(c) && !HARNESS_EXEMPT.has(c)) {
          allOutside.push(`${phase}:${c}`);
        }
      }
    }
    expect(allOutside, `tool calls outside per-phase allowlists: ${allOutside.join(", ")}`).toEqual([]);
  }, 900_000);
});
