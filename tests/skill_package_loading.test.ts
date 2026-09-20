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
import { mkdirSync, writeFileSync } from "node:fs";
import {
  loadSkillPackage,
  hashSkillCode,
  CODE_HASH_ALGO,
  SkillLoadError,
} from "../src/skills.js";
import { loadGenome } from "../src/loader.js";
import { makeGenomeDir, rmGenome, seedCoreTypes, writeSkillPackage } from "./_support/genome.js";

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

  it("loads package skills from the genome; the flat {slug, md} format is retired", () => {
    // the repo's own packages load (number-adder = pure-code; summarize-tight = migrated)
    const g = loadGenome(REPO_ROOT);
    expect(g.skills.has("number-adder")).toBe(true);
    expect(g.skills.has("summarize-tight")).toBe(true);

    // a FLAT {slug, md} skill no longer loads — no package dir, so it's ignored (no backwards-compat)
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      mkdirSync(join(dir, "skills"), { recursive: true });
      writeFileSync(join(dir, "skills", "flatty.json"), JSON.stringify({ slug: "flatty", md: "be terse" }));
      expect(loadGenome(dir).skills.has("flatty")).toBe(false);
    } finally {
      rmGenome(dir);
    }
  });

  it("a genome skill missing its fixtures HARD-fails the load (incomplete = upgrade, not skip)", () => {
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      writeSkillPackage(dir, { slug: "no-contract", md: "a reasoning half but no fixtures", fixtures: [] });
      expect(() => loadGenome(dir)).toThrow(SkillLoadError);
    } finally {
      rmGenome(dir);
    }
  });

  it("a genome skill with neither a code nor a reasoning half HARD-fails the load", () => {
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      mkdirSync(join(dir, "skills", "empty-shell", "fixtures"), { recursive: true });
      writeFileSync(join(dir, "skills", "empty-shell", "meta.json"), JSON.stringify({ slug: "empty-shell", version: 1, permission: { tier: 0 } }));
      writeFileSync(join(dir, "skills", "empty-shell", "fixtures", "f.json"), JSON.stringify({ id: "f", input: {}, assertions: [] }));
      expect(() => loadGenome(dir)).toThrow(SkillLoadError);
    } finally {
      rmGenome(dir);
    }
  });
});

// The network-grant law, revised 2026-09-20 (docs/specs/skill-network-grant-refusal.md).
// The original law refused ANY declared permission.network at load, because nothing read the grant
// and Node's --permission model had no network flag: an origin allowlist, a method restriction and
// rate/size caps were held to none of them, which is a false assurance. Node 24's --allow-net moved
// the ground. skill_subprocess passes that flag ONLY for a declared grant (no grant → no flag → the
// child's fetch is denied at the syscall), and skill_runner enforces allow[], methods[],
// max_requests and max_bytes in-process. So the grant is backed, and the refusal narrows to the one
// case that is still unenforceable: a runtime too old to have the flag.

/** Write a skill package with an arbitrary `permission` sub-object (undefined ⇒ omit it entirely) —
 *  mirrors writeSkillPackage but does not force { tier: 0 }, so a permission.network can be declared. */
function writeSkillWithPermission(root: string, slug: string, permission: unknown | undefined): void {
  const d = join(root, "skills", slug);
  mkdirSync(join(d, "fixtures"), { recursive: true });
  const meta = { slug, version: 1, ...(permission !== undefined ? { permission } : {}) };
  writeFileSync(join(d, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(d, "skill.md"), "reasoning half");
  writeFileSync(join(d, "fixtures", "f0.json"), JSON.stringify({ id: "basic", input: {}, assertions: [] }));
}

describe("skill network grant — backed by the runtime, or refused", () => {
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);

  it("loads a well-formed permission.network on a runtime that can back it (Node 24+)", () => {
    if (nodeMajor < 24) return; // the other law governs this runtime
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      writeSkillWithPermission(dir, "netty", {
        tier: 0,
        network: { allow: ["api.example.com"], methods: ["GET"], max_requests: 100, max_bytes: 4096 },
      });
      const g = loadGenome(dir);
      expect(g.skills.has("netty")).toBe(true);
      // and the grant SURVIVES to the record the execution path reads — a stored grant nothing
      // carries would be the old defect wearing a new face
      expect(g.skills.get("netty")?.permission?.network?.allow).toEqual(["api.example.com"]);
      expect(g.skills.get("netty")?.permission?.network?.max_requests).toBe(100);
    } finally {
      rmGenome(dir);
    }
  });

  it("refuses a grant this runtime cannot back, naming the skill and the field", () => {
    if (nodeMajor >= 24) return; // cannot be exercised here; the law above governs
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      writeSkillWithPermission(dir, "greedy-fetcher", { tier: 0, network: { allow: ["api.example.com"] } });
      let message = "";
      try { loadGenome(dir); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message).toContain("greedy-fetcher");
      expect(message).toContain("permission.network");
    } finally {
      rmGenome(dir);
    }
  });

  it("GREEN control: a skill declaring no network (permission.tier only) loads and preserves its tier", () => {
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      writeSkillWithPermission(dir, "tier-only", { tier: 2 });
      const g = loadGenome(dir);
      expect(g.skills.has("tier-only")).toBe(true);
      expect(g.skills.get("tier-only")?.permission?.tier).toBe(2);
    } finally {
      rmGenome(dir);
    }
  });

  it("GREEN control: a skill declaring NO permission at all loads unchanged", () => {
    const dir = makeGenomeDir();
    try {
      seedCoreTypes(dir);
      writeSkillWithPermission(dir, "no-perm", undefined);
      const g = loadGenome(dir);
      expect(g.skills.has("no-perm")).toBe(true);
    } finally {
      rmGenome(dir);
    }
  });
});
