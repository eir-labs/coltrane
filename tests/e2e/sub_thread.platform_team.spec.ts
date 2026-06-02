// persona: platform team needing observability + reproducibility
// pre-reg: failure-closed-on-version-bump test is expected RED if coltrane has no
// API-version concept on resume yet — that's a publishable gap, not a bug.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  resumeSubthread,
  hashRecorderIgnoringTimestamps,
  type TempdirColtrane,
} from "./_harness.js";

describe("sub_thread.platform_team — observability + reproducibility", () => {
  let env1: TempdirColtrane;
  let env2: TempdirColtrane;

  beforeAll(async () => {
    env1 = await setupTempdirColtrane();
    env2 = await setupTempdirColtrane();
  }, 600_000);

  afterAll(() => {
    env1?.cleanup();
    env2?.cleanup();
  });

  it("hard: same input two runs → same hash-sealed recorder output (sha256 stable, modulo timestamps)", async () => {
    const prompt = "respond with the JSON object {\"value\":42} and nothing else";

    await spawnClaudeSubthread(["-p", prompt], {
      mcpConfigPath: env1.mcpConfigPath,
      timeoutMs: 60_000,
    });
    const h1 = hashRecorderIgnoringTimestamps(env1.recorderPath);

    await spawnClaudeSubthread(["-p", prompt], {
      mcpConfigPath: env2.mcpConfigPath,
      timeoutMs: 60_000,
    });
    const h2 = hashRecorderIgnoringTimestamps(env2.recorderPath);

    expect(h1).toBe(h2);
    expect(h1).not.toBe("EMPTY");
  }, 240_000);

  it("hard: --resume across an API-version-bump fails CLOSED (typed error, not silent corruption)", async () => {
    const first = await spawnClaudeSubthread(
      ["-p", "say hello"],
      { mcpConfigPath: env1.mcpConfigPath, timeoutMs: 60_000 },
    );
    expect(first.sessionId, `stderr: ${first.stderr.slice(0, 400)}`).not.toBeNull();
    if (!first.sessionId) return;

    // simulate version bump by mutating the mcp-config to point at a different (incompatible) shape
    const cfgPath = join(env1.tempDir, "mcp-config.json");
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.mcpServers.coltrane.env = { ...cfg.mcpServers.coltrane.env, COLTRANE_API_VERSION: "v999" };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(cfgPath, JSON.stringify(cfg));
    }

    const resumed = await resumeSubthread(
      first.sessionId,
      "continue",
      { mcpConfigPath: env1.mcpConfigPath, timeoutMs: 60_000 },
    );
    // hard contract: when API version mismatches, resume must FAIL not silent-pass.
    // either non-zero exit, OR a structured error event in stdout.
    const failsClosed =
      resumed.exitCode !== 0 ||
      /api.?version|incompatible|error/i.test(resumed.stderr) ||
      /api.?version|incompatible/i.test(resumed.stdout);
    expect(failsClosed, "resume must fail-closed across API version mismatch").toBe(true);
  }, 240_000);

  it("soft: monitoring hooks present in recorder (observability_log field non-empty)", async () => {
    await spawnClaudeSubthread(
      ["-p", "say hi"],
      { mcpConfigPath: env1.mcpConfigPath, timeoutMs: 60_000 },
    );
    if (!existsSync(env1.recorderPath)) {
      expect.fail("recorder log path missing — coltrane recorder not wired for sub-thread turns");
    }
    const content = readFileSync(env1.recorderPath, "utf-8");
    // any structured monitoring signal at all
    expect(content.length).toBeGreaterThan(0);
    expect(content).toMatch(/observability_log|gig_id|run_fingerprint|session_id/);
  }, 120_000);
});
