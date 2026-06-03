// player → claude-code agent compile.
//
// A Player is a public-facing role-definition that wraps an existing
// coltrane agent_profile. This module parses a Player from a markdown file
// with YAML frontmatter and emits a Claude Code agent .md file with the
// required frontmatter fields (name, description, tools, model) and the
// player's charter as the body, prefixed with an orientation line.
//
// The compile is pure: a parsed Player in, a string out. The CLI script
// (scripts/compile_players.ts) handles the file I/O.
//
// Tool name mapping: coltrane MCP tool slugs (e.g. "agent_define") become
// claude-code MCP refs (e.g. "mcp__coltrane__agent_define") in the
// compiled agent's `tools` frontmatter field. The MCP server name in the
// downstream consumer's .mcp.json must be "coltrane" for the refs to bind.

export interface Player {
  slug: string;
  display_name: string;
  description: string;
  agent_profile_ref: string;
  lane: string;
  tools_allowlist: readonly string[];
  charter: string;
}

const MCP_SERVER_NAME = "coltrane";

function mapToolToClaudeRef(coltraneSlug: string): string {
  return `mcp__${MCP_SERVER_NAME}__${coltraneSlug}`;
}

/** Parse a player .md file body (frontmatter + body) into a Player record.
 * Throws if required fields are missing or the frontmatter delimiters are
 * malformed. Minimal YAML — we only support the exact shape we ship. */
export function parsePlayer(fileContents: string): Player {
  const m = fileContents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error("player file missing YAML frontmatter");
  const fm = m[1] ?? "";

  const lines = fm.split(/\r?\n/);
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentList: string | null = null;
  let currentBlockKey: string | null = null;
  let currentBlockLines: string[] = [];
  let currentBlockIndent = 0;

  const flushBlock = () => {
    if (currentBlockKey) {
      fields[currentBlockKey] = currentBlockLines.join("\n").replace(/\s+$/, "");
      currentBlockKey = null;
      currentBlockLines = [];
    }
  };

  for (const raw of lines) {
    if (currentBlockKey !== null) {
      // inside a |-block; consume indented lines, end on dedent or new key
      const indentMatch = raw.match(/^(\s*)(.*)$/);
      const indent = indentMatch ? (indentMatch[1] ?? "").length : 0;
      const rest = indentMatch ? (indentMatch[2] ?? "") : "";
      if (raw.trim() === "") {
        currentBlockLines.push("");
        continue;
      }
      if (indent >= currentBlockIndent) {
        currentBlockLines.push(raw.slice(currentBlockIndent));
        continue;
      }
      // dedent — close block, fall through to normal parsing
      flushBlock();
      // and reprocess this line below
      // (so do NOT continue; fall into the parse below)
      // however we already consumed raw; just re-handle synthetically
      if (rest === "") continue;
    }

    const line = raw;
    const blockMatch = line.match(/^([a-z_]+):\s*\|\s*$/);
    if (blockMatch) {
      currentList = null;
      currentBlockKey = blockMatch[1] ?? null;
      currentBlockLines = [];
      // detect indent from next non-empty line
      currentBlockIndent = 2;
      continue;
    }

    const listStart = line.match(/^([a-z_]+):\s*$/);
    if (listStart) {
      currentList = listStart[1] ?? null;
      if (currentList) lists[currentList] = [];
      continue;
    }

    if (currentList) {
      const item = line.match(/^\s+-\s+(.+)$/);
      if (item) {
        const v = (item[1] ?? "").trim();
        lists[currentList]?.push(v);
        continue;
      }
      currentList = null;
    }

    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1] ?? "";
      const value = (kv[2] ?? "").trim();
      fields[key] = value;
    }
  }
  flushBlock();

  const required = ["slug", "display_name", "description", "agent_profile_ref", "lane", "charter"];
  for (const r of required) {
    if (!(r in fields) || !fields[r]) {
      throw new Error(`player frontmatter missing required field: ${r}`);
    }
  }
  const toolsAllowlist = lists["tools_allowlist"] ?? [];
  if (toolsAllowlist.length === 0) {
    throw new Error("player frontmatter must list at least one tool in tools_allowlist");
  }

  return {
    slug: fields["slug"] as string,
    display_name: fields["display_name"] as string,
    description: fields["description"] as string,
    agent_profile_ref: fields["agent_profile_ref"] as string,
    lane: fields["lane"] as string,
    tools_allowlist: toolsAllowlist,
    charter: fields["charter"] as string,
  };
}

/** Compile a Player into a Claude Code agent .md string.
 * Output shape: YAML frontmatter (name, description, tools, model) + a body
 * with the orientation line and the player's charter. */
export function compilePlayerToClaudeAgent(player: Player): string {
  const name = `coltrane-${player.slug}`;
  const tools = player.tools_allowlist.map(mapToolToClaudeRef).join(", ");
  const toolsList = player.tools_allowlist.map((t) => `- ${mapToolToClaudeRef(t)}`).join("\n");

  const orientation =
    `You are operating as a coltrane player in the ${player.lane} lane. ` +
    `Your role is: ${player.description} ` +
    `You have access to the following coltrane MCP tools and only these tools:\n\n${toolsList}\n\n` +
    `Use these tools to fulfill the user's request. Do not attempt to use tools outside this allowlist.`;

  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${player.description}`,
    `tools: ${tools}`,
    `model: sonnet`,
    `lane: ${player.lane}`,
    `agent_profile_ref: ${player.agent_profile_ref}`,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n${orientation}\n\n${player.charter}\n`;
}
