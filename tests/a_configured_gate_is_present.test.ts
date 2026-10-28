// The commit gate is present wherever it is configured (wiki spec.coltrane.the-red-pass-runs-in-its-room, Discipline; Vör, round 6).
//
// git treats a core.hooksPath that names a missing directory, or a directory without pre-commit, as "no hooks" — silently: driven on a
// replica (git 2.50.1), the hook removed with the config untouched let a commit land with no message. A worktree can end configured as
// gated and silently ungated. This law fails in exactly that state. Where no gate is configured (CI, a fresh clone) it asserts nothing
// about this tree — the pure law below still runs its plants.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Findings for a configured hooks path: empty when unconfigured, or configured with an executable pre-commit present. Pure over `fsx`. */
export function gateFindings(hooksPath: string | null, fsx: { exists(p: string): boolean; executable(p: string): boolean }): string[] {
  if (!hooksPath) return [];
  if (!fsx.exists(hooksPath)) return [`core.hooksPath names ${hooksPath}, which does not exist: git runs no hooks and says nothing`];
  const hook = join(hooksPath, "pre-commit");
  if (!fsx.exists(hook)) return [`core.hooksPath names ${hooksPath}, which holds no pre-commit: the gate is configured and absent`];
  if (!fsx.executable(hook)) return [`${hook} is not executable: git skips it without a word`];
  return [];
}
const fake = (present: Record<string, boolean>) => ({ exists: (p: string) => p in present, executable: (p: string) => present[p] === true });

describe("a configured commit gate is present", () => {
  it("plant: hooksPath configured, directory missing → a finding", () => {
    expect(gateFindings("/h", fake({}))).toHaveLength(1);
  });
  it("plant: hooksPath configured, pre-commit missing → a finding", () => {
    expect(gateFindings("/h", fake({ "/h": true }))).toHaveLength(1);
  });
  it("plant: pre-commit present but not executable → a finding", () => {
    expect(gateFindings("/h", fake({ "/h": true, "/h/pre-commit": false }))).toHaveLength(1);
  });
  it("twin: no gate configured → nothing to find (CI, a fresh clone)", () => {
    expect(gateFindings(null, fake({}))).toEqual([]);
  });
  it("this tree: if a gate is configured here, it is present and executable", () => {
    let hp: string | null = null;
    try { hp = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: ROOT, encoding: "utf8" }).trim() || null; } catch { hp = null; }
    const abs = hp && !isAbsolute(hp) ? resolve(ROOT, hp) : hp;
    const real = { exists: (p: string) => existsSync(p), executable: (p: string) => { try { return (statSync(p).mode & 0o111) !== 0; } catch { return false; } } };
    expect(gateFindings(abs, real)).toEqual([]);
  });
});
