// Failure mode: malformed agent profile JSON in agents/. Three variants:
//   (a) truncated JSON  → JSON.parse SyntaxError surfaces raw today (RED-honest).
//   (b) wrong type for a required field (primitives = string instead of array).
//   (c) extra unknown key — should be accepted silently (forward-compat).
//
// REQUIRES (for (a) GREEN): loadGenome's readJsonDir does a bare JSON.parse and lets
// SyntaxError bubble. To go GREEN, the loader needs to wrap parse failures in a
// GenomeLoadError that mentions the offending FILE PATH and the JSON-parse position.
//
// REQUIRES (for (b) GREEN): defineAgent uses a runtime check on def.primitives, but
// the resulting message ("agent X has no primitives" or a cast crash) doesn't always
// name the field. Field-level error mention is the discipline this asserts.

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "../e2e/_harness.js";
import { loadGenome, GenomeLoadError } from "../../src/loader.js";

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

      let thrown: unknown = null;
      try {
        loadGenome(env.tempDir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();

      const err = thrown as { constructor?: { name: string }; message?: string };
      const typeName = err?.constructor?.name ?? "unknown";
      // RED-honest: today this is a raw SyntaxError from JSON.parse. We want a
      // GenomeLoadError that mentions the offending filename.
      expect(
        typeName,
        `expected GenomeLoadError, got ${typeName}: ${err?.message}`,
      ).toBe("GenomeLoadError");
      expect(err?.message ?? "", "error message should name the offending file").toMatch(
        /truncated/i,
      );
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

      let thrown: unknown = null;
      try {
        loadGenome(env.tempDir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).not.toBeNull();
      const err = thrown as Error;
      expect(err).toBeInstanceOf(GenomeLoadError);
      // discipline: the message should mention the field name or the slug
      expect(err.message).toMatch(/primitives|badtype/i);
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

      let thrown: unknown = null;
      let g: ReturnType<typeof loadGenome> | null = null;
      try {
        g = loadGenome(env.tempDir);
      } catch (e) {
        thrown = e;
      }

      if (thrown) {
        const err = thrown as Error;
        expect(err).toBeInstanceOf(GenomeLoadError);
        expect(err.message).toMatch(/mystery_future_field|extra|unknown/i);
      } else {
        expect(g).not.toBeNull();
        expect(g!.agents.has("extra")).toBe(true);
      }
    } finally {
      env.cleanup();
    }
  }, 30_000);
});
