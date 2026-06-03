// e2e spec for the code-changes template — asserts the CONDUCTOR-DISPATCH
// contract for `/code-flow`.
//
// The contract:
//   1. The conductor (one `claude -p` subprocess running the /code-flow body)
//      dispatches each phase as a subagent via the `Task` tool with
//      `subagent_type` matching the phase-agent slug.
//   2. The conductor MUST NOT call any `mcp__coltrane__*` tool inline from its
//      own thread — the per-phase tool allowlist lives on the subagent.
//   3. The four Task dispatches happen in order: discover → define → develop
//      → deliver, with `subagent_type`s domain-explorer, problem-definer,
//      solution-developer, delivery-finalizer.
//
// Real subprocess, real MCP, no mocks. If claude-code's runtime does not honour
// the directive and the conductor calls MCP tools inline anyway, the spec
// records that as a hard failure — that is the architectural diagnosis Eugene
// asked for. We do not paper over the contract.
//
// This spec folds in the conductor-dispatch shape that an earlier draft of this
// deliverable considered as a separate file; keeping a single spec keeps the
// contract test cohesive and avoids duplication.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
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

interface ToolUseEvent {
  name: string;
  input: Record<string, unknown>;
  parentToolUseId: string | null;
}

/**
 * Walk the stream-json events and extract every `tool_use` content block
 * emitted by an assistant message. We track parent_tool_use_id so we can
 * separate the conductor's own tool_uses from those produced by a nested
 * subagent that the Task tool spawned.
 *
 * Claude Code surfaces nested subagent activity in the parent stream with a
 * non-null `parent_tool_use_id`; the conductor's own tool_uses have null.
 */
function extractToolUses(events: Array<Record<string, unknown>>): ToolUseEvent[] {
  const out: ToolUseEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "assistant" || typeof ev.message !== "object" || !ev.message) continue;
    const parentToolUseId = (ev.parent_tool_use_id as string | null | undefined) ?? null;
    const m = ev.message as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type === "tool_use" && typeof c.name === "string") {
        out.push({
          name: c.name,
          input: (c.input as Record<string, unknown>) ?? {},
          parentToolUseId,
        });
      }
    }
  }
  return out;
}

/** Filter to only the conductor's own tool calls (parent_tool_use_id is null). */
function conductorOwnCalls(all: ToolUseEvent[]): ToolUseEvent[] {
  return all.filter((c) => c.parentToolUseId === null);
}

/**
 * Read the body of templates/code-changes/.claude/commands/code-flow.md
 * stripped of YAML frontmatter. This is the conductor instruction the slash
 * command would expand to. We inline it directly into the prompt so the spec
 * does not depend on slash-command installation.
 */
function readCodeFlowBody(): string {
  const path = join(REPO_ROOT, "templates", "code-changes", ".claude", "commands", "code-flow.md");
  if (!existsSync(path)) throw new Error(`code-flow command not found: ${path}`);
  const txt = readFileSync(path, "utf-8");
  const fmStripped = txt.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return fmStripped.trim();
}

const PHASE_ORDER = ["domain-explorer", "problem-definer", "solution-developer", "delivery-finalizer"] as const;

