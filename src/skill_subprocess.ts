// Skill execution + the fixture/determinism runner (skills as first-class, Phase 1 —
// docs/skills-as-first-class.md). A skill package is a directory:
//   skills/<slug>/ { meta.json, skill.mjs, fixtures/*.json }
// The execution half runs in a Node --permission subprocess scoped by the skill's
// permission tier (the Node analog of the old Deno --allow cage). Fixtures are the
// load-bearing instrument: they are the skill's test suite, the determinism meter
// (stable across repeated runs), AND the evolution gate (an improved skill.mjs is
// accepted only if every fixture still passes).
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./skill_runner.mjs", import.meta.url));

export interface SkillMeta {
  slug: string;
  version: number;
  skill_type?: string;
  input_type?: string;
  output_type?: string;
  determinism_ratio?: number;
  permission?: { tier?: number };
}

export interface SkillFixture {
  id: string;
  description?: string;
  input: unknown;
  expected_output?: unknown;
  assertions?: { path: string; op: string; value?: unknown }[];
}

export interface ExecuteResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  duration_ms: number;
}

/**
 * Permission tier → Node --permission flags. Tier 0 is read-only with no side effects
 * (can load its own code + read inputs, but cannot write, spawn, or reach the network).
 * Higher tiers add write, then child_process (needed by skills that shell out, e.g.
 * run-vitest-band). The grant IS the enforcement — a skill can do only what its tier allows.
 */
export function tierFlags(tier: number): string[] {
  const flags = ["--permission", "--allow-fs-read=*"];
  if (tier >= 1) flags.push("--allow-fs-write=*");
  if (tier >= 2) flags.push("--allow-child-process");
  return flags;
}

export function readSkillMeta(skillDir: string): SkillMeta {
  return JSON.parse(readFileSync(join(skillDir, "meta.json"), "utf-8")) as SkillMeta;
}

export function loadFixtures(skillDir: string): SkillFixture[] {
  const dir = join(skillDir, "fixtures");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f) === ".json")
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as SkillFixture);
}

/** Run a skill's execution half in a permission-scoped subprocess. `tierOverride` runs the
 *  skill at a tier other than its declared one — used by the cage matrix to exercise one
 *  capability probe across every tier. */
export function executeSkill(skillDir: string, input: unknown, timeoutMs = 120_000, tierOverride?: number): ExecuteResult {
  const tier = tierOverride ?? (readSkillMeta(skillDir).permission?.tier ?? 0);
  const started = Date.now();
  const res = spawnSync("node", [...tierFlags(tier), RUNNER, skillDir], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const duration_ms = Date.now() - started;
  if (res.error) return { ok: false, error: String(res.error.message), duration_ms };
  try {
    const parsed = JSON.parse(res.stdout) as { ok: boolean; output?: unknown; error?: string };
    return { ...parsed, duration_ms };
  } catch {
    return { ok: false, error: `unparseable skill output: ${(res.stdout || res.stderr || "").slice(0, 300)}`, duration_ms };
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc != null ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

function checkAssertion(output: unknown, a: { path: string; op: string; value?: unknown }): boolean {
  const v = getPath(output, a.path);
  switch (a.op) {
    case "exists": return v !== undefined && v !== null;
    case "is_number": return typeof v === "number";
    case "is_string": return typeof v === "string";
    case "is_boolean": return typeof v === "boolean";
    case "equals": return JSON.stringify(v) === JSON.stringify(a.value);
    default: return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export interface FixtureResult {
  id: string;
  passed: boolean;   // matches expected_output + all assertions hold
  stable: boolean;   // identical output across two runs (determinism)
  error?: string;
}
export interface FixtureReport {
  skill: string;
  total: number;
  passed: number;
  pass_rate: number;
  deterministic: boolean; // every fixture stable across runs
  results: FixtureResult[];
}

/**
 * Run every fixture for a skill. Each fixture is executed twice: once to check it
 * matches expected_output + assertions (the test suite + evolution gate), and a second
 * time to confirm identical output (the determinism meter). A pure skill is green +
 * deterministic; a candidate skill.mjs that regresses a fixture fails here — the gate.
 */
export function runSkillFixtures(skillDir: string): FixtureReport {
  const slug = readSkillMeta(skillDir).slug;
  const fixtures = loadFixtures(skillDir);
  const results: FixtureResult[] = [];
  let passed = 0;
  let deterministic = true;

  for (const fx of fixtures) {
    const r1 = executeSkill(skillDir, fx.input);
    const r2 = executeSkill(skillDir, fx.input);
    const stable = r1.ok && r2.ok && deepEqual(r1.output, r2.output);
    const matchesExpected = fx.expected_output === undefined || deepEqual(r1.output, fx.expected_output);
    const assertionsHold = (fx.assertions ?? []).every((a) => checkAssertion(r1.output, a));
    const ok = r1.ok && matchesExpected && assertionsHold;
    if (ok) passed++;
    if (!stable) deterministic = false;
    results.push({ id: fx.id, passed: ok, stable, ...(r1.ok ? {} : { error: r1.error }) });
  }

  return {
    skill: slug,
    total: fixtures.length,
    passed,
    pass_rate: fixtures.length ? passed / fixtures.length : 0,
    deterministic,
    results,
  };
}
