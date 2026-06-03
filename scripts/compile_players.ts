// scripts/compile_players.ts — read all agents/players/*.md, compile each
// player to a Claude Code agent .md, write to .claude/agents/coltrane-<slug>.md.
// Idempotent: re-running overwrites with the same content if inputs unchanged.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlayer, compilePlayerToClaudeAgent } from "../src/player_to_claude_code.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = resolve(__dirname, "..");
const playersDir = join(repoRoot, "agents", "players");
const outDir = join(repoRoot, ".claude", "agents");

function main(): void {
  if (!existsSync(playersDir)) {
    console.error(`no players directory at ${playersDir}`);
    process.exit(1);
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const files = readdirSync(playersDir).filter((f) => f.endsWith(".md"));
  let compiled = 0;
  for (const f of files) {
    const src = join(playersDir, f);
    const contents = readFileSync(src, "utf-8");
    const player = parsePlayer(contents);
    const out = compilePlayerToClaudeAgent(player);
    const outPath = join(outDir, `coltrane-${player.slug}.md`);
    writeFileSync(outPath, out);
    console.log(`compiled ${player.slug} → ${outPath}`);
    compiled++;
  }
  console.log(`compiled ${compiled} player(s)`);
}

main();
