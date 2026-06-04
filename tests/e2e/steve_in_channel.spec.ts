// steve_in_channel.spec.ts — TRUE end-to-end with a real Slack chime.
//
// Spawns a real `claude -p` subprocess (Steve), grants Bash so Steve can
// invoke the ant_cli wrapper, and asks Steve to post a unique marker to
// the band Slack channel. Then verifies the chime landed via slack history
// (also via ant_cli).
//
// Two boundary crossings tested live, NOT mocked:
//   1. Claude Code spawn → real LLM completion
//   2. ant_cli → real Slack POST → message visible in channel history
//
// What "PASS" means here: Steve was spawned, ran the command, and the
// marker is recoverable from Slack. If Steve refuses the tool, or the
// post fails, or the marker doesn't appear in history → FAIL with the
// reason in the assertion message.

import { describe, it, expect } from "vitest";
import { spawnClaudeSubthread } from "./_harness.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ANT_CLI = "/home/user/eir/slack_ant/ant_cli.py";
const INBOX = join(homedir(), ".eir", "inbox_unified.jsonl");

// Skip when the ant_cli + inbox are not on this machine — keeps the test
// honest as a smoke that runs only where the live Slack surface is wired.
const ANT_CLI_AVAILABLE = existsSync(ANT_CLI) && existsSync(INBOX);

describe.skipIf(!ANT_CLI_AVAILABLE)("Steve in channel — true end-to-end", () => {
  it("spawned Claude posts unique marker to Slack via ant_cli, verified by history readback", async () => {
    const marker = `e2e-steve-${randomUUID().slice(0, 8)}`;

    // Spawn Steve. Grant only Bash so Steve cannot wander; instruct posting via ant_cli.
    const prompt = [
      "You have access to the Bash tool. Run this exact command (no edits, no shell wrapping):",
      "",
      `python3 ${ANT_CLI} --ant-id cajal chat "${marker}"`,
      "",
      "Report only: the command's exit status + first line of stdout. Nothing else.",
    ].join("\n");

    const result = await spawnClaudeSubthread(
      ["-p", prompt, "--allowedTools", "Bash", "--dangerously-skip-permissions"],
      { timeoutMs: 120_000 },
    );

    expect(result.exitCode, `claude subprocess exit=${result.exitCode}`).toBe(0);

    // Verify the chime landed. The unified inbox is appended by the slack
    // socket listener as messages hit the channel; reading the tail proves
    // the post made the round-trip through Slack and came back via the
    // socket bus. Pure file read — no extra subprocess to flake on.
    const inbox = readFileSync(INBOX, "utf-8");
    const tail = inbox.split("\n").slice(-200).join("\n");

    expect(
      tail.includes(marker),
      `marker ${marker} not found in last 200 lines of ${INBOX} after Steve was asked to post it. ` +
        `Steve subprocess exit=${result.exitCode}. ` +
        `If marker is missing, the live chain Steve → ant_cli → Slack → socket → inbox is broken somewhere.`,
    ).toBe(true);
  }, 180_000);
});
