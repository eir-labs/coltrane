// Tuning tests — project-scan honesty, pure-pairing determinism,
// and seal semantics. No real network / no real gh CLI assumed.

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tune,
  proposeTaskPairings,
  scanProject,
} from "../src/live/tuning.js";
import type { ProjectShape } from "../src/live/tuning_types.js";
import { makeSteveSeed, type PrimitiveSeed } from "../src/live/scaffold.js";

function emptyShape(): ProjectShape {
  return {
    domain_hints: null,
    recent_activity: null,
    file_types: null,
    package_dependencies: null,
    claude_md_summary: null,
    recent_pr_titles: null,
  };
}

describe("scanProject", () => {
  it("reads CLAUDE.md when present and surfaces the first paragraph as a summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awk-scan-"));
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# Title\n\nThis is the first real paragraph, describing the project.\n\nAnother paragraph follows.\n",
      "utf8",
    );
    const shape = await scanProject(dir);
    expect(shape.claude_md_summary).toContain("first real paragraph");
  });

  it("returns null claude_md_summary when CLAUDE.md is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awk-scan-noc-"));
    const shape = await scanProject(dir);
    expect(shape.claude_md_summary).toBeNull();
  });

  it("returns honest nulls when rootPath does not exist", async () => {
    const shape = await scanProject("/nonexistent/coltrane-test/path");
    expect(shape.claude_md_summary).toBeNull();
    expect(shape.package_dependencies).toBeNull();
    expect(shape.recent_activity).toBeNull();
    expect(shape.recent_pr_titles).toBeNull();
  });

  it("reads dependencies + description from package.json when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awk-pkg-"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        description: "demo project",
        dependencies: { zod: "^3.0.0" },
        devDependencies: { vitest: "^3.0.0" },
      }),
      "utf8",
    );
    const shape = await scanProject(dir);
    expect(shape.package_dependencies).toEqual(["vitest", "zod"]);
  });

  it("returns null package_dependencies when package.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awk-nopkg-"));
    const shape = await scanProject(dir);
    expect(shape.package_dependencies).toBeNull();
  });

  it("counts file types at the root and one level down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "awk-ft-"));
    await writeFile(join(dir, "README.md"), "x", "utf8");
    await writeFile(join(dir, "index.ts"), "x", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "x", "utf8");
    await writeFile(join(dir, "src", "b.ts"), "x", "utf8");
    const shape = await scanProject(dir);
    expect(shape.file_types).not.toBeNull();
    expect(shape.file_types?.[".ts"]).toBe(3);
    expect(shape.file_types?.[".md"]).toBe(1);
  });
});

