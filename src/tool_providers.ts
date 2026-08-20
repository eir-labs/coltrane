import { playwrightServerFor } from "./playwright_cage.js";
import type { BrowserGrant } from "./genome_schema.js";

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
  /** the MCP server slug that hosts this tool (multiple tools may share one server). For kind "mcp"
   *  it's the external server; for kind "in_house" it's the engine's own server (#204), through which
   *  the tool is bridged and under whose mcp__<server>__ prefix it is advertised. */
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

/** The engine's own MCP server slug — the key the repo's .mcp.json ships it under, and the prefix
 *  its tools are advertised behind (mcp__coltrane__<tool>). In-house engine tools are bridged through
 *  this server, so an in-house grant resolves to it (#204). */
export const ENGINE_MCP_SERVER = "coltrane";

/** A scoped grant like `Bash(npx vitest run:*)` resolves on its base tool name (`Bash`). */
export function toolBaseName(grant: string): string {
  const paren = grant.indexOf("(");
  return (paren >= 0 ? grant.slice(0, paren) : grant).trim();
}

/**
 * The host builtins to DENY for a seat whose effective allow set is `effectiveAllowed`: every
 * HOST_BUILTINS member whose base name is absent from that set.
 *
 * This is the complement that makes the tool ceiling BIND by enforcement. `--allowedTools` is
 * advisory for host builtins — a seat granted only `type_browse` still called `Bash` and `Read`,
 * unrefused and unrecorded (gig 782e89d8, room-prober, twice) — and only `--disallowedTools`
 * removes a builtin. So the ungranted host builtins must be enumerated into the deny list.
 *
 * HOST_BUILTINS stays UNEXPORTED: the 14-tool universe lives in one home, reachable only through
 * this function, so no call site re-inlines it (the change request forbids re-inlining the oracles).
 * Deterministic order (HOST_BUILTINS insertion order) so the emitted flag is stable.
 */
/**
 * Is `name` one of the host builtins the runtime provides?
 *
 * A SECOND ACCESSOR over the same single home, deliberately — not a second copy. HOST_BUILTINS
 * stays unexported for the reason stated above (one universe, no re-inlined oracles), and callers
 * that need to ASK about a name rather than compute a complement now have a way to do it without
 * copying the set. The player compiler is the first such caller: it prefixed every declared tool
 * with `mcp__coltrane__` unconditionally, so a player could not name `Read` without compiling it
 * into `mcp__coltrane__Read` — a dead name that binds to nothing and fails silently.
 *
 * Takes a BASE name; pass `toolBaseName(grant)` for a scoped grant like `Bash(git add:*)`.
 */
export function isHostBuiltin(name: string): boolean {
  return HOST_BUILTINS.has(name);
}

export function hostBuiltinDenials(effectiveAllowed: Iterable<string>): string[] {
  const granted = new Set<string>();
  for (const g of effectiveAllowed) granted.add(toolBaseName(g));
  return [...HOST_BUILTINS].filter((b) => !granted.has(b));
}

