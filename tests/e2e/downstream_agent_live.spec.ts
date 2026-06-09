// e2e: LIVE AGENT × INSTALLED TARBALL — the full union, leg C (issue #144).
//
// The other two downstream specs each prove one leg and stub the other:
//   - npm_install_roundtrip: installed tarball, but a hand-written MCP handshake (no agent)
//   - downstream_import:      a programmatic SDK client, real tools, but no LLM in the loop
// Neither runs the thing a real user actually does: a live Claude agent, reasoning,
// deciding to call a coltrane tool, served by the PUBLISHED tarball it `npm install`ed.
//
// This spec joins them. It scaffolds a consumer repo, installs the packed engine,
// has the consumer author its own genome (the widgetco marker), writes a real
// `npx coltrane-server` .mcp.json, then fires an actual `claude -p` subthread IN
// that repo (via the harness's spawnClaudeSubthread) constrained to a single
// coltrane tool. The agent must invoke the tool and surface the consumer's type.
//
// Cost: spawns a real, BILLED Claude subprocess (pinned to `haiku` to keep it
// cheap). Requires the `claude` CLI on PATH + auth + network. e2e-only.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnClaudeSubthread } from "./_harness.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORE_TYPE_SLUGS = ["signal", "interpretation", "judgment", "plan", "artifact", "verdict"];

let consumer = "";
let packDir = "";
let mcpConfigPath = "";

describe("e2e: live agent drives the installed tarball against a consumer genome", () => {
  beforeAll(() => {
    // Build + pack the engine into a temp dir (never the working tree).
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
    packDir = mkdtempSync(join(tmpdir(), "coltrane-pack-"));
    const tgzName = execFileSync("npm", ["pack", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .pop()!;
    const tgz = join(packDir, tgzName);

    // Fresh consumer; install the engine as a real dependency.
    consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", tgz, "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: consumer,
      stdio: "ignore",
    });

    // Consumer authors its own genome: the 6 core types + a distinctive marker.
    mkdirSync(join(consumer, "core_types"), { recursive: true });
    for (const slug of CORE_TYPE_SLUGS) {
      cpSync(join(REPO_ROOT, "core_types", `${slug}.json`), join(consumer, "core_types", `${slug}.json`));
    }
    mkdirSync(join(consumer, "domain_types"), { recursive: true });
    writeFileSync(
      join(consumer, "domain_types", "widget-signal.json"),
      JSON.stringify(
        {
          slug: "widget-signal",
          version: 1,
          extends: "Signal",
          domain: "widgetco",
          status: "active",
          schema: { type: "object", properties: { sku: { type: "string" } } },
          required_fields: ["sku"],
        },
        null,
        2,
      ),
    );
    for (const dir of ["agents", "standards", "skills"]) {
      mkdirSync(join(consumer, dir), { recursive: true });
    }

    // The real consumer wiring: npx coltrane-server (relay/default), own genome.
    mcpConfigPath = join(consumer, ".mcp.json");
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            coltrane: {
              command: "npx",
              args: ["coltrane-server"],
              env: { COLTRANE_GENOME: consumer },
            },
          },
        },
        null,
        2,
      ),
    );
  }, 600_000);

  afterAll(() => {
    if (consumer) rmSync(consumer, { recursive: true, force: true });
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  });

  it("a live claude agent invokes a coltrane tool served by the installed tarball", async () => {
    const prompt =
      'Use the coltrane MCP tool named "type_browse" with the argument domain="widgetco". ' +
      "Then tell me the slug of every type it returned. Use only that tool.";

    const res = await spawnClaudeSubthread(
      ["-p", prompt, "--allowedTools", "mcp__coltrane__type_browse", "--model", "haiku"],
      { cwd: consumer, mcpConfigPath, timeoutMs: 180_000 },
    );

    const tail = (s: string) => s.slice(-1500);
    const diag = `exit=${res.exitCode}\n--- stdout tail ---\n${tail(res.stdout)}\n--- stderr tail ---\n${tail(res.stderr)}`;

    // The agent ran to completion.
    expect(res.exitCode, `claude subthread did not exit cleanly:\n${diag}`).toBe(0);
    // It actually invoked the coltrane tool (tool_use surfaced in stream-json).
    expect(res.stdout, `no coltrane tool call in the transcript:\n${diag}`).toContain(
      "mcp__coltrane__type_browse",
    );
    // The consumer's own type — served by the installed engine — reached the live agent.
    expect(res.stdout, `consumer genome did not flow back to the agent:\n${diag}`).toContain(
      "widget-signal",
    );
  }, 300_000);
});