describe("proposeTaskPairings — purity + determinism", () => {
  it("returns identical output for identical input (deterministic)", () => {
    const seed: PrimitiveSeed = makeSteveSeed(0, "u").primitive_seed; // sense-dominant
    const shape = emptyShape();
    const a = proposeTaskPairings(shape, seed);
    const b = proposeTaskPairings(shape, seed);
    expect(a).toEqual(b);
  });

  it("output is a new array each call (no mutation of cached templates)", () => {
    const seed: PrimitiveSeed = makeSteveSeed(0, "u").primitive_seed;
    const shape = emptyShape();
    const a = proposeTaskPairings(shape, seed);
    a[0]!.example_signals_to_watch_for = []; // ts-allowed via readonly cast
    const b = proposeTaskPairings(shape, seed);
    expect(b[0]!.example_signals_to_watch_for.length).toBeGreaterThan(0);
  });

  it("always returns 2-4 pairings", () => {
    for (let i = 0; i < 7; i++) {
      const seed = makeSteveSeed(i, "u").primitive_seed;
      const out = proposeTaskPairings(emptyShape(), seed);
      expect(out.length).toBeGreaterThanOrEqual(2);
      expect(out.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("proposeTaskPairings — rotates emphasis by dominant primitive", () => {
  function makeShapeWithHints(): ProjectShape {
    return { ...emptyShape(), domain_hints: ["demo project"] };
  }
  it("SENSE-heavy seed → at least one scanning task", () => {
    const seed = makeSteveSeed(0, "u").primitive_seed; // sense=1
    const out = proposeTaskPairings(makeShapeWithHints(), seed);
    expect(out.some((p) => p.task_type.startsWith("scan_") || p.task_type.includes("summarize_recent"))).toBe(true);
  });
  it("JUDGE-heavy seed → at least one review task", () => {
    const seed = makeSteveSeed(2, "u").primitive_seed; // judge=1
    const out = proposeTaskPairings(makeShapeWithHints(), seed);
    expect(out.some((p) => p.task_type.startsWith("review_") || p.task_type.startsWith("rank_"))).toBe(true);
  });
  it("PLAN-heavy seed → at least one composition task", () => {
    const seed = makeSteveSeed(3, "u").primitive_seed; // plan=1
    const out = proposeTaskPairings(makeShapeWithHints(), seed);
    expect(out.some((p) => p.task_type.startsWith("compose_") || p.task_type.startsWith("scope_"))).toBe(true);
  });
  it("balanced seed (all equal) → routing/holding pairings", () => {
    const balanced: PrimitiveSeed = {
      sense: 0.5,
      interpret: 0.5,
      judge: 0.5,
      plan: 0.5,
      create: 0.5,
      verify: 0.5,
      reflect: 0.5,
    };
    const out = proposeTaskPairings(makeShapeWithHints(), balanced);
    expect(out.some((p) => p.task_type === "route_incoming_request" || p.task_type === "hold_the_thread")).toBe(true);
  });
});

describe("tune", () => {
  async function setupSteveDir(opts?: {
    withClaudeMd?: boolean;
  }): Promise<{ dir: string; seedPath: string; auditPath: string; uuid: string }> {
    const dir = await mkdtemp(join(tmpdir(), "awk-orch-"));
    if (opts?.withClaudeMd !== false) {
      await writeFile(join(dir, "CLAUDE.md"), "# T\n\nSome project text.\n", "utf8");
    }
    const seed = makeSteveSeed(2, "uuid-fixed");
    const seedPath = join(dir, "seed.json");
    const auditPath = join(dir, "audit.jsonl");
    await writeFile(seedPath, JSON.stringify(seed, null, 2), "utf8");
    await writeFile(auditPath, "", "utf8");
    return { dir, seedPath, auditPath, uuid: seed.steve_uuid };
  }

  it("writes a sealed jsonl entry containing the expected fields", async () => {
    const { dir, seedPath, auditPath, uuid } = await setupSteveDir();
    const seal = await tune(uuid, seedPath, dir, auditPath);
    const audit = await readFile(auditPath, "utf8");
    const lines = audit.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.kind).toBe("tuning");
    expect(parsed.steve_uuid).toBe(uuid);
    expect(parsed.project_shape_hash).toBe(seal.project_shape_hash);
    expect(parsed.seed_hash).toBe(seal.seed_hash);
    expect(parsed.seal_hash).toBe(seal.seal_hash);
    expect(parsed.pairings.length).toBeGreaterThanOrEqual(2);
    expect(typeof parsed.at).toBe("string");
  });

  it("seal_hash is deterministic for the same project + seed (controlled time)", async () => {
    const { dir, seedPath, auditPath, uuid } = await setupSteveDir();
    const now = () => new Date("2026-06-03T00:00:00.000Z");
    const a = await tune(uuid, seedPath, dir, auditPath, { now });
    // second call into a fresh sink so we don't double-append; just hash check
    const b = await tune(uuid, seedPath, dir, auditPath, {
      now,
      audit_sink: async () => {},
    });
    expect(a.seal_hash).toBe(b.seal_hash);
    expect(a.project_shape_hash).toBe(b.project_shape_hash);
  });

  it("empty-ish project (only CLAUDE.md) still produces a valid seal with honest gaps", async () => {
    const { dir, seedPath, auditPath, uuid } = await setupSteveDir();
    const seal = await tune(uuid, seedPath, dir, auditPath);
    expect(seal.seal_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(seal.unavailable_signals).toContain("package_dependencies");
    // recent_pr_titles is best-effort gh; in test env it's almost certainly null.
    expect(seal.unavailable_signals).toContain("recent_pr_titles");
  });

  it("missing CLAUDE.md → claude_md_summary listed in unavailable_signals", async () => {
    const { dir, seedPath, auditPath, uuid } = await setupSteveDir({ withClaudeMd: false });
    const seal = await tune(uuid, seedPath, dir, auditPath);
    expect(seal.unavailable_signals).toContain("claude_md_summary");
  });

  it("supports an audit_sink override (no file write needed)", async () => {
    const { dir, seedPath, auditPath, uuid } = await setupSteveDir();
    const captured: string[] = [];
    const seal = await tune(uuid, seedPath, dir, auditPath, {
      audit_sink: async (line) => {
        captured.push(line);
      },
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!);
    expect(parsed.seal_hash).toBe(seal.seal_hash);
    // file untouched
    const onDisk = await readFile(auditPath, "utf8");
    expect(onDisk).toBe("");
  });
});
