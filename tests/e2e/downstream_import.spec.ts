// e2e: downstream import — the engine, installed from its tarball, operates on a
// genome the CONSUMER authored, driven through the consumer's own .mcp.json over
// the real MCP protocol (issue #144). This is the proof the install-roundtrip
// spec stops short of: not "does it boot" but "does it work for a downstream repo."
//
// Shape of the test:
//   1. build + pack the engine, scaffold a fresh consumer repo, `npm install` the tarball
//   2. the consumer authors its OWN genome — the 6 required core types plus a
//      distinctive `widgetco`-domain type the engine never shipped (the marker)
//   3. the consumer writes a real `.mcp.json` invoking `npx coltrane-server`
//      (relay mode — the out-of-box default), with COLTRANE_GENOME at its own repo
//   4. a programmatic MCP client (the same SDK Client Claude Code uses) connects by
//      reading that .mcp.json and spawning exactly what it specifies — no LLM, free
//   5. drive real tools: list the surface, READ a type that proves the engine sees
//      the consumer's genome (not its own bundled one), then WRITE an agent via
//      agent_define and assert the file lands in the CONSUMER's agents/ dir
//
// GREEN-expected: a regression guard on the downstream contract. Real `npm install`
// + relay spawn, so it lives in the e2e suite. Requires network + registry access.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CORE_TYPE_SLUGS = ["signal", "interpretation", "judgment", "plan", "artifact", "verdict"];

let consumer = ""; // the downstream repo
let packDir = "";
let client: Client;

/** Parse a coltrane tool result envelope: content[0].text is JSON.stringify({ ok, data }). */
function parseToolResult(res: unknown): { ok: boolean; data?: any; error?: string } {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

describe("e2e: downstream import — engine operates on a consumer-authored genome", () => {
  beforeAll(async () => {
    // 1. Build + pack the engine into a temp dir (never the working tree).
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

    // 2. Scaffold a fresh consumer repo and install the engine as a dependency.
    consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", tgz, "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: consumer,
      stdio: "ignore",
    });

    // 3. The consumer authors its OWN genome.
    //    - the 6 required core types (copied — these are the canonical substrate)
    mkdirSync(join(consumer, "core_types"), { recursive: true });
    for (const slug of CORE_TYPE_SLUGS) {
      cpSync(join(REPO_ROOT, "core_types", `${slug}.json`), join(consumer, "core_types", `${slug}.json`));
    }
    //    - a distinctive domain type the engine never shipped (the marker)
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
    //    - empty dirs for the classes a downstream grows into
    for (const dir of ["agents", "standards", "skills"]) {
      mkdirSync(join(consumer, dir), { recursive: true });
    }

    // 4. The consumer's real wiring: npx coltrane-server (relay/default mode),
    //    pointed at its own repo as the genome root.
    writeFileSync(
      join(consumer, ".mcp.json"),
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

    // 5. Connect a programmatic MCP client by reading that .mcp.json and spawning
    //    exactly what it specifies — the config itself is under test.
    const mcpConf = JSON.parse(readFileSync(join(consumer, ".mcp.json"), "utf-8"));
    const srv = mcpConf.mcpServers.coltrane;
    const transport = new StdioClientTransport({
      command: srv.command,
      args: srv.args,
      cwd: consumer,
      env: { ...(process.env as Record<string, string>), ...(srv.env ?? {}) },
    });
    client = new Client({ name: "downstream-e2e", version: "0" }, { capabilities: {} });
    await client.connect(transport);
  }, 600_000);

  afterAll(async () => {
    await client?.close();
    if (consumer) rmSync(consumer, { recursive: true, force: true });
    if (packDir) rmSync(packDir, { recursive: true, force: true });
  });

  it("exposes the full coltrane tool surface over MCP", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("type_browse");
    expect(names).toContain("agent_define");
    expect(names).toContain("system_health");
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it("READ: type_browse reflects the consumer's own genome, not the engine's bundled one", async () => {
    const res = await client.callTool({ name: "type_browse", arguments: { domain: "widgetco" } });
    const parsed = parseToolResult(res);
    expect(parsed.ok).toBe(true);
    const slugs = (parsed.data?.types ?? []).map((t: { slug: string }) => t.slug);
    expect(slugs, `expected the consumer's widget-signal; got ${JSON.stringify(slugs)}`).toContain(
      "widget-signal",
    );
  });

  it("WRITE: agent_define persists a new agent file into the CONSUMER's repo", async () => {
    const res = await client.callTool({
      name: "agent_define",
      arguments: {
        slug: "widget-scout",
        primitives: ["SENSE"],
        output_types: ["widget-signal"],
        domain: "widgetco",
      },
    });
    const parsed = parseToolResult(res);
    expect(parsed.ok, `agent_define failed: ${parsed.error ?? ""}`).toBe(true);

    // The MCP-sole-writer path sealed a loadable definition into the consumer genome.
    const onDisk = join(consumer, "agents", "widget-scout.json");
    expect(existsSync(onDisk), "agent_define did not write into the consumer's agents/ dir").toBe(true);
    const written = JSON.parse(readFileSync(onDisk, "utf-8"));
    expect(written.slug).toBe("widget-scout");
    expect(written.domain).toBe("widgetco");
  });
});
