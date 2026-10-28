// DR-3b — a skill's pin covers its local import closure (Vör, grading #598 at a189507).
//
// hashSkillCode hashed ONE file. baseline-gate's skill.mjs imports compareBaselineLoop from
// ../../dist/src/baseline_holds.js, outside the pin: Vör sabotaged one line of that dist file under an untouched,
// correctly-pinned skill.mjs, the drain still seated the gate as authentic, and a violating pair passed. The suite
// could not see it — globalSetup rebuilds dist before any test — so the exposure lived only at production run time.
//
// The pin now hashes the skill's transitive LOCAL import closure (every relative specifier, static or literal
// dynamic, followed through the files it names). A skill that imports nothing local hashes exactly as before, so
// every existing pin stands. A closure that cannot be resolved — a relative file that is not there, a dynamic import
// whose specifier is not a literal — is refused (SkillLoadError) whatever the meta pins: never seated on a guess.
// Bare specifiers (node:*, packages) are outside the closure; that is the stated trust surface.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as skills from "../src/skills.js";
import { drainSkillDirs } from "../src/run_deps.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const w = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** An engine-shaped root: skills/<slug>/skill.mjs importing ../../dist/src/helper.js, pinned with hashSkillCode. */
function engine(skillCode: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "skill-closure-")); tmps.push(root);
  for (const [rel, text] of Object.entries(files)) w(root, rel, text);
  w(root, "skills/closer/skill.mjs", skillCode);
  const pin = skills.hashSkillCode(join(root, "skills/closer/skill.mjs"));
  w(root, "skills/closer/meta.json", JSON.stringify({ slug: "closer", version: 1, skill_type: "verification", determinism_ratio: 1, permission: { tier: 1 }, code_hash: pin }));
  return root;
}
const IMPORTS_HELPER = `import { holds } from "../../dist/src/helper.js";\nexport default (input) => ({ pass: holds(input) });\n`;
const HELPER = `import { strict } from "./strict.js";\nexport const holds = (x) => strict(x);\n`;
const STRICT = `export const strict = (x) => x === true;\n`;

describe("DR-3b — the pin covers the skill's local import closure", () => {
  it("twin, must be ALLOWED — an untouched closure under its pin is seated", () => {
    const root = engine(IMPORTS_HELPER, { "dist/src/helper.js": HELPER, "dist/src/strict.js": STRICT });
    expect(drainSkillDirs(root).dirs.has("closer")).toBe(true);
  });

  it("plant (Vör's) — one line of the IMPORTED file tampered, skill.mjs untouched: refused at seating, naming the mismatch", () => {
    const root = engine(IMPORTS_HELPER, { "dist/src/helper.js": HELPER, "dist/src/strict.js": STRICT });
    w(root, "dist/src/helper.js", HELPER.replace("strict(x)", "true"));
    const s = drainSkillDirs(root);
    expect(s.dirs.has("closer"), "a tampered import walked through an untouched pin").toBe(false);
    expect(s.refused.find((r) => r.slug === "closer")?.reason ?? "").toMatch(/code_hash/);
  });

  it("plant — a file two imports deep tampered: refused (the closure is transitive)", () => {
    const root = engine(IMPORTS_HELPER, { "dist/src/helper.js": HELPER, "dist/src/strict.js": STRICT });
    w(root, "dist/src/strict.js", STRICT.replace("x === true", "true"));
    expect(drainSkillDirs(root).dirs.has("closer")).toBe(false);
  });

  it("plant — a relative import that is no longer there (pinned while it was): refused, never seated on a guess", () => {
    const root = engine(IMPORTS_HELPER, { "dist/src/helper.js": HELPER, "dist/src/strict.js": STRICT });
    rmSync(join(root, "dist/src/strict.js"));
    const s = drainSkillDirs(root);
    expect(s.dirs.has("closer")).toBe(false);
    expect(s.refused.find((r) => r.slug === "closer")?.reason ?? "").toMatch(/unresolvable/);
  });

  it("plant — a dynamic import whose specifier is not a literal, pinned under the one-file rule: refused (its closure cannot be known)", () => {
    const code = `const p = "../../dist/src/" + "helper.js";\nexport default async (i) => (await import(p)).holds(i);\n`;
    const root = engine(IMPORTS_HELPER, { "dist/src/helper.js": HELPER, "dist/src/strict.js": STRICT });
    w(root, "skills/closer/skill.mjs", code);
    const meta = JSON.parse(readFileSync(join(root, "skills/closer/meta.json"), "utf8"));
    meta.code_hash = `sha256:${createHash("sha256").update(code).digest("hex")}`;
    w(root, "skills/closer/meta.json", JSON.stringify(meta));
    const s = drainSkillDirs(root);
    expect(s.dirs.has("closer")).toBe(false);
    expect(s.refused.find((r) => r.slug === "closer")?.reason ?? "").toMatch(/not a literal/);
    expect(() => skills.hashSkillCode(join(root, "skills/closer/skill.mjs"))).toThrow(/unresolvable/);
  });

  it("control — a skill that imports nothing local hashes exactly as before: scope-gate's pin is its file's sha256", () => {
    const p = join(ROOT, "skills/scope-gate/skill.mjs");
    const plain = `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
    expect(skills.hashSkillCode(p)).toBe(plain);
    expect(JSON.parse(readFileSync(join(ROOT, "skills/scope-gate/meta.json"), "utf8")).code_hash).toBe(plain);
  });

  it("the real baseline-gate — its closure names dist/src/baseline_holds.js, and its pin is the closure's", () => {
    const closure = (skills as unknown as { skillCodeClosure?: (p: string) => { files: string[] } }).skillCodeClosure;
    expect(typeof closure, "src/skills.ts exports no skillCodeClosure").toBe("function");
    const files = closure!(join(ROOT, "skills/baseline-gate/skill.mjs")).files.map((f) => f.replace(ROOT, ""));
    expect(files).toContain("dist/src/baseline_holds.js");
    expect(drainSkillDirs(ROOT).dirs.has("baseline-gate"), `refused: ${JSON.stringify(drainSkillDirs(ROOT).refused)}`).toBe(true);
  });
});
