// User manual for driving Claude Code with the coltrane MCP server attached.
//
// Each describe() block is a user story. Each it() is something a human types
// into `claude -p`. Read top-to-bottom to learn the workflow:
//
//   1. Define a new agent.
//   2. Iterate on the same agent across turns.
//   3. Compose two agents into a standard.
//   4. Diagnose a type error.
//   5. Inspect what's already in the repo.
//   6. Resume a conversation after a break.
//
// Run live:
//   npx vitest run --config tests/e2e/vitest.config.ts \
//     tests/e2e/user_drives_claude_with_coltrane.spec.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
  type SubthreadResult,
} from "./_harness.js";

// e2e tests run non-interactively, so we bypass the per-tool permission prompt.
// In a real terminal session a user would approve mcp__coltrane__* tools the
// first time they're invoked, or pre-approve them in settings.
const SKIP_PERMS = "--dangerously-skip-permissions";

async function askClaude(
  prompt: string,
  env: TempdirColtrane,
  timeoutMs = 180_000,
): Promise<SubthreadResult> {
  return spawnClaudeSubthread(["-p", prompt, SKIP_PERMS], {
    mcpConfigPath: env.mcpConfigPath,
    cwd: env.tempDir,
    timeoutMs,
  });
}

async function askClaudeResume(
  sessionId: string,
  prompt: string,
  env: TempdirColtrane,
  timeoutMs = 180_000,
): Promise<SubthreadResult> {
  return spawnClaudeSubthread(["--resume", sessionId, "-p", prompt, SKIP_PERMS], {
    mcpConfigPath: env.mcpConfigPath,
    cwd: env.tempDir,
    timeoutMs,
  });
}

// Read the stream-json transcript Claude emits.
// A user driving Claude with --output-format stream-json sees these same events.
function toolUses(stdout: string): Array<{ name: string; input: Record<string, unknown> }> {
  const events = parseStreamJson(stdout);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const msg = ev.message as
      | { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> }
      | undefined;
    if (!msg?.content) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        calls.push({ name: block.name, input: block.input ?? {} });
      }
    }
  }
  return calls;
}

function coltraneToolUses(stdout: string): Array<{ name: string; input: Record<string, unknown> }> {
  return toolUses(stdout).filter((c) => c.name.startsWith("mcp__coltrane__"));
}

