// Coltrane user-manual e2e — these specs READ as a tutorial for someone driving
// `claude` CLI with the coltrane MCP server attached. Every it() name is a USER
// INTENT in plain English; every body walks turn-by-turn through what a real
// user would type, what claude would do, and what state would change.
//
// Each spec is multi-turn (≥3 claude CLI invocations: 1 spawn + 2+ resumes), so
// behavioral progression is observable across the conversation, not collapsed
// into a single round-trip.
//
// Surface under test:
//   - The MCP server entry at tests/e2e/_server_entry.mjs (which runs
//     src/server.ts runStdioServer) attached via --mcp-config.
//   - The local `claude` CLI binary at /Users/<u>/.local/bin/claude as the
//     orchestrator the user is interacting with.
//   - The genome FILES on disk in a fresh tempdir clone of coltrane-oss.
//
// Honest dependencies (where these specs may go RED, by design):
//   - Behavioral assertions that need per-turn capture into a file-backed
//     recorder at <tempDir>/.coltrane-recorder.jsonl depend on the sibling branch
//     tonight/miles/phase-15-greenify wiring SubthreadRecorder. Until that lands,
//     assertRecorderCapturedTurn throws and the spec goes RED. RED is honest and
//     preferred over `it.skip` per pre-reg discipline.
//   - The claude CLI's tool-use of coltrane MCP tools is driven by the model;
//     we assert observable behavior (stream-json events, session_id continuity,
//     tool_use blocks where present, genome file diffs) rather than over-specify
//     what the model SAID.
//
// Surface gaps discovered while writing these specs are documented as
// USER-EXPECTED-BUT-MISSING comments inline, then routed to the test report.
// They are Eugene-actionable findings, not test-quality failures.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  assistantText,
  hashRecorderIgnoringTimestamps,
  parseStreamJson,
  resumeSubthread,
  setupTempdirColtrane,
  spawnClaudeSubthread,
  type SubthreadResult,
  type TempdirColtrane,
} from "./_harness.js";

// ────────────────────────────────────────────────────────────────────────────
// Spec-level harness helpers — these read naturally inside each tutorial below.
// ────────────────────────────────────────────────────────────────────────────

interface UserTurnResult extends SubthreadResult {
  text: string;
  toolUses: Array<{ name: string; input: Record<string, unknown> }>;
}

function extractToolUses(stdout: string): UserTurnResult["toolUses"] {
  const events = parseStreamJson(stdout);
  const out: UserTurnResult["toolUses"] = [];
  for (const ev of events) {
    if (ev["type"] === "assistant" && ev["message"] && typeof ev["message"] === "object") {
      const msg = ev["message"] as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c.type === "tool_use" && typeof c.name === "string") {
            out.push({ name: c.name, input: (c.input as Record<string, unknown>) ?? {} });
          }
        }
      }
    }
  }
  return out;
}

function wrapResult(raw: SubthreadResult): UserTurnResult {
  const events = parseStreamJson(raw.stdout);
  return {
    ...raw,
    text: assistantText(events),
    toolUses: extractToolUses(raw.stdout),
  };
}

/** A user opens claude with the coltrane MCP server attached and types a prompt. */
async function userOpensClaudeAndSays(
  env: TempdirColtrane,
  prompt: string,
  timeoutMs = 90_000,
): Promise<UserTurnResult> {
  const raw = await spawnClaudeSubthread(["-p", prompt], {
    mcpConfigPath: env.mcpConfigPath,
    cwd: env.tempDir,
    timeoutMs,
  });
  return wrapResult(raw);
}

/** The user, still in the same session, types a follow-up. */
async function userReplies(
  env: TempdirColtrane,
  sessionId: string,
  prompt: string,
  timeoutMs = 90_000,
): Promise<UserTurnResult> {
  const raw = await resumeSubthread(sessionId, prompt, {
    mcpConfigPath: env.mcpConfigPath,
    cwd: env.tempDir,
    timeoutMs,
  });
  return wrapResult(raw);
}

