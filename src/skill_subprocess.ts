// Skill execution + the fixture/determinism runner (skills as first-class, Phase 1 —
// docs/skills-as-first-class.md). A skill package is a directory:
//   skills/<slug>/ { meta.json, skill.mjs, fixtures/*.json }
// The execution half runs in a Node --permission subprocess scoped by the skill's
// permission tier (the Node analog of the old Deno --allow cage). Fixtures are the
// load-bearing instrument: they are the skill's test suite, the determinism meter
// (stable across repeated runs), AND the evolution gate (an improved skill.mjs is
// accepted only if every fixture still passes).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, extname, dirname } from "node:path";
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
  /** Per-skill execution ceiling. Caps the caller-supplied timeout (whichever is smaller). */
  timeout_ms?: number;
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
 * Permission tier → Node --permission flags, SCOPED TO THE SKILL.
 *
 * This used to be `--allow-fs-read=*` for every tier, with a comment asserting that tier 0
 * "cannot write, spawn, or reach the network". Probed through `executeSkill` on a real
 * machine, a tier-0 skill read `/etc/passwd`, read all 77 of the parent's environment
 * variables, and completed an outbound HTTPS request. `--allow-fs-read=*` is literally
 * "read every file", so the first was never confined at all.
 *
 * The reads are now scoped to the skill's own package directory plus the runner that has to
 * import it. `tests/skill_sandbox_confinement.test.ts` probes the capability rather than the
 * flag string, because asserting on flags is how the previous claim survived being false.
 *
 * WHAT THIS DOES NOT DO: Node's permission model has no network gate. There is no flag here
 * that stops `fetch`, and there was never one — the old guarantee was unimplementable in this
 * runtime, not merely misconfigured. A pre-open-source ancestor of this engine ran skills under
 * Deno (`--allow-read=<dir>` plus a net allowlist), which is the runtime with the primitive
 * this wants. Until that returns, an outbound request from a skill is possible and is stated
 * rather than denied. What has changed is that the credential is no longer in reach: the child
 * gets an explicit minimal environment (see `skillEnv`), so there is nothing worth exfiltrating.
 */
/** Node major running this process. */
function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0] ?? 0);
}

/**
 * The runtime floor for skill execution, checked where it can be explained.
 *
 * The sandbox spawns with `--permission`, which is Node 22+. On Node 20 the child dies with
 * `node: bad option: --permission` — a message that names the flag rather than the reason, and
 * appears once per skill rather than once per process. `engines` in package.json says `>=22`,
 * but npm treats that as advisory, so a consumer on 20 reaches here anyway.
 *
 * Refusing loudly is the only honest option. There is no degraded mode: running a skill on a
 * runtime with no permission model means running it UNSANDBOXED, and silently doing that would
 * invert the guarantee this module exists to provide.
 */
export const MIN_NODE_FOR_SANDBOX = 22;

function assertSandboxCapableRuntime(): void {
  const major = nodeMajor();
  if (major < MIN_NODE_FOR_SANDBOX) {
    throw new Error(
      `coltrane needs Node ${MIN_NODE_FOR_SANDBOX}+ to execute skills; this is Node ${process.versions.node}. ` +
        `Skill execution is sandboxed with --permission, which does not exist before Node ${MIN_NODE_FOR_SANDBOX}. ` +
        `Running without it would execute skill code unsandboxed, so it is refused rather than degraded.`,
    );
  }
}

export function tierFlags(tier: number, skillDir?: string): string[] {
  // `RUNNER` lives in this package's dist/; the child must be able to read it to start, and to
  // read the skill it imports. Nothing else.
  // One flag PER PATH: Node no longer accepts a comma-separated list here, and silently
  // warns rather than failing, so a joined list degrades into "no readable paths" and every
  // skill breaks at import time.
  //
  // REAL paths, not the caller's. Node's permission model matches on the resolved path, and on
  // macOS the system temp dir is a symlink (`/var/folders/...` → `/private/var/folders/...`),
  // so granting the symlinked path grants nothing and every skill under it fails at import.
  const real = (pth: string): string => { try { return realpathSync(pth); } catch { return pth; } };
  const own = [real(dirname(RUNNER)), ...(skillDir ? [real(skillDir)] : [])];
  const flags = ["--permission"];

  // TIER 0 is confined to its own package. The tier is documented as "read-only with no side
  // effects — can load its own code + read inputs", and a tier-0 skill's inputs arrive on
  // STDIN, not from the filesystem. It never had a reason to read elsewhere; `--allow-fs-read=*`
  // simply granted it because that was the easiest flag to write.
  //
  // TIER 1+ reads broadly, because that is what those tiers are FOR — a skill that extracts
  // text from a document at a path it was handed, or runs a test band over a repo, has to
  // reach outside its own directory. Confining them would not be security, it would be
  // removing the capability the tier exists to grant.
  if (tier >= 1) flags.push("--allow-fs-read=*", "--allow-fs-write=*");
  else flags.push(...own.map((p2) => `--allow-fs-read=${p2}`));
  if (tier >= 2) flags.push("--allow-child-process");
  return flags;
}

