// persona: platform team needing observability + reproducibility
// note: failure-closed-on-version-bump test is expected RED if coltrane has no
// API-version concept on resume yet — that's a publishable gap, not a bug.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  setupTempdirColtrane,
  spawnClaudeSubthread,
  resumeSubthread,
  hashRecorderDeterministicFields,
  recorderContainsApiVersionMismatch,
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

  it("hard: same input two runs → same hash-sealed recorder output (scoped to deterministic provenance fields)", async () => {
    const prompt = "respond with the JSON object {\"value\":42} and nothing else";

    await spawnClaudeSubthread(["-p", prompt], {
      mcpConfigPath: env1.mcpConfigPath,
      timeoutMs: 60_000,
    });
    const h1 = hashRecorderDeterministicFields(env1.recorderPath);

    await spawnClaudeSubthread(["-p", prompt], {
      mcpConfigPath: env2.mcpConfigPath,
      timeoutMs: 60_000,
    });
    const h2 = hashRecorderDeterministicFields(env2.recorderPath);

    expect(h1).not.toBe("EMPTY");
    expect(h2).not.toBe("EMPTY");
    expect(h1).toBe(h2);
  }, 240_000);

  it("hard: --resume across an API-version-bump fails CLOSED (typed error sealed to recorder)", async () => {
    const first = await spawnClaudeSubthread(
      ["-p", "say hello"],
      { mcpConfigPath: env1.mcpConfigPath, timeoutMs: 60_000, apiVersion: "1.0.0" },
    );
    expect(first.sessionId, `stderr: ${first.stderr.slice(0, 400)}`).not.toBeNull();
    if (!first.sessionId) return;

    // simulate version bump by passing a different api_version to the resume invocation.
    const resumed = await resumeSubthread(
      first.sessionId,
      "continue",
      { mcpConfigPath: env1.mcpConfigPath, timeoutMs: 60_000, apiVersion: "v999" },
    );
    // hard contract: when API version mismatches, the seam must FAIL CLOSED with a
    // typed error sealed into the recorder. Any of: non-zero exit, a structured
    // error in Claude's surfaces, or a typed api_version_mismatch entry in the
    // recorder counts — the recorder seal is the load-bearing one.
    const recorderSealedMismatch = recorderContainsApiVersionMismatch(env1.recorderPath);
    const claudeSurfaceSignaled =
      resumed.exitCode !== 0 ||
      /api.?version|incompatible|error/i.test(resumed.stderr) ||
      /api.?version|incompatible/i.test(resumed.stdout);
    const failsClosed = recorderSealedMismatch || claudeSurfaceSignaled;
    expect(failsClosed, "resume must fail-closed across API version mismatch").toBe(true);
    // The recorder seal is the durable one — assert it independently so a future
    // surface change in Claude can't quietly downgrade this contract.
    expect(recorderSealedMismatch, "api_version_mismatch must be sealed to the recorder").toBe(true);
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
