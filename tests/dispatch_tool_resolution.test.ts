// #185 / Lane B — an agent's allowed_tools is not an opaque name list: each grant resolves to a
// PROVIDER. A host-builtin (Read/Bash/WebFetch) is governed by --allowedTools + code_tool_access; an
// MCP grant resolves to a server config wired into the spawn's --mcp-config; an in-house grant is a
// runtime primitive. A grant with NO provider is a DEAD NAME — the model is told it can call a tool
// the spawn can't provide, and it confabulates. resolveToolGrants makes that resolution explicit and
// surfaces unknowns so dispatch can fail closed instead of launching a spawn that lists dead tools.
import { describe, it, expect } from "vitest";
import { resolveToolGrants, assertToolGrantsResolvable, type ToolProvider } from "../src/tool_providers.js";

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
