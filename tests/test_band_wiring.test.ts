// #262 — the guard against the next orphan band.
//
// The disease: a vitest config that no npm script invokes, or a test file that no config
// matches. Either way the tests parse, review as coverage, and never execute. Found by audit,
// not by tooling:
//
//   * tests/security/prompt_injection.spec.ts — three prompt-injection resistance scenarios.
//     The root config EXCLUDES tests/security/**, and no script pointed at
//     tests/security/vitest.config.ts. A security gate that had never once run.
//   * the entire e2e band — 36 files. `npm run e2e` existed; nothing invoked it, and
//     test.yml's e2e-smoke job echoed a warning and exited 0, gated to push-to-main.
//   * tests/honest_broker/vitest.config.ts — run by no script.
//   * ci.yml ran `npm run verify` while test.yml and coverage.yml ran `npx vitest run`, which
//     is root-config-only. "CI is green" meant two different sets.
//
// This file is the same shape as tests/failure_modes_suite_wiring.test.ts (#219), which
// caught exactly one instance of this by hand. It generalises it: instead of naming one
// config, it derives the whole config × script × workflow table and asserts it closes.
//
// It lives in the UNIT band on purpose — a wiring guard that is itself unwired would be the
// disease it is diagnosing.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

/**
 * Scripts that legitimately do NOT run in CI. An exemption has to be written down here, with
 * its reason, or the CI-coverage assertion fails — so "nothing runs this band" can never
 * again be the silent default. This is the one place the list is allowed to grow, and it
 * grows in a diff a reviewer reads.
 */
const CI_EXEMPT: Record<string, string> = {
  e2e: "the full e2e band spawns the real `claude` CLI; it needs a scripted CLI install + " +
    "ANTHROPIC_API_KEY, neither of which is wired into Actions. The half that needs no " +
    "model runs on every PR as `e2e:offline`, so the exemption covers the live specs only.",
};

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

function packageScripts(): Record<string, string> {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).scripts as Record<string, string>;
}

/** Every tracked test file, repo-relative with forward slashes. */
function testFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "tests"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return out.split("\n").filter((p) => /\.(test|spec)\.ts$/.test(p));
}

/** Every vitest config in the repo (root + per-band), repo-relative with forward slashes. */
function configPaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git" || name === "coverage") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (/^vitest(\.[a-z0-9-]+)?\.config\.ts$/.test(name)) {
        found.push(relative(REPO_ROOT, abs).split(sep).join("/"));
      }
    }
  };
  walk(REPO_ROOT);
  return found.sort();
}

/**
 * Translate the glob subset these configs actually use into a RegExp. Deliberately narrow:
 * an unsupported pattern THROWS rather than quietly matching nothing, because a guard that
 * silently mismatches is worse than no guard.
 */
function globToRegExp(glob: string): RegExp {
  if (/[?[\]{}()!+@]/.test(glob)) {
    throw new Error(
      `test_band_wiring: unsupported glob syntax in "${glob}". This guard understands only ` +
        "literal segments, *, and **. Extend globToRegExp (and its tests) rather than " +
        "letting a pattern match nothing silently.",
    );
  }
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (glob[i + 2] === "/") { re += "(?:[^/]*/)*"; i += 2; } else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*"; // a single * never crosses a directory boundary
      }
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

interface BandConfig {
  path: string;
  include: string[];
  exclude: string[];
}

/** Load a config by importing it — the resolved object, not a regex guess at its source. */
async function loadConfig(relPath: string): Promise<BandConfig> {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, relPath)).href)) as { default: unknown };
  const raw = mod.default;
  const resolved = (typeof raw === "function" ? (raw as () => unknown)() : raw) as
    { test?: { include?: string[]; exclude?: string[] } } | undefined;
  const test = resolved?.test;
  expect(test, `${relPath} exports no \`test\` block — nothing can be derived from it`).toBeDefined();
  return {
    path: relPath,
    include: test?.include ?? [],
    exclude: test?.exclude ?? [],
  };
}

function matches(cfg: BandConfig, file: string): boolean {
  const inc = cfg.include.some((g) => globToRegExp(g).test(file));
  if (!inc) return false;
  return !cfg.exclude.some((g) => globToRegExp(g).test(file));
}

function workflowText(): string {
  if (!existsSync(WORKFLOW_DIR)) return "";
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(WORKFLOW_DIR, f), "utf-8"))
    .join("\n");
}

