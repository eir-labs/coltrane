// Genome extension Phase 1: the engine owns the 6 canonical core types, so a genome
// root with no core_types/ of its own still boots (a downstream consumer never copies
// immutable substrate). Two guards:
//   1. a genome with NO core_types/ seeds the canonical 6 (no throw)
//   2. the compiled-in constant stays byte-for-value identical to core_types/*.json
//      (drift guard — same content hashes whether sourced from disk or the constant)
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { CANONICAL_CORE_TYPES } from "../src/canonical_core_types.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REQUIRED = ["Artifact", "Interpretation", "Judgment", "Plan", "Signal", "Verdict"];

describe("canonical core types — engine-provided base layer", () => {
  it("a genome root with NO core_types/ boots: the canonical 6 are seeded (no throw)", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-no-core-"));
    try {
      const genome = loadGenome(root);
      expect([...genome.core_types.keys()].sort()).toEqual(REQUIRED);
      expect(genome.load_errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a downstream consumer extends the seeded core: its own domain type loads on top", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-consumer-core-"));
    try {
      // consumer authors ONLY a domain type extending a (seeded) core — no core_types/
      mkdirSync(join(root, "domain_types"), { recursive: true });
      writeFileSync(
        join(root, "domain_types", "widget-signal.json"),
        JSON.stringify({ slug: "widget-signal", version: 1, extends: "Signal", domain: "widgetco", status: "active", schema: { type: "object", properties: { sku: { type: "string" } } }, required_fields: ["sku"] }),
      );
      const genome = loadGenome(root);
      expect([...genome.core_types.keys()].sort()).toEqual(REQUIRED);
      // domain types are keyed slug@version; check by slug on the values
      expect([...genome.domain_types.values()].some((d) => d.slug === "widget-signal")).toBe(true);
      expect(genome.load_errors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a PARTIAL core_types/ (some but not all 6) still hard-fails (corrupt, not fresh)", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-partial-core-"));
    try {
      mkdirSync(join(root, "core_types"), { recursive: true });
      // only 1 of 6 — a corrupt genome, must NOT be silently completed from the constant
      writeFileSync(join(root, "core_types", "signal.json"), JSON.stringify(CANONICAL_CORE_TYPES[0]));
      expect(() => loadGenome(root)).toThrow(/missing required slugs/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drift guard: the constant matches core_types/*.json byte-for-value", () => {
    const dir = join(REPO_ROOT, "core_types");
    const onDisk = readdirSync(dir)
      .filter((f) => extname(f) === ".json")
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const constant = [...CANONICAL_CORE_TYPES].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(constant).toEqual(onDisk);
  });
});