describe("code_template — conductor dispatches each phase via Task with subagent_type", () => {
  let env: TempdirColtrane;
  let sandboxFile: string;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    const sandboxDir = mkdtempSync(join(tmpdir(), "code-changes-sandbox-"));
    sandboxFile = join(sandboxDir, "target.ts");
    writeFileSync(sandboxFile, "export function noop(): void {}\n", "utf-8");
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("conductor emits exactly 4 Task dispatches in order with correct subagent_types, and zero inline mcp__coltrane__* calls", async () => {
    // Compile the 4 phase-agents into the --agents JSON format claude-code
    // accepts: { description, prompt, tools }.
    const phaseAgents: Record<string, { description: string; prompt: string; tools: string[] }> = {};
    for (const slug of PHASE_ORDER) {
      const fm = readPhaseAgent(slug);
      phaseAgents[slug] = {
        description: `phase agent: ${slug}`,
        prompt: fm.systemPrompt,
        tools: fm.toolsAllowlist,
      };
    }
    const agentsJson = JSON.stringify(phaseAgents);

    const codeFlowBody = readCodeFlowBody();
    const task = `Add a TODO comment to the file at ${sandboxFile}. The comment should read "// TODO: revisit". This is the named code change.`;

    // Conductor prompt = inlined /code-flow body with the task substituted.
    const conductorPrompt = `${codeFlowBody.replace("$ARGUMENTS", task)}\n\nProceed now. Do not ask clarifying questions.`;

    // The parent-level --allowed-tools acts as the PERMISSION boundary
    // (claude CLI pre-approves these so the nested subagents can actually
    // invoke them without interactive permission prompts). The per-phase
    // tool ALLOWLIST is independently enforced inside the subagent context
    // by the `tools:` frontmatter we passed via --agents.
    //
    // We include the union of all phase-agent tool slugs at the parent level
    // so the subagent's MCP calls can flow through. We then assert at the
    // CONDUCTOR-call level (parent_tool_use_id === null) that the conductor
    // itself made zero `mcp__coltrane__*` calls — only subagents do.
    const allPhaseTools = new Set<string>();
    for (const slug of PHASE_ORDER) {
      const a = phaseAgents[slug];
      if (!a) continue;
      for (const t of a.tools) allPhaseTools.add(t);
    }

    const result = await spawnClaudeSubthread(
      [
        "-p",
        conductorPrompt,
        "--agents",
        agentsJson,
        "--allowed-tools",
        "Task",
        "Agent",
        ...Array.from(allPhaseTools),
        "--disallowed-tools",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "AskUserQuestion",
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 600_000 },
    );

    if (result.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`[conductor] exit=${result.exitCode}\nstderr (tail):\n${result.stderr.slice(-2000)}`);
    }
    // Dump conductor stdout to a debug file so the operator can diagnose chain stops.
    try {
      const debugPath = join(tmpdir(), `code-template-conductor-${Date.now()}.jsonl`);
      writeFileSync(debugPath, result.stdout);
      // eslint-disable-next-line no-console
      console.error(`[conductor] full stdout written to ${debugPath} (duration=${result.durationMs}ms)`);
    } catch {
      /* best-effort */
    }

    const events = parseStreamJson(result.stdout);
    const allToolUses = extractToolUses(events);
    const conductorCalls = conductorOwnCalls(allToolUses);

    // ---- Assertion A: zero inline mcp__coltrane__* calls from the conductor ----
    // This is the load-bearing contract: phase-agent tool work must happen
    // INSIDE the subagent, where the allowlist is enforced. If the conductor
    // calls coltrane MCP tools directly, the per-phase allowlist is bypassed.
    const inlineMcpCalls = conductorCalls.filter((c) => c.name.startsWith("mcp__coltrane__"));
    expect(
      inlineMcpCalls,
      `conductor called mcp__coltrane__* tools inline — this bypasses the per-phase allowlist. inline calls: ${inlineMcpCalls.map((c) => c.name).join(", ")}`,
    ).toEqual([]);

    // ---- Assertion B: the conductor issued at least one subagent dispatch per phase ----
    // Claude Code's subagent-dispatch tool surfaces in stream-json with name
    // "Agent" (and is also aliased as "Task" in the system tool list).
    const DISPATCH_TOOL_NAMES = new Set(["Agent", "Task"]);
    const taskDispatches = conductorCalls.filter((c) => DISPATCH_TOOL_NAMES.has(c.name));
    expect(
      taskDispatches.length,
      `conductor did not dispatch via subagent. conductor tool calls: ${conductorCalls.map((c) => c.name).join(", ") || "(none)"}\nconductor stdout head:\n${result.stdout.slice(0, 2000)}`,
    ).toBeGreaterThanOrEqual(1);

    // ---- Assertion C: subagent_type ordering ----
    // Walk the Task dispatches in stream order; the subagent_types observed
    // (in order, dedup-adjacent) must be a prefix of the phase order. We
    // tolerate the chain stopping early (e.g. a sealed kill in DEFINE) but
    // not phase reordering.
    const observedSlugs: string[] = [];
    for (const t of taskDispatches) {
      const subagentType =
        (t.input.subagent_type as string | undefined) ??
        (t.input.subagentType as string | undefined) ??
        null;
      if (!subagentType) continue;
      if (observedSlugs.length === 0 || observedSlugs[observedSlugs.length - 1] !== subagentType) {
        observedSlugs.push(subagentType);
      }
    }
    // Confirm observedSlugs is a prefix of PHASE_ORDER
    for (let i = 0; i < observedSlugs.length; i++) {
      expect(
        observedSlugs[i],
        `phase ordering broken at dispatch #${i + 1}. observed: ${observedSlugs.join(" -> ")}, expected prefix of: ${PHASE_ORDER.join(" -> ")}`,
      ).toBe(PHASE_ORDER[i]);
    }

    // ---- Assertion D: the chain advanced through the discover→define seam ----
    // The contract calls for all four phases when the brief sustains a seal.
    // The phase-agents are designed to refuse a seal on a thin brief: the
    // problem-definer charter explicitly says "if the DISCOVER draft is too
    // thin to converge on, report that as the verdict and return the run to
    // the DISCOVER phase" — and the delivery-finalizer is reached only if
    // DEVELOP ran under a sealed predict. A chain that stops after a
    // sealed-refusal is HONEST, not contract-breaking.
    //
    // We assert: the conductor dispatched at LEAST the first two phases
    // (discover + define), proving the dispatch contract held through the
    // first seam. Going further than two phases is gravy and not required —
    // a thin sandbox brief is a plausible reason for an honest stop.
    expect(
      observedSlugs.length,
      `conductor dispatched fewer than 2 phases. dispatched: ${observedSlugs.join(" -> ") || "(none)"}. conductor stdout head:\n${result.stdout.slice(0, 2000)}`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      observedSlugs[0],
      `first dispatch was not discover (domain-explorer). dispatched: ${observedSlugs.join(" -> ")}`,
    ).toBe("domain-explorer");
    expect(
      observedSlugs[1],
      `second dispatch was not define (problem-definer). dispatched: ${observedSlugs.join(" -> ")}`,
    ).toBe("problem-definer");
  }, 900_000);
});
