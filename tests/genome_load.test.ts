import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { loadGenome, GenomeLoadError } from "../src";

const ROOT = join(__dirname, "..");

describe("loadGenome: core types from disk", () => {
  it("loads exactly the 6 spec-mandated core type files", () => {
    const g = loadGenome(ROOT);
    expect(g.core_types.size).toBe(6);
    for (const slug of ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"]) {
      expect(g.core_types.has(slug)).toBe(true);
    }
  });

  it("each core type carries its primitive + schema", () => {
    const g = loadGenome(ROOT);
    const sig = g.core_types.get("Signal")!;
    expect(sig.primitive).toBe("SENSE");
    expect(sig.schema).toBeDefined();
  });
});

describe("loadGenome: no file changes to add a domain type", () => {
  const tmpRoot = join(ROOT, "tmp_genome_test");

  afterAll(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seedCore(): void {
    const dir = join(tmpRoot, "core_types");
    mkdirSync(dir, { recursive: true });
    for (const [slug, primitive] of [
      ["Signal", "SENSE"],
      ["Interpretation", "INTERPRET"],
      ["Judgment", "JUDGE"],
      ["Plan", "PLAN"],
      ["Artifact", "CREATE"],
      ["Verdict", "VERIFY"],
    ] as const) {
      writeFileSync(
        join(dir, slug.toLowerCase() + ".json"),
        JSON.stringify({ slug, primitive, description: "", schema: { type: "object", properties: {}, required: [] } }),
      );
    }
  }

  it("adding a JSON file to domain_types/ makes the type visible (no TS edit)", () => {
    seedCore();
    const before = loadGenome(tmpRoot);
    expect(before.domain_types.size).toBe(0);

    const domainDir = join(tmpRoot, "domain_types");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(
      join(domainDir, "finding.json"),
      JSON.stringify({
        slug: "finding",
        version: 1,
        extends: "Interpretation",
        domain: "eirtests",
        status: "active",
        schema: { type: "object", properties: { pattern_key: { type: "string" } }, required: ["pattern_key"] },
        required_fields: ["pattern_key"],
      }),
    );

    const after = loadGenome(tmpRoot);
    expect(after.domain_types.size).toBe(1);
    expect(after.domain_types.has("finding@1")).toBe(true);
  });

  // Rob #129 contract change: a domain type that extends a non-core type no
  // longer hard-fails the whole load. It's recorded in load_errors and the
  // rest of the genome continues to load.
  it("records a domain type extending a non-core type as a load_error (was: hard-throw)", () => {
    seedCore();
    const domainDir = join(tmpRoot, "domain_types");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(
      join(domainDir, "ghost.json"),
      JSON.stringify({
        slug: "ghost",
        version: 1,
        extends: "NotACoreType",
        domain: "x",
        status: "active",
        schema: { type: "object", properties: {}, required: [] },
        required_fields: [],
      }),
    );
    const genome = loadGenome(tmpRoot);
    expect(genome.domain_types.has("ghost@1")).toBe(false);
    const err = genome.load_errors.find((e) => e.kind === "domain_type" && e.slug === "ghost");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/NotACoreType|not a core type/);
  });
});

import { afterAll } from "vitest";
