// Unit tests for the relay's JSON-RPC message routing.
//
// The relay's correctness reduces to: which inbound messages does it
// intercept (server_restart), which outbound responses does it augment
// (tools/list), and what does it forward verbatim (everything else). The
// child-process spawn/kill loop is harder to test in-process; the FAILING
// half of it (a swap whose new child never serves) is pinned by
// tests/relay_restart_failure.test.ts, which drives the real relay over stdio.

import { describe, it, expect } from "vitest";
import {
  matchServerRestart,
  isToolsListResponse,
  augmentToolsList,
  buildRestartResponse,
  buildRestartError,
  buildNoChildError,
  initRequestId,
} from "../src/server_relay.js";

describe("server_relay — server_restart interception", () => {
  it("matches a tools/call for server_restart and returns its id", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 42,
      method: "tools/call",
      params: { name: "server_restart", arguments: {} },
    };
    expect(matchServerRestart(msg)).toBe(42);
  });

  it("ignores tools/call for other tools", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 7,
      method: "tools/call",
      params: { name: "gig_dispatch", arguments: {} },
    };
    expect(matchServerRestart(msg)).toBeUndefined();
  });

  it("ignores non-tools/call methods", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/list",
      params: {},
    };
    expect(matchServerRestart(msg)).toBeUndefined();
  });

  it("treats null id as a valid match (notifications-shaped requests)", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: null,
      method: "tools/call",
      params: { name: "server_restart" },
    };
    expect(matchServerRestart(msg)).toBe(null);
  });
});

describe("server_relay — tools/list augmentation", () => {
  it("detects a tools/list response by its result.tools shape", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { tools: [{ name: "gig_dispatch" }] },
    };
    expect(isToolsListResponse(msg)).toBe(true);
  });

  it("rejects responses without a tools array", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { ok: true },
    };
    expect(isToolsListResponse(msg)).toBe(false);
  });

  it("rejects requests (anything with a method)", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "tools/list",
      result: { tools: [] },
    };
    expect(isToolsListResponse(msg)).toBe(false);
  });

  it("appends server_restart to a tools/list response", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { tools: [{ name: "gig_dispatch" }] },
    };
    augmentToolsList(msg);
    const tools = (msg.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toContain("server_restart");
    expect(tools).toHaveLength(2);
  });

  it("does not double-insert server_restart if the child already advertises it", () => {
    const msg = {
      jsonrpc: "2.0" as const,
      id: 1,
      result: { tools: [{ name: "server_restart" }, { name: "gig_dispatch" }] },
    };
    augmentToolsList(msg);
    const tools = (msg.result as { tools: { name: string }[] }).tools;
    expect(tools.filter((t) => t.name === "server_restart")).toHaveLength(1);
  });
});

describe("server_relay — captured-handshake replay", () => {
  it("extracts the initialize request id from a captured raw line", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(initRequestId(line)).toBe(1);
  });
  it("returns undefined for a null capture (no initialize seen yet)", () => {
    expect(initRequestId(null)).toBeUndefined();
  });
  it("returns undefined for an unparseable line", () => {
    expect(initRequestId("not json")).toBeUndefined();
  });
  it("preserves a null id", () => {
    expect(initRequestId(JSON.stringify({ jsonrpc: "2.0", id: null, method: "initialize" }))).toBe(null);
  });
});

describe("server_relay — restart response shape", () => {
  it("builds a JSON-RPC response carrying the original id", () => {
    const resp = buildRestartResponse(99);
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 99,
      result: {
        content: [{ type: "text" }],
      },
    });
  });

  it("preserves null id (matches the client's notification-shaped id)", () => {
    const resp = buildRestartResponse(null);
    expect(resp.id).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #260 — a restart that did not produce a serving child must SAY SO
// ────────────────────────────────────────────────────────────────────────────
describe("server_relay — a failed swap is reportable, not silent", () => {
  it("buildRestartError carries the id and a JSON-RPC error, never a result", () => {
    const resp = buildRestartError(2, "the new child exited (code=1, signal=null) before completing the MCP handshake");
    expect(resp.id).toBe(2);
    expect(resp.result, "a failed restart must not come back shaped like a success").toBeUndefined();
    expect(resp.error).toBeDefined();
    expect((resp.error as { code: number }).code).toBe(-32001);
  });

  it("its message says the restart FAILED and why", () => {
    const msg = (buildRestartError(2, "the new child exited (code=1, signal=null)").error as { message: string }).message;
    expect(msg).toMatch(/restart FAILED/i);
    expect(
      msg,
      "buildRestartResponse's text is 'New child process is up and serving'. Emitting that " +
        "over a dead child is what turned a boot failure into an unbounded client-side hang.",
    ).toContain("code=1");
    expect(msg).not.toMatch(/up and serving/i);
  });

  it("buildNoChildError names the method that could not be answered", () => {
    const resp = buildNoChildError(3, "tools/call");
    expect(resp.id).toBe(3);
    expect(resp.result).toBeUndefined();
    const msg = (resp.error as { message: string }).message;
    expect(msg).toContain("tools/call");
    expect(msg).toMatch(/no live server child/i);
  });

  it("both preserve a null id", () => {
    expect(buildRestartError(null, "why").id).toBe(null);
    expect(buildNoChildError(null, "tools/list").id).toBe(null);
  });
});

describe("server_restart — registry spec + server-side guard", () => {
  it("server_restart is registered in MCP_TOOLS so tool_inspect sees it", async () => {
    const { MCP_TOOLS } = await import("../src/mcp.js");
    const spec = MCP_TOOLS.find((s) => s.slug === "server_restart");
    expect(spec, "server_restart missing from MCP_TOOLS").toBeDefined();
    expect(spec!.category).toBe("improve");
  });

  it("server-side handler errors loudly if the relay didn't intercept", async () => {
    const { bootstrapServerDeps, dispatchTool } = await import("../src/server.js");
    const deps = bootstrapServerDeps(".");
    const result = await dispatchTool("server_restart", {}, deps);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/relay/i);
  });
});