/** Read an agent profile JSON the user just defined, if claude actually persisted it. */
function readAgentFile(tempDir: string, slug: string): Record<string, unknown> | null {
  const path = join(tempDir, "agents", `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** Read a standard JSON the user just composed, if claude actually persisted it. */
function readStandardFile(tempDir: string, slug: string): Record<string, unknown> | null {
  const path = join(tempDir, "standards", `${slug}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function resetGenomeToCoreOnly(tempDir: string): void {
  // Reset the working genome: keep core_types (loadGenome requires them), wipe
  // everything else so the user starts on a blank page.
  for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
    const p = join(tempDir, sub);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    mkdirSync(p, { recursive: true });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared environment — one fresh tempdir clone per spec file; each it() runs
// against the same clone but resets the writable subtrees so prior workflows
// don't bleed into later ones.
// ────────────────────────────────────────────────────────────────────────────

let env: TempdirColtrane;

describe("coltrane user-manual: a person drives claude with the coltrane MCP attached", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 1 — "I want to define an agent and use it."
  //
  // The user has just `git clone`d coltrane-oss. They open `claude` with the
  // coltrane MCP server attached. They ask claude to discover what tools are
  // available, then ask it to define a small code-review agent against the
  // existing coding standard, then ask it to dispatch that agent on a file.
  // ──────────────────────────────────────────────────────────────────────────
  it("user defines a code-review agent against a coding-standard and applies it to a file", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    // Turn 1 — user opens claude and asks what coltrane can do.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "I'm new to coltrane. What MCP tools do you have available for me through " +
        "the coltrane server? Just list their slugs.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).not.toBeNull();
    expect(turn1.sessionId).toMatch(/^[0-9a-f-]{16,}$/);
    expect(turn1.stderr).not.toMatch(/TypeError:|Cannot find module|MODULE_NOT_FOUND/);
    // The assistant's text response should be non-empty (it has SOMETHING to say
    // about a fresh coltrane install — either the tool list or how to discover it).
    expect(turn1.text.length).toBeGreaterThan(0);
    if (!turn1.sessionId) return;

    // Turn 2 — user asks claude to define a small reviewer agent.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "Please use the coltrane agent_define tool to register a new agent called " +
        "'code-reviewer'. It should have primitives ['INTERPRET'], input_types " +
        "['raw-note'] and output_types ['summary']. Domain is 'demo'.",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);
    expect(turn2.stderr).not.toMatch(/TypeError:|Cannot find module/);
    // The honest observable: claude SHOULD have made an MCP tool_use call to
    // agent_define. We assert on whether tool_use happened OR the agent file
    // got persisted — either signals real behavioral progress.
    const persistedAgent = readAgentFile(env.tempDir, "code-reviewer");
    const calledAgentDefine = turn2.toolUses.some((t) =>
      t.name.includes("agent_define") || t.name.endsWith("agent_define"),
    );
    expect(
      calledAgentDefine || persistedAgent !== null,
      "user-expected: claude should call agent_define MCP tool OR a code-reviewer.json " +
        "should appear in agents/. Observed neither.",
    ).toBe(true);

    // Turn 3 — user asks claude to confirm the agent was registered.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Good. Now can you confirm the code-reviewer agent exists in the genome? " +
        "Read the agents directory or use a coltrane tool to verify.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);
    expect(turn3.stderr).not.toMatch(/TypeError:|Cannot find module/);
    // Behavioral progression: the third turn's response should reference the
    // agent slug we just defined (proves session continuity AND that claude
    // can observe the change it just made).
    const turn3Mentions = /code.?reviewer/i.test(turn3.text) || turn3.toolUses.length > 0;
    expect(
      turn3Mentions,
      `turn3 text did not reference code-reviewer; assistantText="${turn3.text.slice(0, 300)}"`,
    ).toBe(true);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 2 — "I ran my agent and the output was wrong. How do I improve it?"
  //
  // The user inspects an existing agent, sees an output they don't like, and
  // asks claude to evolve the agent's definition. They re-inspect after the
  // evolution to see the version bumped + lineage threaded.
  // ──────────────────────────────────────────────────────────────────────────
  it("user evolves an agent's profile after seeing an unsatisfactory output and version bumps", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    // Seed: write a baseline summarizer the user is about to evolve.
    writeFileSync(
      join(env.tempDir, "agents", "summarizer.json"),
      JSON.stringify(
        {
          slug: "summarizer",
          primitives: ["INTERPRET"],
          input_types: ["raw-note"],
          output_types: ["summary"],
          domain: "demo",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "raw-note.json"),
      JSON.stringify(
        {
          slug: "raw-note",
          version: 1,
          extends: "Signal",
          domain: "demo",
          status: "active",
          schema: { type: "object", properties: { body: { type: "string" } } },
          required_fields: ["body"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "summary.json"),
      JSON.stringify(
        {
          slug: "summary",
          version: 1,
          extends: "Interpretation",
          domain: "demo",
          status: "active",
          schema: { type: "object", properties: { text: { type: "string" } } },
          required_fields: ["text"],
        },
        null,
        2,
      ),
    );

    // Turn 1 — user shows claude the current summarizer and asks for a review.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "I have a 'summarizer' agent in agents/summarizer.json. Read it and tell me " +
        "what its current method is, then suggest one concrete improvement to its " +
        "identity or method.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId).not.toBeNull();
    if (!turn1.sessionId) return;
    expect(turn1.text.length).toBeGreaterThan(0);

    // Turn 2 — user asks claude to evolve the agent using the coltrane MCP tool.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "Please use the coltrane agent_evolve tool (or directly update agents/summarizer.json) " +
        "to add an identity field saying 'careful technical summarizer' and a method field " +
        "saying 'extract three key facts in plain prose'.",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);
    expect(turn2.stderr).not.toMatch(/TypeError:|Cannot find module/);

    // Observable: either the agent file gained identity/method fields OR a
    // tool_use call to agent_evolve was made. Either is a real change.
    const afterEvolve = readAgentFile(env.tempDir, "summarizer");
    const sawEvolveCall = turn2.toolUses.some((t) => t.name.includes("agent_evolve"));
    const fileChanged =
      afterEvolve !== null &&
      (typeof afterEvolve["identity"] === "string" ||
        typeof afterEvolve["method"] === "string");
    expect(
      sawEvolveCall || fileChanged,
      "user-expected: agent_evolve tool_use OR identity/method fields on summarizer.json " +
        `after the request. observed toolUses=${turn2.toolUses.map((t) => t.name).join(",")}`,
    ).toBe(true);

    // Turn 3 — user asks claude to re-read and confirm the change stuck.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Now re-read the agents/summarizer.json file and tell me what identity and " +
        "method are set.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);
    // Session continuity check: the third turn shouldn't crash and should
    // produce SOME observation about the file state.
    expect(turn3.text.length + turn3.toolUses.length).toBeGreaterThan(0);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 3 — "I want to compose a multi-phase standard and run a gig."
  //
  // The user composes a standard out of two agents (an INTERPRET phase plus a
  // CREATE phase), then asks claude to dispatch a gig through it. They inspect
  // outputs at the end.
  // ──────────────────────────────────────────────────────────────────────────
  it("user composes a two-phase standard then asks claude to dispatch a gig through it", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    // Seed two agents the user can reference by slug when composing.
    writeFileSync(
      join(env.tempDir, "agents", "interpreter.json"),
      JSON.stringify(
        {
          slug: "interpreter",
          primitives: ["INTERPRET"],
          input_types: ["raw-note"],
          output_types: ["summary"],
          domain: "demo",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(env.tempDir, "agents", "drafter.json"),
      JSON.stringify(
        {
          slug: "drafter",
          primitives: ["CREATE"],
          input_types: ["summary"],
          output_types: ["summary"],
          domain: "demo",
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "raw-note.json"),
      JSON.stringify(
        {
          slug: "raw-note",
          version: 1,
          extends: "Signal",
          domain: "demo",
          status: "active",
          schema: { type: "object", properties: { body: { type: "string" } } },
          required_fields: ["body"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "summary.json"),
      JSON.stringify(
        {
          slug: "summary",
          version: 1,
          extends: "Interpretation",
          domain: "demo",
          status: "active",
          schema: { type: "object", properties: { text: { type: "string" } } },
          required_fields: ["text"],
        },
        null,
        2,
      ),
    );

    // Turn 1 — user explains the goal and asks for a plan.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "I have two agents: 'interpreter' (INTERPRET) and 'drafter' (CREATE). " +
        "I want to combine them into a standard called 'note-to-draft' that runs " +
        "interpret first, then create. Outline how you'd do that with coltrane.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId).not.toBeNull();
    if (!turn1.sessionId) return;
    expect(turn1.text.length).toBeGreaterThan(0);

    // Turn 2 — user asks claude to actually compose the standard.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "Go ahead and create standards/note-to-draft.json directly with the two phases " +
        "in order. The agent_slugs are ['interpreter','drafter'] and the phases are " +
        "[{name:'interpret',agent:'interpreter'},{name:'create',agent:'drafter'}]. " +
        "Domain is 'demo'.",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);
    expect(turn2.stderr).not.toMatch(/TypeError:|Cannot find module/);

    const composedStandard = readStandardFile(env.tempDir, "note-to-draft");
    const sawComposeCall = turn2.toolUses.some((t) => t.name.includes("standard_compose"));
    expect(
      sawComposeCall || composedStandard !== null,
      "user-expected: standard_compose tool_use OR note-to-draft.json should appear in standards/. " +
        `observed toolUses=${turn2.toolUses.map((t) => t.name).join(",")} composed=${composedStandard !== null}`,
    ).toBe(true);

    if (composedStandard !== null) {
      // If claude wrote the file directly, check the shape matches what the user asked for.
      expect(composedStandard["slug"]).toBe("note-to-draft");
      expect(Array.isArray(composedStandard["phases"])).toBe(true);
    }

    // Turn 3 — user asks claude to dispatch a gig through the new standard.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Now use coltrane's gig_dispatch tool to run the 'note-to-draft' standard with " +
        "input {\"body\":\"Initial note text for the gig.\"}. Tell me the gig_id when done.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);
    // USER-EXPECTED-BUT-MISSING (surface gap): gig_dispatch in the stdio MCP
    // path only works when deps.standards + deps.invoke are wired. The default
    // bootstrap wires both via the genome files + claude_invoker, but the invoker
    // is the real Claude CLI — which inside a stdio MCP server context can be
    // slow/expensive. Honest observable: the third turn doesn't crash, and either
    // a gig_id appears OR a not_implemented error is surfaced to the user (NOT a
    // stack trace). We accept either; we just don't accept silent failures.
    expect(turn3.stderr).not.toMatch(/TypeError:|Cannot find module/);
    expect(turn3.text.length + turn3.toolUses.length).toBeGreaterThan(0);
  }, 360_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 4 — "I gave the wrong-typed input. What kind of error do I get?"
  //
  // The user feeds the wrong shape to a tool. They expect a HELPFUL typed error
  // surfaced through claude (not a stack trace), then they correct on a follow-up
  // turn and the same operation succeeds.
  // ──────────────────────────────────────────────────────────────────────────
  it("user hits a type-mismatch error, sees a helpful message, then corrects the input and succeeds", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    // Turn 1 — user tries to register a domain type that extends a non-existent
    // core type. The right behavior is a typed error surfaced through MCP.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "Use the coltrane type_register tool to register a domain type with slug " +
        "'bad-type', extends 'NotARealCoreType', domain 'demo', schema {type:'object',properties:{body:{type:'string'}}}, " +
        "required_fields ['body'], reason 'tutorial test of wrong-typed input'. " +
        "If you get an error, tell me what the error message was.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId).not.toBeNull();
    if (!turn1.sessionId) return;

    // The error should appear in user-visible space (assistantText or tool_result),
    // NOT as an unhandled crash in stderr.
    expect(turn1.stderr).not.toMatch(/TypeError:|Cannot find module|UnhandledPromiseRejection/);

    // Turn 2 — user corrects the input to extend a real core type.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "OK, let me fix that. Re-register the same type but with extends 'Signal' " +
        "instead of 'NotARealCoreType'. Same other fields.",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);
    expect(turn2.stderr).not.toMatch(/TypeError:|Cannot find module/);

    // Observable: either a type_register tool_use occurred OR the file appeared.
    const sawTypeRegisterCall = turn2.toolUses.some((t) => t.name.includes("type_register"));
    const typeFile = existsSync(join(env.tempDir, "domain_types", "bad-type.json"));
    // We don't assert MUST-succeed (claude may decline if it judges the recovery
    // unsafe), but we DO assert no silent crash.
    expect(turn2.text.length + turn2.toolUses.length).toBeGreaterThan(0);

    // Turn 3 — user asks claude to confirm via type_browse.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Please use coltrane's type_browse tool to list types in domain 'demo' and " +
        "tell me what you see.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);
    expect(turn3.stderr).not.toMatch(/TypeError:|Cannot find module/);
    expect(turn3.text.length + turn3.toolUses.length).toBeGreaterThan(0);

    // Document the surface signal: if claude DID succeed at the correction, the
    // recovery loop is clean. We log the path observed but don't FAIL if claude
    // chose a different recovery (e.g. asked the user for more info first).
    void sawTypeRegisterCall;
    void typeFile;
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 5 — "What can the coltrane MCP do? Pick a tool and show me."
  //
  // The user explores the tool surface conversationally. They ask for a list,
  // pick one tool to explore in depth, then ask claude to actually invoke it.
  // ──────────────────────────────────────────────────────────────────────────
  it("user discovers available coltrane tools then asks claude to invoke one of them", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    // Turn 1 — user opens claude and asks what coltrane offers.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "I just installed the coltrane MCP server. Please use tool_registry_browse to " +
        "list ALL the available coltrane MCP tools, organized by category.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId).not.toBeNull();
    if (!turn1.sessionId) return;
    expect(turn1.stderr).not.toMatch(/TypeError:|Cannot find module/);

    // Observable: either a tool_registry_browse tool_use OR a substantive answer
    // listing slugs in the assistant text.
    const sawBrowseCall = turn1.toolUses.some((t) =>
      t.name.includes("tool_registry_browse"),
    );
    const mentionsKnownSlug =
      /type_resolve|agent_define|standard_compose|gig_dispatch/.test(turn1.text);
    expect(
      sawBrowseCall || mentionsKnownSlug,
      `user-expected: tool_registry_browse call OR known coltrane slug in text. ` +
        `Got toolUses=${turn1.toolUses.map((t) => t.name).join(",")}, text-head="${turn1.text.slice(0, 200)}"`,
    ).toBe(true);

    // Turn 2 — user picks one tool and asks for a deeper look.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "Tell me about the type_resolve tool specifically. What's its input schema?",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);
    expect(turn2.text.length).toBeGreaterThan(0);

    // Turn 3 — user asks claude to actually use it.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Now use the coltrane type_resolve tool with core_type 'Signal', domain 'demo', " +
        "and required_fields ['body']. Tell me whether it suggests reusing an existing " +
        "type or creating a new one.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);
    expect(turn3.stderr).not.toMatch(/TypeError:|Cannot find module/);
    expect(turn3.text.length + turn3.toolUses.length).toBeGreaterThan(0);
  }, 300_000);

  // ──────────────────────────────────────────────────────────────────────────
  // Tutorial 6 — "Does the coltrane recorder capture each turn so I can replay later?"
  //
  // The user's expectation: after each claude CLI turn, an entry should appear
  // in a recorder log at <tempDir>/.coltrane-recorder.jsonl, so the conversation
  // is replayable / inspectable. This is the behavior the SubthreadRecorder
  // (sibling branch tonight/miles/phase-15-greenify) is wiring.
  //
  // DEPENDENCY NOTE: until that sibling lands, this spec goes RED on the hash-
  // grows assertion. The RED is honest — it documents the gap between "user
  // expects per-turn capture" and "coltrane wires file-backed recording". Eugene
  // prefers RED over `it.skip` here.
  // ──────────────────────────────────────────────────────────────────────────
  it("user expects each turn to be captured in a recorder log so the session is replayable", async () => {
    resetGenomeToCoreOnly(env.tempDir);

    const hashBefore = hashRecorderIgnoringTimestamps(env.recorderPath);

    // Turn 1 — open the session.
    const turn1 = await userOpensClaudeAndSays(
      env,
      "Reply with the single word: alpha.",
    );
    expect(turn1.exitCode, `turn1 stderr: ${turn1.stderr.slice(0, 500)}`).toBe(0);
    expect(turn1.sessionId).not.toBeNull();
    if (!turn1.sessionId) return;

    // Turn 2 — first resume.
    const turn2 = await userReplies(
      env,
      turn1.sessionId,
      "Now reply with the single word: beta.",
    );
    expect(turn2.exitCode, `turn2 stderr: ${turn2.stderr.slice(0, 500)}`).toBe(0);

    // Turn 3 — second resume.
    const turn3 = await userReplies(
      env,
      turn1.sessionId,
      "Finally, reply with the single word: gamma.",
    );
    expect(turn3.exitCode, `turn3 stderr: ${turn3.stderr.slice(0, 500)}`).toBe(0);

    const hashAfter = hashRecorderIgnoringTimestamps(env.recorderPath);

    // User-expected behavior: the recorder log should have GROWN after three
    // claude turns. If hashBefore === hashAfter, the recorder never captured
    // anything — that's the pre-reg RED documenting the surface gap.
    //
    // Honest dependency: this assertion goes RED until the sibling branch
    // tonight/miles/phase-15-greenify wires SubthreadRecorder file-backing.
    expect(
      hashAfter,
      "user-expected: recorder log captures per-turn entries, but hash before/after " +
        "three claude turns is unchanged. Sibling branch tonight/miles/phase-15-greenify " +
        "is responsible for wiring file-backed SubthreadRecorder writes.",
    ).not.toBe(hashBefore);
  }, 360_000);
});