/**
 * The environment a skill child receives.
 *
 * Deliberately NOT `process.env`. The parent's environment carries the provider credential —
 * `ANTHROPIC_API_KEY` in any real deployment — and a skill that can read it plus reach the
 * network can exfiltrate it in one line. Inheriting the whole environment made that a
 * one-liner; this makes it impossible regardless of the network gap above.
 *
 * PATH is kept because a tier-2 skill that may spawn needs to resolve a binary at all, and
 * HOME/TMPDIR because Node itself consults them during startup.
 */
export function skillEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TMPDIR", "LANG", "NODE_OPTIONS"] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * The skill directory as the permission model sees it.
 *
 * Grants are matched on RESOLVED paths, so the path handed to the child must be the same one
 * that was granted. Granting `/private/var/...` while passing `/var/...` (the macOS temp-dir
 * symlink) grants a path the child never asks for, and every read is denied.
 */
function realDir(skillDir: string): string {
  try { return realpathSync(skillDir); } catch { return skillDir; }
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
  const meta = readSkillMeta(skillDir);
  const tier = tierOverride ?? (meta.permission?.tier ?? 0);
  // the skill's own meta.timeout_ms caps the caller's timeout — a runaway code half can't
  // outlive its declared budget. SIGKILL (not the default SIGTERM) is the kill signal so a
  // SIGTERM-trapping child can't survive the timeout.
  const timeout = typeof meta.timeout_ms === "number" ? Math.min(timeoutMs, meta.timeout_ms) : timeoutMs;
  const started = Date.now();
  assertSandboxCapableRuntime();
  const dir = realDir(skillDir);
  const res = spawnSync("node", [...tierFlags(tier, dir), RUNNER, dir], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    killSignal: "SIGKILL",
    env: skillEnv(),
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

/**
 * #253 — the same execution, without blocking the event loop, and cancellable.
 *
 * `executeSkill` uses `spawnSync`, which blocks the thread until the child exits. The
 * runtime's abort chain (#249/#250) is cooperative — `checkpoint()` reads the signal between
 * phases and batches, and the invoker kills its child when the signal fires — and NONE of
 * that can run while the loop is blocked. The abort event cannot even be *delivered*. So
 * `gig_abort` during a skill chair was a promise the engine could not keep for up to the
 * skill's timeout, which by default is 120 seconds.
 *
 * That is #249's shape again: a control the operator reaches for that reports success and
 * does nothing. The difference is that #249 was a missing kill and this was a missing
 * opportunity to kill.
 *
 * `executeSkill` is kept as-is rather than reimplemented on top of this. Its callers — the
 * fixture runner and the determinism meter — are batch tools with no cancellation story, and
 * making them async would ripple through the skill-authoring surface for no benefit. The
 * RUNTIME is the caller that needed this.
 */
export async function executeSkillAsync(
  skillDir: string,
  input: unknown,
  timeoutMs = 120_000,
  opts: { signal?: AbortSignal | undefined; tierOverride?: number | undefined } = {},
): Promise<ExecuteResult> {
  const started = Date.now();
  const abortResult = (): ExecuteResult => ({
    ok: false,
    error: `skill aborted: ${opts.signal ? abortReason(opts.signal) : "cancelled"}`,
    duration_ms: Date.now() - started,
  });

  // Cheapest possible honouring of a cancellation: if it is already aborted, spawn nothing.
  if (opts.signal?.aborted) return abortResult();

  const meta = readSkillMeta(skillDir);
  const tier = opts.tierOverride ?? (meta.permission?.tier ?? 0);
  // As in executeSkill: the skill's own declared ceiling caps the caller's timeout, so a
  // runaway code half cannot outlive its budget.
  const timeout = typeof meta.timeout_ms === "number" ? Math.min(timeoutMs, meta.timeout_ms) : timeoutMs;

  return await new Promise<ExecuteResult>((resolve) => {
    assertSandboxCapableRuntime();
    const dir = realDir(skillDir);
    const child = spawn("node", [...tierFlags(tier, dir), RUNNER, dir], {
      stdio: ["pipe", "pipe", "pipe"], env: skillEnv(),
    });
    // Mirror executeSkill's `maxBuffer: 64 MB`. Accumulating without a cap was a regression
    // against the function this replaces: tier 0 grants --allow-fs-read=*, so "print a large
    // file" is one line of skill code, and an unbounded read grows the LONG-LIVED MCP server's
    // heap by the size of whatever it printed. Bounded, killed, and named — a truncated read
    // must not surface as "unparseable skill output", which says nothing about what happened.
    const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let overflowed = false;
    let settled = false;
    const done = (r: ExecuteResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    // SIGKILL, not the default SIGTERM — a SIGTERM-trapping child must not survive a stop.
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const onAbort = (): void => {
      kill();
      done(abortResult());
    };
    const timer = setTimeout(() => {
      kill();
      done({ ok: false, error: `skill timed out after ${timeout}ms`, duration_ms: Date.now() - started });
    }, timeout);

    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const capture = (buf: Buffer, which: "out" | "err"): void => {
      if (overflowed) return;
      const next = (which === "out" ? stdout : stderr) + buf.toString();
      if (next.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        kill();
        done({
          ok: false,
          error: `skill output exceeded ${MAX_OUTPUT_BYTES} bytes and was killed`,
          duration_ms: Date.now() - started,
        });
        return;
      }
      if (which === "out") stdout = next;
      else stderr = next;
    };
    child.stdout.on("data", (c: Buffer) => capture(c, "out"));
    child.stderr.on("data", (c: Buffer) => capture(c, "err"));
    child.on("error", (e: Error) => done({ ok: false, error: String(e.message), duration_ms: Date.now() - started }));
    child.on("close", () => {
      const duration_ms = Date.now() - started;
      try {
        const parsed = JSON.parse(stdout) as { ok: boolean; output?: unknown; error?: string };
        done({ ...parsed, duration_ms });
      } catch {
        done({
          ok: false,
          error: `unparseable skill output: ${(stdout || stderr || "").slice(0, 300)}`,
          duration_ms,
        });
      }
    });
    child.stdin.on("error", () => {
      /* the child may exit before we finish writing; `close` reports the real outcome */
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** The human-readable cause behind an abort, whatever shape the aborter used. */
function abortReason(signal: AbortSignal): string {
  const r = signal.reason as unknown;
  if (r instanceof Error) return r.message;
  if (typeof r === "string" && r) return r;
  return "cancelled";
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
  stable: boolean;   // identical output across all DETERMINISM_RUNS executions (determinism)
  error?: string;
}
export interface FixtureReport {
  skill: string;
  total: number;
  passed: number;
  pass_rate: number;
  deterministic: boolean; // every fixture stable across ALL runs
  determinism_runs: number; // how many times each fixture was run to read determinism
  results: FixtureResult[];
}

// How many times each fixture runs to read determinism. >=3 so a coincidentally-stable pair
// can't pass as deterministic — a flaky skill that happens to agree twice gets caught.
const DETERMINISM_RUNS = 3;

/**
 * Run every fixture for a skill. Each fixture is executed DETERMINISM_RUNS times: the first
 * run is checked against expected_output + assertions (the test suite + evolution gate); all
 * runs must produce identical output (the determinism meter). A pure skill is green +
 * deterministic; a candidate skill.mjs that regresses a fixture fails here — the gate.
 */
export function runSkillFixtures(skillDir: string): FixtureReport {
  const slug = readSkillMeta(skillDir).slug;
  const fixtures = loadFixtures(skillDir);
  const results: FixtureResult[] = [];
  let passed = 0;
  let deterministic = true;

  for (const fx of fixtures) {
    const runs = Array.from({ length: DETERMINISM_RUNS }, () => executeSkill(skillDir, fx.input));
    const r1 = runs[0]!;
    const stable = runs.every((r) => r.ok) && runs.every((r) => deepEqual(r.output, r1.output));
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
    determinism_runs: DETERMINISM_RUNS,
    results,
  };
}