/** Does `script` run, directly or through another script's `npm run X`, in `command`? */
function scriptReachableFrom(command: string, script: string, scripts: Record<string, string>, seen = new Set<string>()): boolean {
  if (new RegExp(`npm (run |test\\b)`).test(command) === false && !command.includes(script)) return false;
  if (new RegExp(`\\bnpm run ${script}\\b`).test(command)) return true;
  if (script === "test" && /\bnpm test\b/.test(command)) return true;
  for (const [name, body] of Object.entries(scripts)) {
    if (seen.has(name)) continue;
    if (!new RegExp(`\\bnpm run ${name}\\b`).test(command) && !(name === "test" && /\bnpm test\b/.test(command))) continue;
    seen.add(name);
    if (scriptReachableFrom(body, script, scripts, seen)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. every test file is claimed by at least one config
// ────────────────────────────────────────────────────────────────────────────

describe("#262 — no test file executes under nothing", () => {
  it("every *.test.ts / *.spec.ts under tests/ is matched by some vitest config", async () => {
    const configs = await Promise.all(configPaths().map(loadConfig));
    expect(configs.length, "no vitest configs found — the discovery walk is broken").toBeGreaterThan(0);

    const orphans: string[] = [];
    for (const file of testFiles()) {
      if (!configs.some((c) => matches(c, file))) orphans.push(file);
    }

    expect(
      orphans,
      "these test files match NO vitest config, so no runner can ever execute them. They " +
        "parse, they type-check, they read as coverage in review, and they are inert. Give " +
        "each one a config whose `include` reaches it (and whose `exclude` does not), or " +
        `delete it deliberately. Configs searched: [${configs.map((c) => c.path).join(", ")}]`,
    ).toEqual([]);
  });

  it("every config claims at least one test file (no config points at nothing)", async () => {
    const configs = await Promise.all(configPaths().map(loadConfig));
    const files = testFiles();
    const empty = configs.filter((c) => !files.some((f) => matches(c, f))).map((c) => c.path);
    expect(
      empty,
      "these configs match no test file at all — either their include glob has rotted past " +
        "a rename, or the band they were written for is gone.",
    ).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. every config is invoked by an npm script
// ────────────────────────────────────────────────────────────────────────────

describe("#262 — no vitest config is orphaned from package.json", () => {
  it("every non-root config is named by some npm script", () => {
    const scripts = packageScripts();
    const unrun: string[] = [];
    for (const cfg of configPaths()) {
      if (cfg === "vitest.config.ts") continue; // the root config is the implicit default
      if (!Object.values(scripts).some((cmd) => cmd.includes(cfg))) unrun.push(cfg);
    }
    expect(
      unrun,
      "these vitest configs are invoked by NO npm script. tests/security/vitest.config.ts was " +
        "in exactly this state: a prompt-injection suite that had never executed, because the " +
        "root config excludes tests/security/** and nothing else pointed at it. A band with " +
        `no script is a band nobody runs. Scripts present: [${Object.keys(scripts).join(", ")}]`,
    ).toEqual([]);
  });

  it("the root config is run by a bare `vitest run` script", () => {
    const scripts = packageScripts();
    const bare = Object.entries(scripts).filter(([, cmd]) => /\bvitest run\b/.test(cmd) && !cmd.includes("--config"));
    expect(bare.map(([n]) => n), "no script runs the root config").not.toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. every band script runs in CI (or its exemption is written down)
// ────────────────────────────────────────────────────────────────────────────

describe("#262 — every band script reaches CI, or says in writing why not", () => {
  /** The scripts that run a vitest band (root or otherwise). */
  function bandScripts(): string[] {
    const scripts = packageScripts();
    return Object.entries(scripts)
      .filter(([, cmd]) => /\bvitest run\b/.test(cmd))
      .map(([name]) => name);
  }

  it("finds the band scripts (sanity — the filter still matches something)", () => {
    expect(bandScripts().length).toBeGreaterThan(2);
  });

  it("each band script is invoked by a workflow, directly or through another script", () => {
    const scripts = packageScripts();
    const yaml = workflowText();
    expect(yaml.length, "no workflow files found under .github/workflows").toBeGreaterThan(0);

    const dark: string[] = [];
    for (const name of bandScripts()) {
      if (name in CI_EXEMPT) continue;
      const runsInCI =
        new RegExp(`\\bnpm run ${name}\\b`).test(yaml) ||
        (name === "test" && /\bnpm test\b/.test(yaml)) ||
        Object.entries(scripts).some(
          ([outer, body]) =>
            (new RegExp(`\\bnpm run ${outer}\\b`).test(yaml) || (outer === "test" && /\bnpm test\b/.test(yaml))) &&
            scriptReachableFrom(body, name, scripts),
        );
      if (!runsInCI) dark.push(name);
    }

    expect(
      dark,
      "these band scripts run in no CI job and carry no written exemption. `npm run e2e` was " +
        "in exactly this state: the script existed, nothing invoked it, and test.yml's " +
        "e2e-smoke job echoed a warning and exited 0 — so 36 files and 159 tests executed " +
        "nowhere in automation, which is how a 30-second relay hang reached an integration. " +
        "Add the script to a workflow, or add it to CI_EXEMPT with a reason.",
    ).toEqual([]);
  });

  it("every CI_EXEMPT entry still names a real script with a real reason", () => {
    const scripts = packageScripts();
    for (const [name, reason] of Object.entries(CI_EXEMPT)) {
      expect(scripts[name], `CI_EXEMPT names "${name}", which is not a script any more`).toBeDefined();
      expect(reason.length, `CI_EXEMPT["${name}"] needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it("`verify` reaches every band script that is not CI-exempt", () => {
    const scripts = packageScripts();
    const verify = scripts["verify"] ?? "";
    const missed = Object.entries(scripts)
      // `verify` is the aggregator being checked, not one of the bands it has to reach.
      .filter(([name, cmd]) => name !== "verify" && /\bvitest run\b/.test(cmd) && !(name in CI_EXEMPT))
      .map(([name]) => name)
      .filter((name) => !scriptReachableFrom(verify, name, scripts) && !(name === "test" && /\bvitest run\b/.test(verify)));
    expect(
      missed,
      `\`verify\` is "${verify}". A developer running the project's own gate must exercise the ` +
        "same bands CI does, or local-green and CI-green mean different things — which is " +
        "precisely the divergence that let these bands rot.",
    ).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. the offline-e2e exclude list is a live list, not a graveyard
// ────────────────────────────────────────────────────────────────────────────

describe("#262 — the offline e2e exclude list stays honest", () => {
  it("every excluded spec still exists", async () => {
    const { LIVE_CLAUDE_SPECS } = await import("./e2e/vitest.offline.config.js");
    const missing = LIVE_CLAUDE_SPECS.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      "these paths are excluded from the offline e2e run but no longer exist. A stale exclude " +
        "is invisible: it silently stops protecting anything, and it hides the fact that its " +
        "replacement is unprotected.",
    ).toEqual([]);
  });

  it("the offline config still runs a real, non-empty set of specs", async () => {
    const cfg = await loadConfig("tests/e2e/vitest.offline.config.ts");
    const kept = testFiles().filter((f) => matches(cfg, f));
    expect(
      kept.length,
      "the offline e2e config excludes everything it includes. A job that runs zero tests is " +
        "the e2e-smoke stub with extra steps.",
    ).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. the glob matcher this guard depends on
// ────────────────────────────────────────────────────────────────────────────

describe("#262 — globToRegExp (the guard's own premise)", () => {
  it("** spans directories, * does not", () => {
    expect(globToRegExp("tests/**/*.test.ts").test("tests/a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("tests/**/*.test.ts").test("tests/c.test.ts")).toBe(true);
    expect(globToRegExp("tests/*.test.ts").test("tests/a/b.test.ts")).toBe(false);
  });

  it("a trailing /** matches everything under the directory", () => {
    expect(globToRegExp("tests/e2e/**").test("tests/e2e/x.spec.ts")).toBe(true);
    expect(globToRegExp("tests/e2e/**").test("tests/other/x.spec.ts")).toBe(false);
  });

  it("an explicit file path matches only itself", () => {
    expect(globToRegExp("tests/e2e/a.spec.ts").test("tests/e2e/a.spec.ts")).toBe(true);
    expect(globToRegExp("tests/e2e/a.spec.ts").test("tests/e2e/ab.spec.ts")).toBe(false);
  });

  it("refuses glob syntax it does not implement rather than matching nothing", () => {
    expect(() => globToRegExp("tests/**/*.{test,spec}.ts")).toThrow(/unsupported glob syntax/);
  });
});
