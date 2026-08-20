// EVERY TOOL A PLAYER DECLARES MUST RESOLVE TO SOMETHING REAL.
//
// `mapToolToClaudeRef` prefixed EVERY entry with `mcp__coltrane__` unconditionally, so a player
// that needed a host builtin could not express it: `Read` compiled to `mcp__coltrane__Read`, a
// name that binds to no server and no builtin. The spawned agent then advertised a tool that does
// not exist, silently — and a seat cannot call what it was never really granted.
//
// That is the inverse of the discipline the engine already holds one layer down. `claude_invoker`
// FAILS CLOSED on a grant with no provider ("a dead name"), refusing the chair rather than
// spawning it with a tool it cannot back. The player compiler manufactured dead names instead.
//
// Observed, not hypothesised: the bandleader seat's charter instructs it to read the working tree
// to establish what a gig produced, and on its first run it reported that it structurally could
// not — its 15 declared tools were all coltrane MCP slugs because the format admitted nothing else.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlayer, compilePlayerToClaudeAgent } from "../src/player_to_claude_code.js";
import { isHostBuiltin, toolBaseName, ENGINE_MCP_SERVER } from "../src/tool_providers.js";
import { MCP_TOOLS } from "../src/mcp.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAYERS_DIR = join(REPO_ROOT, "agents", "players");

const players = readdirSync(PLAYERS_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((f) => parsePlayer(readFileSync(join(PLAYERS_DIR, f), "utf8")));

const COLTRANE_SLUGS = new Set(MCP_TOOLS.map((t) => t.slug));

describe("a player's declared tools resolve to something real", () => {
  it("the corpus is non-vacuous — players ship, and they declare tools", () => {
    expect(players.length, "agents/players/ ships no players").toBeGreaterThan(0);
    expect(
      players.reduce((n, p) => n + p.tools_allowlist.length, 0),
      "no player declares any tool",
    ).toBeGreaterThan(0);
  });

  for (const p of players) {
    it(`${p.slug}: every declared tool is a coltrane tool or a host builtin`, () => {
      const unresolvable = p.tools_allowlist.filter(
        (t) => !COLTRANE_SLUGS.has(toolBaseName(t)) && !isHostBuiltin(toolBaseName(t)),
      );
      expect(
        unresolvable,
        `player "${p.slug}" declares tools that name neither a coltrane MCP tool nor a host builtin: ` +
          `${unresolvable.join(", ")} — a grant that resolves to nothing is a dead name`,
      ).toEqual([]);
    });

    it(`${p.slug}: a host builtin compiles to its bare name, never behind the MCP prefix`, () => {
      const compiled = compilePlayerToClaudeAgent(p);
      const toolsLine = /^tools:\s*(.+)$/m.exec(compiled)?.[1] ?? "";
      const refs = toolsLine.split(",").map((s) => s.trim()).filter(Boolean);
      for (const t of p.tools_allowlist) {
        const base = toolBaseName(t);
        if (!isHostBuiltin(base)) continue;
        expect(
          refs,
          `host builtin "${t}" of player "${p.slug}" must appear bare in the compiled tools list`,
        ).toContain(t);
        expect(
          refs,
          `host builtin "${t}" was prefixed as mcp__${ENGINE_MCP_SERVER}__${t} — a name that binds to nothing`,
        ).not.toContain(`mcp__${ENGINE_MCP_SERVER}__${t}`);
      }
    });
  }
});
