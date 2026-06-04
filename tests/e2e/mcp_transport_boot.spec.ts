// T20 — MCP transport boot: stdio JSON-RPC framing completes a tool call
// from a real client (not just dispatchTool() called directly).
//
// What this test answers: when a client speaks JSON-RPC over stdio to the
// compiled `_server_entry.mjs`, does the framing actually deliver a CallTool
// request to the dispatcher AND return its result back across the transport?
//
// coltrane_full_workflow.spec.ts step 18 already proves `tools/list` round-trips.
// This dedicated spec adds the load-bearing case: a `tools/call` request must
// produce a structured tool result (content[0].text → JSON envelope with `ok`,
// `data`), and an unknown-tool call must return a typed error across the wire
// — proving the framing carries both happy + sad paths, not just metadata.
//
// Pre-reg honesty: no stubbed dispatch, no in-process shortcut. The server is
// spawned as a child process; the test client owns one stdin/stdout JSON-RPC
// channel. If the transport drops a frame or the dispatcher fails to return,
// the test goes RED — that's the bug surface T20 exists to catch.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

describe("T20 — MCP stdio JSON-RPC framing completes a real tool call", () => {
  let env: TempdirColtrane;
  let child: ChildProcessWithoutNullStreams;
  let stdoutBuf = "";
  let stderrBuf = "";
  const pendingById = new Map<number, JsonRpcResponse>();

  beforeAll(async () => {
    env = await setupTempdirColtrane();

    child = spawn("npx", ["tsx", env.mcpServerEntry], {
      cwd: env.tempDir,
      env: { ...process.env, COLTRANE_GENOME: env.tempDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (b: Buffer) => {
      stdoutBuf += b.toString();
      // parse newline-framed JSON-RPC responses and index by id
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number") pendingById.set(msg.id, msg);
        } catch { /* not json, ignore */ }
      }
    });
    child.stderr.on("data", (b: Buffer) => { stderrBuf += b.toString(); });

    const send = (msg: object): void => {
      child.stdin.write(JSON.stringify(msg) + "\n");
    };

    // JSON-RPC initialize handshake (MCP requirement before any tool calls)
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "T20-transport-boot", version: "0.0.0" },
      },
    });
    await waitForId(pendingById, 1, 15_000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }, 60_000);

  afterAll(() => {
    try { child?.kill("SIGTERM"); } catch { /* best effort */ }
    env?.cleanup();
  });

  it("tools/call routes a real tool through stdio framing and returns its result envelope", async () => {
    // Pick a deterministic, context-free tool: `system_health` derives its result
    // from the loaded genome stores (no LLM, no approval gating, no runtime deps).
    // If framing drops or dispatcher fails, this never returns.
    const send = (msg: object): void => { child.stdin.write(JSON.stringify(msg) + "\n"); };
    send({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "system_health", arguments: {} },
    });

    const res = await waitForId(pendingById, 100, 15_000);
    expect(
      res,
      `tools/call(system_health) never returned over stdio. stderr:\n${stderrBuf.slice(0, 1500)}`,
    ).not.toBeNull();
    expect(res!.error, `unexpected JSON-RPC error: ${JSON.stringify(res!.error)}`).toBeUndefined();

    // The MCP SDK wraps tool results as { content: [{ type:"text", text: <json> }] }.
    // Unwrap and verify it's the dispatcher's ToolResult envelope with ok=true.
    const result = res!.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    expect(result, "tools/call result missing").toBeDefined();
    expect(result!.isError, "system_health should not be flagged isError").toBeFalsy();
    expect(Array.isArray(result!.content), "result.content must be an array").toBe(true);
    expect(result!.content!.length).toBeGreaterThan(0);

    const text = result!.content![0]!.text;
    expect(typeof text, "content[0].text must be a string JSON envelope").toBe("string");
    const envelope = JSON.parse(text!) as { ok: boolean; data?: { types?: number; outputs?: number; gigs_run?: number } };
    expect(envelope.ok, `tool returned not-ok over the wire: ${text}`).toBe(true);
    expect(envelope.data, "system_health envelope missing data block").toBeDefined();
    // system_health surfaces genome cardinality — at minimum the loaded types count must exist
    expect(typeof envelope.data!.types).toBe("number");
    expect(envelope.data!.types).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("tools/call against an unknown tool returns a typed error envelope across the wire", async () => {
    // Sad-path framing: the dispatcher rejects unknown slugs with ok=false. The
    // SDK should mark isError=true and carry the error envelope back. This proves
    // the transport delivers failure cases too, not just success.
    const send = (msg: object): void => { child.stdin.write(JSON.stringify(msg) + "\n"); };
    send({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "definitely_not_a_real_tool_t20", arguments: {} },
    });

    const res = await waitForId(pendingById, 101, 15_000);
    expect(res, "unknown-tool call never returned over stdio").not.toBeNull();

    // Two acceptable shapes: (1) JSON-RPC method error, or (2) SDK-wrapped result
    // with isError=true. coltrane's dispatcher returns the latter (ok:false envelope).
    if (res!.error) {
      expect(typeof res!.error.message).toBe("string");
    } else {
      const result = res!.result as { content?: Array<{ text?: string }>; isError?: boolean };
      expect(result.isError, "unknown tool should set isError=true").toBe(true);
      const envelope = JSON.parse(result.content![0]!.text!) as { ok: boolean; error?: string };
      expect(envelope.ok).toBe(false);
      expect(envelope.error, "unknown tool must carry an error string").toMatch(/unknown tool/i);
    }
  }, 30_000);

  it("tools/list and tools/call share the same long-lived stdio channel (multiplexed requests)", async () => {
    // Final guard: a single connected child handles multiple interleaved requests
    // without losing frames. Send list + call back-to-back; both ids must resolve.
    const send = (msg: object): void => { child.stdin.write(JSON.stringify(msg) + "\n"); };
    send({ jsonrpc: "2.0", id: 200, method: "tools/list", params: {} });
    send({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: { name: "tool_registry_browse", arguments: {} },
    });

    const listRes = await waitForId(pendingById, 200, 15_000);
    const callRes = await waitForId(pendingById, 201, 15_000);

    expect(listRes, "tools/list dropped in multiplex").not.toBeNull();
    expect(callRes, "tools/call dropped in multiplex").not.toBeNull();

    const tools = (listRes!.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
    expect(tools, "tools/list returned no tools array").toBeDefined();
    expect(tools!.length).toBeGreaterThan(10);

    const callResult = callRes!.result as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(callResult.isError).toBeFalsy();
    const envelope = JSON.parse(callResult.content![0]!.text!) as { ok: boolean; data?: { tools?: unknown[] } };
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data!.tools)).toBe(true);
  }, 45_000);
});

/**
 * Poll the response map for a given JSON-RPC id with a timeout. Returns the
 * response (or null if it never arrived within the deadline).
 */
async function waitForId(
  pending: Map<number, JsonRpcResponse>,
  id: number,
  timeoutMs: number,
): Promise<JsonRpcResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = pending.get(id);
    if (msg) {
      pending.delete(id);
      return msg;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
