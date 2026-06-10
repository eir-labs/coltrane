// Shared genome scaffolding — kills the writeJson×5 / seedCoreTypes×6 duplication across
// the genome-infra tests, and makes every agent fixture VALID by default (factory-backed
// behavioral fields) so a schema change touches one place, not thirty.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDef } from "./agents.js";
import type { AgentDef } from "../../src/index.js";

export const CORE_TYPES = ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"] as const;

export function makeGenomeDir(prefix = "coltrane-genome-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
export function rmGenome(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
function writeJson(root: string, sub: string, name: string, body: unknown): void {
  const d = join(root, sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(body, null, 2));
}

/** Seed the 6 core types (or the first `n` of them, to exercise the hard-fail gate). */
export function seedCoreTypes(root: string, n: number = CORE_TYPES.length): void {
  for (const slug of CORE_TYPES.slice(0, n)) writeJson(root, "core_types", `${slug}.json`, { slug, description: `${slug} core type` });
}

/** Write a VALID agent (factory behavioral defaults filled; overrides win). */
export function writeAgent(root: string, o: Partial<AgentDef> & { slug: string; primitives: AgentDef["primitives"] }): void {
  writeJson(root, "agents", `${o.slug}.json`, agentDef(o));
}
/** Write a RAW agent file (e.g. lean/behavior-less or malformed) to exercise soft-fail. */
export function writeRawAgent(root: string, fileName: string, content: string): void {
  const d = join(root, "agents");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, fileName), content);
}
export function writeStandard(root: string, std: { slug: string } & Record<string, unknown>): void {
  writeJson(root, "standards", `${std.slug}.json`, std);
}
/** Write a COMPLETE skill package (meta + a reasoning half + a fixture) — the only valid
 *  skill format. Omit `fixtures` (set to []) to author a deliberately-incomplete one for the
 *  hard-fail gate. */
export function writeSkillPackage(
  root: string,
  o: { slug: string; md?: string; code?: string; fixtures?: unknown[] },
): void {
  const d = join(root, "skills", o.slug);
  mkdirSync(join(d, "fixtures"), { recursive: true });
  writeFileSync(join(d, "meta.json"), JSON.stringify({ slug: o.slug, version: 1, permission: { tier: 0 } }, null, 2));
  if (o.md !== undefined) writeFileSync(join(d, "skill.md"), o.md);
  if (o.code !== undefined) writeFileSync(join(d, "skill.mjs"), o.code);
  if (o.md === undefined && o.code === undefined) writeFileSync(join(d, "skill.md"), "reasoning half");
  const fixtures = o.fixtures ?? [{ id: "basic", input: {}, assertions: [] }];
  fixtures.forEach((fx, i) => writeFileSync(join(d, "fixtures", `f${i}.json`), JSON.stringify(fx)));
}
export function writeType(root: string, t: { slug: string } & Record<string, unknown>): void {
  writeJson(root, "domain_types", `${t.slug}.json`, t);
}
