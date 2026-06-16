// #185 / Lane B — an agent's allowed_tools is not an opaque name list: each grant resolves to a
// PROVIDER. A host-builtin (Read/Bash/WebFetch) is governed by --allowedTools + code_tool_access; an
// MCP grant resolves to a server config wired into the spawn's --mcp-config; an in-house grant is a
// runtime primitive. A grant with NO provider is a DEAD NAME — the model is told it can call a tool
// the spawn can't provide, and it confabulates. resolveToolGrants makes that resolution explicit and
// surfaces unknowns so dispatch can fail closed instead of launching a spawn that lists dead tools.
import { describe, it, expect } from "vitest";
import { resolveToolGrants, assertToolGrantsResolvable, type ToolProvider } from "../src/tool_providers.js";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import type { AgentInvocationContext } from "../src/runtime.js";

const ctxFor = (allowed: string[]): AgentInvocationContext => ({
  agent: {
    slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["sig"], allowed_tools: allowed,
    behavioral_primitives: ["explorer", "critic"], identity: "you are scout", method: "1. look 2. report 3. stop",
    constraints: [], domain: "demo",
  } as never,
  phase: "p", inputs: [], gig_input: {},
});

const registry = new Map<string, ToolProvider>([
  ["browser_navigate", { tool: "browser_navigate", kind: "mcp", server: "eirtests", config: { command: "eirtests-mcp" } }],
  ["browser_snapshot", { tool: "browser_snapshot", kind: "mcp", server: "eirtests", config: { command: "eirtests-mcp" } }],
  ["output_write", { tool: "output_write", kind: "in_house" }],
]);

describe("#185 — tool grants resolve to providers (no dead names)", () => {
  it("an MCP grant resolves to its server config for the spawn's --mcp-config", () => {
    const r = resolveToolGrants(["browser_navigate", "browser_snapshot"], registry);
    expect(r.unknown).toEqual([]);
    expect(Object.keys(r.mcpServers)).toEqual(["eirtests"]); // both tools collapse to one server
    expect(r.mcpServers["eirtests"]).toEqual({ command: "eirtests-mcp" });
  });

  it("a host-builtin grant needs no provider (governed by --allowedTools + code_tool_access)", () => {
    const r = resolveToolGrants(["Read", "Bash(npx vitest run:*)", "WebFetch"], registry);
    expect(r.unknown, "builtins are not unknown").toEqual([]);
    expect(Object.keys(r.mcpServers), "builtins need no MCP server").toEqual([]);
  });

  it("an in-house grant resolves to a runtime primitive, not an MCP server", () => {
    const r = resolveToolGrants(["output_write"], registry);
    expect(r.unknown).toEqual([]);
    expect(r.inHouse).toEqual(["output_write"]);
    expect(Object.keys(r.mcpServers)).toEqual([]);
  });

  it("a grant with NO provider is surfaced as unknown (a dead name)", () => {
    const r = resolveToolGrants(["browser_navigate", "totally_made_up"], registry);
    expect(r.unknown).toEqual(["totally_made_up"]);
  });

  it("assertToolGrantsResolvable throws a clear error on an unresolvable grant (fail closed)", () => {
    expect(() => assertToolGrantsResolvable("grant-scout", ["browser_navigate", "ghost_tool"], registry))
      .toThrow(/grant-scout.*ghost_tool|ghost_tool.*no provider/i);
    expect(() => assertToolGrantsResolvable("ok-agent", ["Read", "output_write", "browser_navigate"], registry))
      .not.toThrow();
  });
});

describe("#185 — mcp__<server>__<tool> grants resolve by convention", () => {
  const empty = new Map<string, ToolProvider>();
  const serverConfigs = { coltrane: { command: "node", args: ["dist/src/server_entry.js"] } };

  it("an mcp__coltrane__* grant resolves to the coltrane server config (no per-tool registration)", () => {
    const r = resolveToolGrants(["mcp__coltrane__output_write", "mcp__coltrane__type_browse"], empty, serverConfigs);
    expect(r.unknown).toEqual([]);
    expect(Object.keys(r.mcpServers)).toEqual(["coltrane"]); // both collapse to the one server
    expect(r.mcpServers["coltrane"]).toEqual(serverConfigs.coltrane);
  });

  it("an mcp__ grant for a server with NO registered config is unknown (a dead name)", () => {
    const r = resolveToolGrants(["mcp__eirtests__browser_navigate"], empty, serverConfigs);
    expect(r.unknown).toEqual(["mcp__eirtests__browser_navigate"]); // eirtests not configured here
    expect(Object.keys(r.mcpServers)).toEqual([]);
  });

  it("builtins + a configured-server mcp grant resolve together; the whole genome's grants are clean", () => {
    const r = resolveToolGrants(["Bash(npx vitest run:*)", "Read", "WebFetch", "mcp__coltrane__standard_compose"], empty, serverConfigs);
    expect(r.unknown).toEqual([]);
    expect(Object.keys(r.mcpServers)).toEqual(["coltrane"]);
  });
});

describe("#185 — the invoker fails closed at dispatch on a dead-name grant (before spawning)", () => {
  it("an agent granting a tool with no provider rejects, and the child is never spawned", async () => {
    let spawned = false;
    // mcpServerConfigs present → resolution enabled
    const invoke = makeClaudeInvoker({ mcpServerConfigs: {}, run: () => { spawned = true; return "{}"; } });
    await expect(invoke(ctxFor(["ghost_tool"]))).rejects.toThrow(/ghost_tool.*no provider|unresolvable/i);
    expect(spawned, "must not spawn a child that advertises a dead tool").toBe(false);
  });

  it("an agent granting only builtins resolves (reaches the spawn)", async () => {
    let spawned = false;
    const invoke = makeClaudeInvoker({ mcpServerConfigs: {}, run: () => { spawned = true; return JSON.stringify({ v: "sig" }); } });
    await invoke(ctxFor(["Read", "WebFetch"]));
    expect(spawned, "builtin-only grants must resolve and reach the spawn").toBe(true);
  });

  it("a browser grant resolves the caged playwright server; granting it WITHOUT a grant fails closed", async () => {
    let spawned = false;
    const invoke = makeClaudeInvoker({ mcpServerConfigs: {}, run: () => { spawned = true; return JSON.stringify({ v: "sig" }); } });
    // declares browser_grant → coltrane builds the cage → the playwright grant resolves
    const withGrant = ctxFor(["mcp__playwright__browser_navigate"]);
    (withGrant.agent as { browser_grant?: unknown }).browser_grant = { allowed_origins: ["ppubs.uspto.gov"] };
    await invoke(withGrant);
    expect(spawned, "a declared browser grant must resolve the caged browser").toBe(true);
    // same grant, NO browser_grant declared → no caged server → unresolvable → fail closed
    await expect(invoke(ctxFor(["mcp__playwright__browser_navigate"])))
      .rejects.toThrow(/playwright.*no provider|unresolvable|browser_navigate/i);
  });
});
