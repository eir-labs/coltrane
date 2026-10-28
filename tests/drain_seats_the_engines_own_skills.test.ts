// DR-3 — drain:the-engine's-own-skills-are-seated (wiki spec.coltrane.the-drain-runs-a-graded-red-pass).
//
// The drain passes `skill_dirs: new Map()`, so a skill-backed chair cannot run there: chancery-red-drafting-v0's
// scope gate fails at prep with "no skill_dir is registered". The cure seats a skill whose code half ships IN
// the engine package, and only when its meta pins a code_hash that the code on disk hashes to. A packaged skill
// with no pin, or whose code moved under its pin, is not seated and is named. A store-loaded skill with no
// package still fails closed, as before (nothing here registers it).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSkillCode } from "../src/skills.js";
import * as runDeps from "../src/run_deps.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

type Seated = { dirs: Map<string, string>; refused: Array<{ slug: string; reason: string }> };
const drainSkillDirs = (runDeps as unknown as { drainSkillDirs?: (root: string) => Seated }).drainSkillDirs;

function pkg(skills: Record<string, { code?: string; pin?: "right" | "wrong" | "none" }>): string {
  const root = mkdtempSync(join(tmpdir(), "drain-skills-")); tmps.push(root);
  for (const [slug, s] of Object.entries(skills)) {
    const dir = join(root, "skills", slug);
    mkdirSync(dir, { recursive: true });
    const code = s.code ?? `export default () => ({ slug: "${slug}" });\n`;
    writeFileSync(join(dir, "skill.mjs"), code);
    const meta: Record<string, unknown> = { slug, version: 1, skill_type: "verification", determinism_ratio: 1, permission: { tier: 1 } };
    if (s.pin === "right") meta["code_hash"] = hashSkillCode(join(dir, "skill.mjs"));
    if (s.pin === "wrong") meta["code_hash"] = "sha256:" + "0".repeat(64);
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  }
  return root;
}

describe("DR-3 — the drain seats the engine's own skills, at their pinned hash only", () => {
  it("DR-3 — drainSkillDirs exists and is what the drain registers", () => {
    expect(typeof drainSkillDirs, "run_deps.ts exports no drainSkillDirs: the drain still registers an empty skill_dirs").toBe("function");
  });

  it("DR-3 twin — a packaged skill whose code hashes to its pin is seated, at its own directory", () => {
    const root = pkg({ good: { pin: "right" } });
    const s = drainSkillDirs!(root);
    expect(s.dirs.get("good")).toBe(join(root, "skills", "good"));
  });

  it("DR-3 plant — a packaged skill whose code moved under its pin is not seated, and is named", () => {
    const root = pkg({ moved: { pin: "wrong" } });
    const s = drainSkillDirs!(root);
    expect(s.dirs.has("moved")).toBe(false);
    expect(s.refused.find((r) => r.slug === "moved")?.reason ?? "").toMatch(/code_hash/);
  });

  it("DR-3 plant — a packaged skill with no pin is not seated, and is named", () => {
    const root = pkg({ unpinned: { pin: "none" } });
    const s = drainSkillDirs!(root);
    expect(s.dirs.has("unpinned")).toBe(false);
    expect(s.refused.find((r) => r.slug === "unpinned")?.reason ?? "").toMatch(/pin/);
  });

  it("DR-3 twin, the real package — scope-gate is seated: its meta pins the hash its code has", () => {
    const s = drainSkillDirs!(ROOT);
    expect(s.dirs.get("scope-gate"), `scope-gate is not seated on the drain: ${JSON.stringify(s.refused.filter((r) => r.slug === "scope-gate"))}`)
      .toBe(join(ROOT, "skills", "scope-gate"));
  });
});