export interface ResolvedGrants {
  /** MCP server slug → its --mcp-config entry, deduped across all grants that share a server. */
  mcpServers: Record<string, unknown>;
  /** in-house runtime tools the spawn should expose. */
  inHouse: string[];
  /** grants with no resolvable provider — dead names. Dispatch must refuse these. */
  unknown: string[];
  /** the grants as the SPAWN will see them, to feed --allowedTools (NOT the raw allowed_tools).
   *  Host-builtins and `mcp__<server>__*` grants pass through unchanged; a registry tool that
   *  resolves to an MCP server — INCLUDING an in-house engine tool bridged through the engine's own
   *  server — is namespaced to `mcp__<server>__<tool>`, because that is the name the server actually
   *  advertises. A bare slug (e.g. `output_write`) in --allowedTools matches nothing and the agent
   *  can't seal — #204. An in-house tool with no engine-server config keeps its bare name (no regression). */
  effectiveAllowed: string[];
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
  const effectiveAllowed: string[] = [];
  for (const grant of allowed) {
    const base = toolBaseName(grant);
    if (HOST_BUILTINS.has(base)) {
      effectiveAllowed.push(grant); // builtins pass through with their scoping intact
      continue;
    }
    const prov = registry.get(base);
    if (prov) {
      if (prov.kind === "mcp" && prov.server) {
        if (prov.config !== undefined) mcpServers[prov.server] = prov.config;
        effectiveAllowed.push(`mcp__${prov.server}__${base}`); // the name the server advertises
      } else if (prov.kind === "in_house") {
        inHouse.push(base);
        // #204 — an in-house engine tool is bridged through the engine's OWN MCP server. Resolving
        // it as a "runtime primitive" left the server out of the spawn's mcp-config AND advertised
        // the bare slug, which the server's namespaced surface never matched — so the agent could
        // never call it (drafts emitted as text, nothing sealed). Wire the engine server in and name
        // the tool the way the server exposes it. No engine-server config → keep the bare name.
        if (prov.server && Object.prototype.hasOwnProperty.call(mcpServerConfigs, prov.server)) {
          mcpServers[prov.server] = mcpServerConfigs[prov.server];
          effectiveAllowed.push(`mcp__${prov.server}__${base}`);
        } else {
          effectiveAllowed.push(base);
        }
      } else {
        effectiveAllowed.push(grant);
      }
      continue;
    }
    const server = mcpServerOf(base);
    if (server) {
      if (Object.prototype.hasOwnProperty.call(mcpServerConfigs, server)) {
        mcpServers[server] = mcpServerConfigs[server];
        effectiveAllowed.push(grant); // already in mcp__<server>__<tool> form
      } else {
        unknown.push(grant); // an MCP tool whose server has no registered config — a dead name
      }
      continue;
    }
    unknown.push(grant);
  }
  return { mcpServers, inHouse, unknown, effectiveAllowed };
}

/** Per-agent grant resolution: fold the deny-by-default browser cage this agent's `browser_grant`
 *  builds into the mcp server configs, then resolve every grant. This is the ONE place per-agent
 *  resolution happens — shared by the invoker's spawn path (claude_invoker) and runGig's dispatch
 *  preflight (runtime) so the two resolve against the IDENTICAL environment. A preflight that
 *  resolved against a different environment than the chair actually gets would either refuse a
 *  runnable gig or wave a doomed one through — the drift this collapses. Structural agent type so
 *  it needs no dependency on the full Agent record. */
export function resolveAgentGrants(
  agent: { allowed_tools?: readonly string[] | undefined; browser_grant?: BrowserGrant | undefined },
  registry: ToolProviderRegistry,
  mcpServerConfigs: Readonly<Record<string, unknown>> = {},
): ResolvedGrants {
  const browserCage = playwrightServerFor(agent.browser_grant);
  const effectiveConfigs = browserCage
    ? { ...mcpServerConfigs, playwright: browserCage }
    : mcpServerConfigs;
  return resolveToolGrants(agent.allowed_tools ?? [], registry, effectiveConfigs);
}

/** Fail closed: an agent that grants an unresolvable tool must not be dispatched — a granted tool
 *  with no provider is indistinguishable from a real one until the agent tries (and fails) to call
 *  it. Raising here at dispatch surfaces it as a clear error instead of a confabulated answer. */
export function assertToolGrantsResolvable(
  agentSlug: string,
  allowed: readonly string[],
  registry: ToolProviderRegistry,
  mcpServerConfigs: Readonly<Record<string, unknown>> = {},
): ResolvedGrants {
  const resolved = resolveToolGrants(allowed, registry, mcpServerConfigs);
  if (resolved.unknown.length > 0) {
    throw new Error(
      `agent "${agentSlug}" grants unresolvable tool(s) [${resolved.unknown.join(", ")}] — no provider registered ` +
        `(a granted tool with no provider is a dead name; register a provider or remove the grant)`,
    );
  }
  return resolved;
}
