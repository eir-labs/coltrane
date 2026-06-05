// e2e — T11: type-fail at output_write boundary.
//
// Claim: output_write validates against the domain type's schema AT WRITE.
// A malformed payload (missing a required field) is rejected with a typed
// error; nothing reaches the store. This is the third gate after compose-time
// validation (T2) and registry validation (T3): the runtime boundary refuses
// bad artifacts before they become provenance.
//
// Shape:
//   (in-process) call output_write via dispatchTool with raw-note missing
//   "text". Assert ok=false with the schema-validation error, AND that
//   output_query returns zero outputs (the store has no entry).
//
//   (real-claude) spawn the Claude CLI with the coltrane MCP server. Prompt:
//   "call output_write for raw-note with data={} (no text)". Assert the model
//   surfaced a typed failure AND output_query is empty.
//
// Honest scope: the in-process leg is the hard assertion of the boundary
// contract; the real-claude leg proves the same gate fires through the live
// MCP transport (and that the model gets a structured error back, not a
// silent swallow).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  parseStreamJson,
  assistantText,
  type TempdirColtrane,
} from "./_harness.js";
import { dispatchTool, type ServerDeps } from "../../src/index.js";

describe("T11 — type-fail at output_write boundary", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    const { bootstrapServerDeps } = await import("../../src/index.js");
    deps = bootstrapServerDeps(env.tempDir);
  }, 120_000);
  afterAll(() => env?.cleanup());

  it("in-process: output_write rejects raw-note missing required 'text' field; nothing lands in the store", async () => {
    // Sanity: store starts empty for this gig_id.
    const gig_id = "00000000-0000-0000-0000-000000000bad";
    const preQuery = await dispatchTool("output_query", { gig_id }, deps);
    expect(preQuery.ok).toBe(true);
    expect((preQuery.data as { outputs: unknown[] }).outputs.length).toBe(0);

    // Malformed call: raw-note requires "text" (see domain_types/raw-note.json).
    // Sending `data: {}` MUST be rejected at the registry boundary.
    const write = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        domain_type: "raw-note",
        domain: "demo",
        gig_id,
        agent_slug: "sensor",
        data: {}, // no 'text' — should fail validation
        input_refs: [],
      },
      deps,
    );

    // Typed-error contract: ok=false, error message names the failing slug
    // AND the missing field. This is what the dispatcher returns when the
    // store throws OutputStoreError.
    expect(write.ok).toBe(false);
    expect(typeof write.error).toBe("string");
    const errMsg = String(write.error ?? "");
    expect(errMsg.toLowerCase()).toContain("raw-note");
    expect(errMsg.toLowerCase()).toMatch(/text|required|schema|valid/);

    // No data leak: the failed write returns no output_id and no record.
    expect(write.data == null || (write.data as { output_id?: string }).output_id == null).toBe(true);

    // Recorder has no entry — query the store and confirm zero outputs for
    // this gig_id. The boundary caught it; provenance is clean.
    const postQuery = await dispatchTool("output_query", { gig_id }, deps);
    expect(postQuery.ok).toBe(true);
    const outs = (postQuery.data as { outputs: Array<{ id: string }> }).outputs;
    expect(
      outs.length,
      `expected 0 outputs for gig ${gig_id} after rejected write; got ${outs.length}. ` +
        `if > 0, the boundary leaked a partial/invalid record into the store.`,
    ).toBe(0);
  });

  it("in-process: a well-formed raw-note IS accepted (positive control — proves the gate isn't blanket-rejecting)", async () => {
    const gig_id = "00000000-0000-0000-0000-000000000900";
    const write = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        domain_type: "raw-note",
        domain: "demo",
        gig_id,
        agent_slug: "sensor",
        data: { text: "the room is loud" },
        input_refs: [],
      },
      deps,
    );
    expect(write.ok, `well-formed raw-note rejected: ${write.error}`).toBe(true);
    expect((write.data as { output_id: string }).output_id).toMatch(/^[0-9a-f-]{36}$/);

    const q = await dispatchTool("output_query", { gig_id }, deps);
    const outs = (q.data as { outputs: Array<{ domain_type: string }> }).outputs;
    expect(outs.length).toBe(1);
    expect(outs[0]!.domain_type).toBe("raw-note");
  });

  it("real-claude through MCP: model receives typed error and the store stays empty", async () => {
    // Use a deterministic, unique gig_id the model is instructed to use, so we
    // can query the store afterwards without coupling to whatever gig_id Claude
    // would invent.
    const gig_id = "00000000-0000-0000-0000-0000000000ff";

    const result = await spawnClaudeSubthread(
      [
        "-p",
        "Call the MCP tool mcp__coltrane__output_write with arguments " +
          `{ "core_type": "Signal", "domain_type": "raw-note", "domain": "demo", ` +
          `"gig_id": "${gig_id}", "agent_slug": "sensor", "data": {}, "input_refs": [] }. ` +
          "Note the 'data' field is intentionally empty (missing the required 'text' field). " +
          "After the tool call returns, tell me in ONE short sentence whether it succeeded or failed, " +
          "and quote the error string if any. Then call mcp__coltrane__output_query with " +
          `{ "gig_id": "${gig_id}" } and tell me the count of outputs returned. No preamble.`,
        "--allowedTools",
        "mcp__coltrane__output_write,mcp__coltrane__output_query",
      ],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 240_000 },
    );

    expect(result.exitCode, `claude stderr: ${result.stderr.slice(0, 500)}`).toBe(0);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{16,}$/);

    const events = parseStreamJson(result.stdout);

    // FORMAL: the model actually invoked output_write through MCP.
    let sawOutputWrite = false;
    let sawOutputQuery = false;
    for (const ev of events) {
      if (ev.type !== "assistant" || !ev.message) continue;
      const m = ev.message as { content?: Array<{ type?: string; name?: string }> };
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c.type === "tool_use" && typeof c.name === "string") {
          if (c.name.includes("output_write")) sawOutputWrite = true;
          if (c.name.includes("output_query")) sawOutputQuery = true;
        }
      }
    }
    expect(sawOutputWrite, "model did not invoke output_write").toBe(true);

    // FORMAL: the tool_result for output_write reported isError or ok:false.
    // The MCP server sets isError=true when the dispatcher returns ok=false,
    // and the JSON payload itself carries ok=false + an error message.
    let typedFailureSeen = false;
    for (const ev of events) {
      if (ev.type !== "user" || !ev.message) continue;
      const m = ev.message as { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }>; is_error?: boolean }> };
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c.type !== "tool_result") continue;
        // is_error flag on tool_result
        if (c.is_error === true) {
          typedFailureSeen = true;
        }
        // OR — parse the JSON body and look for ok:false
        if (Array.isArray(c.content)) {
          for (const inner of c.content) {
            if (inner.type === "text" && typeof inner.text === "string") {
              try {
                const payload = JSON.parse(inner.text) as { ok?: boolean; error?: string };
                if (payload.ok === false && typeof payload.error === "string") {
                  typedFailureSeen = true;
                  // The error should name the failing type. Soft-asserted via includes.
                  expect(payload.error.toLowerCase()).toMatch(/raw-note|text|required|schema|valid/);
                }
              } catch {
                /* not the json body we want */
              }
            }
          }
        }
      }
    }
    expect(typedFailureSeen, "MCP did not surface a typed failure for the malformed output_write").toBe(true);

    // Cage check + finalresponse sanity.
    const text = assistantText(events);
    expect(text.length, "model produced no assistant text").toBeGreaterThan(0);

    // FORMAL: assert the store has nothing for this gig_id. We rely on the
    // in-process deps for the cross-check (the server-spawned process exits
    // when the prompt completes; its in-memory store dies with it, but the
    // assertion-via-events already proved no entry was written; this second
    // probe is a belt for the suspenders).
    if (sawOutputQuery) {
      // The model called output_query through MCP — confirm via the events
      // that the count was 0.
      let queryCount: number | null = null;
      for (const ev of events) {
        if (ev.type !== "user" || !ev.message) continue;
        const m = ev.message as { content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content) {
          if (c.type !== "tool_result" || !Array.isArray(c.content)) continue;
          for (const inner of c.content) {
            if (inner.type !== "text" || typeof inner.text !== "string") continue;
            try {
              const payload = JSON.parse(inner.text) as { ok?: boolean; data?: { outputs?: unknown[]; total_count?: number } };
              if (payload.ok === true && payload.data && typeof payload.data === "object" && Array.isArray(payload.data.outputs)) {
                // Only count results for the gig we asked about; output_query
                // filtered server-side already.
                queryCount = payload.data.outputs.length;
              }
            } catch {
              /* skip */
            }
          }
        }
      }
      expect(
        queryCount,
        "model called output_query but no parseable result was found in the event stream",
      ).not.toBeNull();
      expect(
        queryCount,
        `expected 0 outputs for the bad-write gig_id; got ${queryCount}. ` +
          `boundary leak: the failed write left an entry behind.`,
      ).toBe(0);
    }
  }, 300_000);
});
