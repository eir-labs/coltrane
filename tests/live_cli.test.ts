// CLI parse + init subcommand tests. The play subcommand is exercised
// indirectly via the orchestrator suite (it blocks awaiting SIGINT, so we
// don't drive it from this suite).

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCli } from "../bin/coltrane.js";

describe("parseArgs", () => {
  it("captures subcommand + flags", () => {
    const r = parseArgs(["init", "--live-slack"]);
    expect(r.subcommand).toBe("init");
    expect(r.flags.has("--live-slack")).toBe(true);
  });

  it("handles no args", () => {
    const r = parseArgs([]);
    expect(r.subcommand).toBeUndefined();
  });
});

describe("runCli", () => {
  it("prints help when invoked with no args", async () => {
    const r = await runCli([]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("init --live-slack");
    expect(r.stdout).toContain("play --live-slack");
  });

  it("init --live-slack writes manifest + env template + 4 steve dirs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coltrane-cli-"));
    const r = await runCli(["init", "--live-slack"], dir);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("slack-app-manifest.yaml");

    const manifest = await readFile(join(dir, "coltrane", "slack-app-manifest.yaml"), "utf8");
    expect(manifest).toContain("socket_mode_enabled: true");

    const envTemplate = await readFile(join(dir, ".env.template"), "utf8");
    expect(envTemplate).toContain("SLACK_BOT_TOKEN_1=");
  });

  it("rejects unknown subcommands with exit 2", async () => {
    const r = await runCli(["nope"]);
    expect(r.exit_code).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });
});
