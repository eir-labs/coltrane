// RED-first contract tests — skills as first-class, the LOADING contract
// (docs/skills-as-first-class.md). A skill is no longer a {slug, md} stub; it is a
// package directory under skills/<slug>/ — meta.json + skill.mjs (+ optional skill.md +
// fixtures/). The loader must read the package, content-hash the code half, verify that
// hash at load, validate fixture shape, and still load legacy {slug, md} JSON
// alongside the new packages (coexistence — no flag day).
//
// These tests fail honestly against the src/skills.ts stubs (loadSkillPackage throws
// NotImplemented) and against the as-yet-unextended loader (directory packages aren't
// folded into the genome's skills map). They flip GREEN as Phase 1 lands.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  loadSkillPackage,
  hashSkillCode,
  CODE_HASH_ALGO,
  SkillLoadError,
} from "../src/skills.js";
import { loadGenome } from "../src/loader.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");
const DUAL_EXTRACT = join(REPO_ROOT, "tests/_skill_fixtures/dual-extract");
const CORRUPT_META = join(REPO_ROOT, "tests/_skill_fixtures/corrupt-meta");

describe("skill package loading + identity", () => {
  it("loads a package: meta, computed code hash, fixtures, and the (absent) reasoning half", () => {
    const pkg = loadSkillPackage(NUMBER_ADDER);
    expect(pkg.dir).toBe(NUMBER_ADDER);
    expect(pkg.meta.slug).toBe("number-adder");
    expect(pkg.meta.version).toBe(1);
    expect(pkg.fixtures.length).toBeGreaterThan(0);
    // number-adder is a pure-code skill — no skill.md reasoning half.
    expect(pkg.mdPath).toBeNull();
  });

  it("computes code_hash as sha256 over skill.mjs and the hash is stable + well-formed", () => {
    const pkg = loadSkillPackage(NUMBER_ADDER);
    expect(pkg.codeHash).toBe(hashSkillCode(join(NUMBER_ADDER, "skill.mjs")));
    expect(pkg.codeHash ?? "").toMatch(new RegExp(`^${CODE_HASH_ALGO}:[0-9a-f]{64}$`));
  });

  it("surfaces the dual-artifact reasoning half (skill.md) when present", () => {
    const pkg = loadSkillPackage(DUAL_EXTRACT);
    expect(pkg.mdPath).toBe(join(DUAL_EXTRACT, "skill.md"));
    // both halves share the output schema — the contract the residual is computed against
    expect(pkg.meta.output_schema).toBeTruthy();
  });

  it("validates fixture shape at load — every fixture has an id and an input", () => {
    const pkg = loadSkillPackage(NUMBER_ADDER);
    for (const fx of pkg.fixtures) {
      expect(typeof fx.id).toBe("string");
      expect(fx.id.length).toBeGreaterThan(0);
      expect(fx.input).toBeDefined();
    }
  });

  it("raises a named SkillLoadError on a malformed package — not a bare SyntaxError", () => {
    expect(() => loadSkillPackage(CORRUPT_META)).toThrow(SkillLoadError);
  });

  it("loads package skills AND legacy {slug, md} skills into one genome map (coexistence)", () => {
    const g = loadGenome(REPO_ROOT);
    // legacy single-file skill (skills/summarize-tight.json) still loads
    expect(g.skills.has("summarize-tight")).toBe(true);
    // the new package (skills/number-adder/) is folded into the same map
    expect(g.skills.has("number-adder")).toBe(true);
  });
});
