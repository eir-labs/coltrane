// RED-first contract tests — skills as first-class meets genome extension
// (docs/skills-as-first-class.md + docs/genome-extension.md). A consumer genome that
// extends the base engine inherits the base's SKILL PACKAGES the same way it inherits
// agents and types: a lower layer's skill is available to a higher layer unless the
// higher layer overrides it by slug, with per-slug provenance recording which layer
// supplied it. This is what lets a downstream repo bind an engine-provided skill into
// its own chairs without copying the package.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayeredGenome } from "../src/loader.js";

function writeSkillPackage(root: string, slug: string, meta: Record<string, unknown>, code: string): void {
  const d = join(root, "skills", slug);
  mkdirSync(join(d, "fixtures"), { recursive: true });
  writeFileSync(join(d, "meta.json"), JSON.stringify({ slug, version: 1, permission: { tier: 0 }, ...meta }));
  writeFileSync(join(d, "skill.mjs"), code);
  writeFileSync(join(d, "fixtures", "f.json"), JSON.stringify({ id: "f", input: {}, assertions: [] }));
}

describe("skill packages cross genome layers", () => {
  it("a consumer inherits a base layer's skill package", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-base-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    try {
      writeSkillPackage(base, "base-skill", { skill_type: "extraction" }, "export default function run(i){return {n:i.n}}");
      const g = loadLayeredGenome([base, consumer]); // lowest → highest
      expect(g.skills.has("base-skill")).toBe(true);
      expect(g.provenance?.get("skill:base-skill")).toBe(base);
      expect(g.load_errors).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("a consumer overrides a base skill by slug — the top layer wins", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-base-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    try {
      writeSkillPackage(base, "shared-skill", { skill_type: "extraction" }, "export default function run(){return {who:'base'}}");
      writeSkillPackage(consumer, "shared-skill", { skill_type: "analysis" }, "export default function run(){return {who:'consumer'}}");
      const g = loadLayeredGenome([base, consumer]);
      expect((g.skills.get("shared-skill") as { skill_type?: string }).skill_type).toBe("analysis");
      expect(g.provenance?.get("skill:shared-skill")).toBe(consumer);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("a flat {slug, md} skill is ignored across layers — only packages inherit (flat format retired)", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-base-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    try {
      // base ships a FLAT skill (the retired pre-package format) — it must NOT load...
      mkdirSync(join(base, "skills"), { recursive: true });
      writeFileSync(join(base, "skills", "legacy.json"), JSON.stringify({ slug: "legacy", domain: "base", md: "be tight" }));
      // ...and the consumer ships a real package
      writeSkillPackage(consumer, "pkg-skill", { skill_type: "extraction" }, "export default function run(){return {}}");
      const g = loadLayeredGenome([base, consumer]);
      expect(g.skills.has("legacy")).toBe(false);
      expect(g.skills.has("pkg-skill")).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
