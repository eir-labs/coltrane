// Failure mode: malformed agent profile JSON in agents/. Three variants:
//   (a) truncated JSON  → recorded as a load_error naming the offending file.
//   (b) wrong type for a required field (primitives = string instead of array).
//   (c) extra unknown key — should be accepted silently (forward-compat).
//
// Per the soft-fail design (#129), loadGenome does NOT throw on one broken file —
// it skips it and records a LoadError (kind/path/slug/error) in load_errors so the
// rest of the genome still loads. The discipline these cases assert: a malformed
// definition must be recorded with an error that NAMES the offending file or field,
// and the bad definition must NOT load silently.

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { loadGenome } from "../../src/loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
void __dirname;

function seedCore(tempDir: string): void {
  const coreDir = join(tempDir, "core_types");
  mkdirSync(coreDir, { recursive: true });
  for (const [slug, primitive] of [
    ["Signal", "SENSE"],
    ["Interpretation", "INTERPRET"],
    ["Judgment", "JUDGE"],
    ["Plan", "PLAN"],
    ["Artifact", "CREATE"],
    ["Verdict", "VERIFY"],
  ] as const) {
    writeFileSync(
      join(coreDir, slug.toLowerCase() + ".json"),
      JSON.stringify({
        slug,
        primitive,
        description: "",
        schema: { type: "object", properties: {}, required: [] },
      }),
    );
  }
}

describe("failure mode: malformed agent profile JSON", () => {
  let env: TempdirColtrane;

  it("(a) truncated JSON → typed GenomeLoadError naming the file (NOT raw SyntaxError)", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      // missing trailing brace + closing bracket
      writeFileSync(
        join(agentsDir, "truncated.json"),
        '{ "slug": "truncated", "primitives": ["SENSE"',
      );

      const genome = loadGenome(env.tempDir);
      // soft-fail (#129): not thrown — recorded as a load_error naming the file.
      const failure = genome.load_errors.find(
        (e) => e.kind === "agent" && /truncated/i.test(e.path),
      );
      expect(failure, "malformed agent JSON should be a load_error naming the file").toBeDefined();
      expect(failure!.error, "load_error should explain the malformed JSON").toMatch(/JSON/i);
      // the broken agent must NOT have loaded
      expect(genome.agents.has("truncated")).toBe(false);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("(b) wrong type for required field (primitives as string) → typed error mentioning the field", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "badtype.json"),
        JSON.stringify({ slug: "badtype", primitives: "SENSE" }),
      );

      const genome = loadGenome(env.tempDir);
      // soft-fail (#129): the wrong-type agent is recorded, not silently loaded.
      const failure = genome.load_errors.find(
        (e) => e.slug === "badtype" || /badtype/i.test(e.path),
      );
      expect(failure, "wrong-type agent should be a load_error, not silently loaded").toBeDefined();
      expect(failure!.error, "load_error should name the offending field or slug").toMatch(
        /primitives|badtype/i,
      );
      expect(genome.agents.has("badtype")).toBe(false);
    } finally {
      env.cleanup();
    }
  }, 30_000);

  it("(c) extra unknown key in agent def → accepted (forward-compat) OR rejected with named field", async () => {
    env = await setupTempdirColtrane();
    try {
      seedCore(env.tempDir);
      const agentsDir = join(env.tempDir, "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "extra.json"),
        JSON.stringify({
          slug: "extra",
          primitives: ["SENSE"],
          domain: "fwdcompat",
          // unknown key — coltrane's choice: accept silently (forward-compat) or reject
          mystery_future_field: 42,
        }),
      );

      const g = loadGenome(env.tempDir);
      // forward-compat: an unknown key is either accepted (agent loads) or recorded
      // as a load_error naming the field — never a hard throw (soft-fail #129).
      const failure = g.load_errors.find((e) => e.slug === "extra" || /extra/i.test(e.path));
      if (failure) {
        expect(failure.error).toMatch(/mystery_future_field|extra|unknown/i);
      } else {
        expect(g.agents.has("extra")).toBe(true);
      }
    } finally {
      env.cleanup();
    }
  }, 30_000);
});