describe("a fresh user defines a new agent", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("asks claude to add an agent that summarizes a body of text", async () => {
    const r = await askClaude(
      [
        "I'm working in this coltrane repo.",
        "Please define a new agent named 'meeting-summarizer'.",
        "Use the coltrane MCP tool agent_define directly.",
        "Set primitives to ['INTERPRET'], input_types to ['raw-note'] (it already exists in domain_types/), output_types to ['summary'].",
        "Just call the tool and tell me what came back.",
      ].join(" "),
      env,
    );

    expect(r.exitCode, `claude stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);

    const defined = coltraneToolUses(r.stdout).find((c) => c.name === "mcp__coltrane__agent_define");
    expect(defined, "claude did not call agent_define").toBeDefined();
    expect(defined!.input.slug).toBe("meeting-summarizer");

    // agent_define persists agents/<slug>.json under the genome dir.
    const onDisk = join(env.tempDir, "agents", "meeting-summarizer.json");
    expect(existsSync(onDisk), `expected agent file at ${onDisk}`).toBe(true);
    const profile = JSON.parse(readFileSync(onDisk, "utf-8")) as { slug: string; primitives: string[] };
    expect(profile.slug).toBe("meeting-summarizer");
    expect(profile.primitives).toContain("INTERPRET");
  }, 240_000);
});

describe("a user iterates on the same agent across turns", () => {
  let env: TempdirColtrane;
  let session1: string | null = null;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("turn 1: asks claude to define a sensor agent", async () => {
    const r = await askClaude(
      [
        "Use the coltrane MCP tool agent_define to register an agent.",
        "slug: 'log-sensor', primitives: ['SENSE'], output_types: ['raw-note'].",
        "Just call the tool.",
      ].join(" "),
      env,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    expect(r.sessionId, "claude did not emit a session_id").not.toBeNull();
    session1 = r.sessionId;

    const calls = coltraneToolUses(r.stdout);
    expect(calls.some((c) => c.name === "mcp__coltrane__agent_define")).toBe(true);
    expect(existsSync(join(env.tempDir, "agents", "log-sensor.json"))).toBe(true);
  }, 240_000);

  it("turn 2: resumes the same conversation and asks claude to read the agent back", async () => {
    expect(session1, "turn 1 did not register a session_id to resume").toBeTruthy();

    const r = await askClaudeResume(
      session1!,
      "Now read the file agents/log-sensor.json from disk using the Read tool and reply with the value of its `primitives` field. Don't call any MCP tool.",
      env,
      120_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const reply = assistantText(parseStreamJson(r.stdout));
    expect(reply, `assistant reply:\n${reply}`).toMatch(/SENSE/);
  }, 240_000);
});

describe("a user composes two agents into a standard", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("asks claude to define two agents and compose them into a standard", async () => {
    const r = await askClaude(
      [
        "Use the coltrane MCP tools to do exactly three calls in order:",
        "",
        "Call 1 — agent_define with arguments:",
        "  slug='note-sensor', primitives=['SENSE'], output_types=['raw-note'].",
        "",
        "Call 2 — agent_define with arguments:",
        "  slug='note-summarizer', primitives=['INTERPRET'], input_types=['raw-note'], output_types=['summary'].",
        "",
        "Call 3 — standard_compose with arguments:",
        "  slug='notes-pipeline', domain='demo',",
        "  agents=[",
        "    {slug:'note-sensor', primitives:['SENSE'], input_types:[], output_types:['raw-note'], domain:'demo'},",
        "    {slug:'note-summarizer', primitives:['INTERPRET'], input_types:['raw-note'], output_types:['summary'], domain:'demo'}",
        "  ],",
        "  phases=[{name:'sense', agent:'note-sensor'}, {name:'interpret', agent:'note-summarizer'}].",
        "",
        "Make all three calls. Don't ask questions.",
      ].join("\n"),
      env,
      420_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);

    const names = coltraneToolUses(r.stdout).map((c) => c.name);
    expect(names.filter((n) => n === "mcp__coltrane__agent_define").length).toBeGreaterThanOrEqual(2);
    expect(names).toContain("mcp__coltrane__standard_compose");

    expect(existsSync(join(env.tempDir, "agents", "note-sensor.json"))).toBe(true);
    expect(existsSync(join(env.tempDir, "agents", "note-summarizer.json"))).toBe(true);
    expect(existsSync(join(env.tempDir, "standards", "notes-pipeline.json"))).toBe(true);
  }, 480_000);
});

describe("a user hits a type error and asks claude to diagnose it", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("asks claude to write an output that's missing a required field, then explain the rejection", async () => {
    const r = await askClaude(
      [
        "Call the coltrane MCP tool output_write exactly once with these arguments:",
        "core_type='Interpretation', domain_type='summary', domain='demo',",
        "gig_id='manual-gig', agent_slug='summarizer', phase='interpret',",
        "data={} (empty object — that's intentional).",
        "Don't retry. Just call it once and tell me what the tool returned.",
      ].join(" "),
      env,
      360_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);

    const calls = coltraneToolUses(r.stdout);
    expect(calls.some((c) => c.name === "mcp__coltrane__output_write")).toBe(true);

    // The rejection signal lives in the tool_result block of the stream-json transcript.
    // A user driving Claude sees this same content as the tool's reply.
    const events = parseStreamJson(r.stdout);
    let rejectedMentionedAnywhere = false;
    for (const ev of events) {
      const msg = (ev as { message?: { content?: Array<{ type?: string; text?: string; content?: unknown }> } }).message;
      if (!msg?.content) continue;
      for (const block of msg.content) {
        const blob = JSON.stringify(block).toLowerCase();
        if (/rejected|required|invalid|missing|gist|fail/.test(blob)) {
          rejectedMentionedAnywhere = true;
        }
      }
    }
    expect(rejectedMentionedAnywhere, "no rejection/required/invalid signal visible in the transcript").toBe(true);
  }, 420_000);
});

describe("a user inspects what's already in the repo", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("asks claude to list the domain types using type_browse", async () => {
    const r = await askClaude(
      [
        "Call the coltrane MCP tool type_browse exactly once.",
        "Pass an empty object {} as its arguments.",
        "Then reply with the slugs of the types it returned, one per line.",
      ].join(" "),
      env,
      300_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);

    const calls = coltraneToolUses(r.stdout);
    expect(calls.some((c) => c.name === "mcp__coltrane__type_browse")).toBe(true);

    // Either the assistant's prose OR the tool_result block carries the type slugs.
    const events = parseStreamJson(r.stdout);
    let typeSlugSeen = false;
    for (const ev of events) {
      const msg = (ev as { message?: { content?: Array<{ type?: string; text?: string; content?: unknown }> } }).message;
      if (!msg?.content) continue;
      for (const block of msg.content) {
        const blob = JSON.stringify(block);
        if (/Signal|raw-note|summary|Interpretation/.test(blob)) {
          typeSlugSeen = true;
        }
      }
    }
    expect(typeSlugSeen, "no type slug surfaced in transcript").toBe(true);
  }, 360_000);
});

describe("a user resumes a conversation after a break", () => {
  let env: TempdirColtrane;
  let sid: string | null = null;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 300_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("turn 1: starts a conversation and gives claude a project codename to remember", async () => {
    const r = await askClaude(
      "I'm going to call this project 'osprey'. Just reply with the word 'noted'.",
      env,
      60_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    expect(r.sessionId).not.toBeNull();
    sid = r.sessionId;
  }, 120_000);

  it("turn 2: resumes after a pause and asks claude to recall the codename", async () => {
    expect(sid).toBeTruthy();

    const r = await askClaudeResume(
      sid!,
      "What was the project codename I gave you a moment ago? Reply with just the one-word codename.",
      env,
      60_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const reply = assistantText(parseStreamJson(r.stdout)).toLowerCase();
    expect(reply, `assistant reply:\n${reply}`).toMatch(/osprey/);
  }, 120_000);

  it("turn 3: resumes once more and asks claude to define an agent named after the codename", async () => {
    expect(sid).toBeTruthy();

    const r = await askClaudeResume(
      sid!,
      [
        "The codename from earlier is the slug.",
        "Call the coltrane MCP tool agent_define exactly once with these arguments:",
        "slug='osprey', primitives=['SENSE'], output_types=['raw-note'].",
        "Just call the tool.",
      ].join(" "),
      env,
      300_000,
    );

    expect(r.exitCode, `stderr:\n${r.stderr.slice(0, 800)}`).toBe(0);
    const defined = coltraneToolUses(r.stdout).find((c) => c.name === "mcp__coltrane__agent_define");
    expect(defined, "claude did not call agent_define").toBeDefined();
    expect(String(defined!.input.slug ?? "").toLowerCase()).toMatch(/osprey/);
    expect(existsSync(join(env.tempDir, "agents", `${defined!.input.slug as string}.json`))).toBe(true);
  }, 360_000);
});
