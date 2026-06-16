// Tool-grant → provider resolution (#185). An agent's `allowed_tools` is a set of grants, each of
// which resolves to one of three provider classes:
//   - host-builtin (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/…): provided by the Claude
//     runtime, governed by --allowedTools + code_tool_access. No MCP server needed.
//   - mcp: provided by an MCP server (e.g. a browser server) that must be wired into the spawn's
//     --mcp-config. The OSS engine ships this RESOLUTION machinery; a deployment registers the
//     actual server config (the server itself is deployment-provided).
//   - in_house: a runtime primitive (e.g. output_write) the engine provides directly.
// A grant that resolves to NONE of these is a DEAD NAME — the prompt lists a tool the spawn can't
// provide, so the model confabulates. resolveToolGrants surfaces those as `unknown` so dispatch can
// fail closed instead of launching a spawn that advertises tools it cannot back.

/** How a granted tool name resolves to something runnable. */
export interface ToolProvider {
  tool: string;
  kind: "mcp" | "in_house";
  /** for kind "mcp": the MCP server slug (multiple tools may share one server). */
  server?: string;
  /** for kind "mcp": the server's --mcp-config entry (command/args/env/url). */
  config?: Record<string, unknown>;
}

export type ToolProviderRegistry = ReadonlyMap<string, ToolProvider>;

// Host-builtin Claude Code tools — provided by the runtime, not an MCP server. Grants are governed
// by --allowedTools + code_tool_access; they never need a provider entry and are never "unknown".
const HOST_BUILTINS: ReadonlySet<string> = new Set([
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Bash", "BashOutput", "KillShell",
  "Glob", "Grep", "LS",
  "WebFetch", "WebSearch",
  "Task", "TodoWrite",
]);

/** A scoped grant like `Bash(npx vitest run:*)` resolves on its base tool name (`Bash`). */
export function toolBaseName(grant: string): string {
  const paren = grant.indexOf("(");
  return (paren >= 0 ? grant.slice(0, paren) : grant).trim();
}

export interface ResolvedGrants {
  /** MCP server slug → its --mcp-config entry, deduped across all grants that share a server. */
  mcpServers: Record<string, unknown>;
  /** in-house runtime tools the spawn should expose. */
  inHouse: string[];
  /** grants with no resolvable provider — dead names. Dispatch must refuse these. */
  unknown: string[];
}

/** Claude Code MCP tools follow the `mcp__<server>__<tool>` naming convention. Extract the server
 *  slug so an MCP grant resolves to its server by convention — no per-tool registration needed. */
export function mcpServerOf(grant: string): string | null {
  const m = toolBaseName(grant).match(/^mcp__(.+?)__/);
  return m ? m[1]! : null;
}

/** Resolve an agent's allowed_tools to providers. In order: a host-builtin passes (no server); an
 *  explicit registry entry wins; an `mcp__<server>__*` grant resolves by convention to that server's
 *  config from `mcpServerConfigs` (deployment-registered; coltrane ships its own); everything else —
 *  including an MCP grant for an unconfigured server — is `unknown` (a dead name). */
export function resolveToolGrants(
  allowed: readonly string[],
  registry: ToolProviderRegistry,
  mcpServerConfigs: Readonly<Record<string, unknown>> = {},
): ResolvedGrants {
  const mcpServers: Record<string, unknown> = {};
  const inHouse: string[] = [];
  const unknown: string[] = [];
  for (const grant of allowed) {
    const base = toolBaseName(grant);
    if (HOST_BUILTINS.has(base)) continue;
    const prov = registry.get(base);
    if (prov) {
      if (prov.kind === "mcp" && prov.server) {
        if (prov.config !== undefined) mcpServers[prov.server] = prov.config;
      } else if (prov.kind === "in_house") {
        inHouse.push(base);
      }
      continue;
    }
    const server = mcpServerOf(base);
    if (server) {
      if (Object.prototype.hasOwnProperty.call(mcpServerConfigs, server)) {
        mcpServers[server] = mcpServerConfigs[server];
      } else {
        unknown.push(grant); // an MCP tool whose server has no registered config — a dead name
      }
      continue;
    }
    unknown.push(grant);
  }
  return { mcpServers, inHouse, unknown };
}

/** Fail closed: an agent that grants an unresolvable tool must not be dispatched — a granted tool
 *  with no provider is indistinguishable from a real one until the agent tries (and fails) to call
 *  it. Raising here at dispatch surfaces it as a clear error instead of a confabulated answer. */
export function assertToolGrantsResolvable(
  agentSlug: string,
  allowed: readonly string[],
  registry: ToolProviderRegistry,
  mcpServerConfigs: Readonly<Record<string, unknown>> = {},
): void {
  const { unknown } = resolveToolGrants(allowed, registry, mcpServerConfigs);
  if (unknown.length > 0) {
    throw new Error(
      `agent "${agentSlug}" grants unresolvable tool(s) [${unknown.join(", ")}] — no provider registered ` +
        `(a granted tool with no provider is a dead name; register a provider or remove the grant)`,
    );
  }
}
