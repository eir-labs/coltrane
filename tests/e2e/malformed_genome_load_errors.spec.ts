// bug-bash finding: malformed JSON in genome dir surfaces as a cryptic error
// without naming the file or the location.
//
// loadGenome calls readJsonDir → raw JSON.parse with no try-catch. A truncated
// or syntax-broken standards/foo.json bubbles up as `SyntaxError: Unexpected
// end of JSON input` with NO indication of which file failed. User has to bisect.
//
// User-expected behavior: a load error names the file (and ideally position).
// RED-expected.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadGenome } from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

describe("malformed genome load errors — bug-bash: errors must name the file that failed", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // Wipe to a clean genome.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(env.tempDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  it("RED-expected: malformed standards/*.json surfaces an error naming the file", () => {
    // Plant a valid standard + a truncated one.
    writeFileSync(
      join(env.tempDir, "standards", "good.json"),
      JSON.stringify({
        slug: "good", domain: "demo", agent_slugs: [], phases: [],
      }),
    );
    // Truncated — missing closing brace.
    writeFileSync(
      join(env.tempDir, "standards", "broken-truncated.json"),
      '{"slug":"broken","domain":"demo","agent_slugs":[],"phases":[',
    );

    let caught: unknown = null;
    try {
      loadGenome(env.tempDir);
    } catch (e) {
      caught = e;
    }
    expect(caught, "loadGenome should reject malformed standards/*.json").not.toBeNull();
    const msg = caught instanceof Error ? caught.message : String(caught);
    // The user-expected receipt: the error message names "broken-truncated.json"
    // (the failing file). Currently RED — bare SyntaxError carries only "Unexpected end of JSON input".
    expect(
      msg,
      `expected error to name the failing file "broken-truncated.json". got: ${msg}`,
    ).toMatch(/broken-truncated\.json/);
  });

  it("RED-expected: malformed agents/*.json surfaces an error naming the file", () => {
    // Reset agents/ then plant good + broken.
    const agentsDir = join(env.tempDir, "agents");
    rmSync(agentsDir, { recursive: true, force: true });
    mkdirSync(agentsDir, { recursive: true });
    rmSync(join(env.tempDir, "standards"), { recursive: true, force: true });
    mkdirSync(join(env.tempDir, "standards"), { recursive: true });

    writeFileSync(
      join(agentsDir, "good.json"),
      JSON.stringify({
        slug: "good-agent", primitives: ["SENSE"], input_types: [], output_types: [], domain: "demo",
      }),
    );
    // Valid JSON, but missing required "slug" field — should fail validation.
    writeFileSync(
      join(agentsDir, "missing-slug.json"),
      JSON.stringify({
        primitives: ["SENSE"], input_types: [], output_types: [], domain: "demo",
      }),
    );

    let caught: unknown = null;
    try {
      loadGenome(env.tempDir);
    } catch (e) {
      caught = e;
    }
    expect(caught, "loadGenome should reject agents/*.json missing required fields").not.toBeNull();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(
      msg,
      `expected error to name the failing file "missing-slug.json". got: ${msg}`,
    ).toMatch(/missing-slug\.json/);
  });

  it("baseline: empty genome (no agents, no standards, no domain_types) loads cleanly", () => {
    // Reset all dirs empty.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(env.tempDir, sub);
      rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
    // Should NOT throw.
    const genome = loadGenome(env.tempDir);
    expect(genome.agents.size).toBe(0);
    expect(genome.standards.size).toBe(0);
    expect(genome.domain_types.size).toBe(0);
  });
});
