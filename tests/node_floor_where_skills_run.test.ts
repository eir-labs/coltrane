// NODE 26 IS ENFORCED WHERE SKILLS RUN, NOT AT INSTALL (founder ruling, 26 Sep 2026).
//
// The sovereign's rule stands: "22 is no starter given lack of network controls, full stop" (#552).
// The Node-26 floor exists because a skill's network grant is enforced by --allow-net, which is
// Node 25+ (052c136), and 25 is end-of-life. But 0.25.4 put that floor at INSTALL (a `preinstall`
// refusing Node < 26), so a library consumer that never runs a skill — coltrane-ui, on Node 24
// everywhere including Vercel, mounting `createToolSurface` from `./tool_surface` — could not take
// any engine release at all (the non-author grade of coltrane-ui #252). The ruling moves the floor to
// where the reason lives: a library install and import below 26 must work; every place a skill's
// code could run below 26 must refuse, loudly and by name.
//
// Which doors refuse, and which do not:
//   refuse  executeSkill          (src/skill_subprocess.ts) — skill_execute, the fixture runner
//   refuse  executeSkillAsync     (src/skill_subprocess.ts) — the runtime's skill chair: what the drain runs
//   refuse  skill_execute         (src/server.ts, local surface; hosted already blocks it — HOSTED_BLOCKED)
//   refuse  `coltrane work`       (src/cli_entry.ts → src/runtime_floor.ts) — the drain worker runs skills
//   admit   every entry of the package's `exports` map, imported as a library (the hosted app's path)
//   admit   the package's install lifecycle (no preinstall/install/postinstall refuses by version)
//
// THE SEAM. No Node 24 is needed: a `--import data:` preload redefines `process.versions.node` before
// any module loads, in a child of THIS runtime (the same fake tests/node_floor_refuses.test.ts uses).
// In-process laws redefine it around one call and restore it. F4 is also the seam's own control: the
// same preload makes the CLI refuse, so a green F1 cannot be a fake that never landed.
//
//   law  kind         drives                                                     plant (smallest production edit → red)
//   F1   behavioural  every exports-map entry, dist/src/*.js (package.json)      add `import "./runtime_floor.js";` to src/tool_surface.ts
//   F2a  behavioural  package.json scripts.preinstall/install/postinstall, run    (red today: preinstall = scripts/node_floor.cjs exits 1)
//   F2b  structural   package.json engines.node                                  (red today: ">=26")
//   F3a  behavioural  executeSkill — src/skill_subprocess.ts                     delete assertSandboxCapableRuntime() from executeSkill
//   F3b  behavioural  executeSkillAsync — src/skill_subprocess.ts                delete assertSandboxCapableRuntime() from executeSkillAsync
//   F3c  behavioural  createToolSurface(...).skill_execute — src/server.ts       delete assertSandboxCapableRuntime() from executeSkill
//   F4   behavioural  dist/src/cli_entry.js `work` (src/runtime_floor.ts)        delete `import "./runtime_floor.js"` from src/cli_entry.ts
//
// Red today: F2a (preinstall refuses Node 24), F2b (engines ">=26"), F3a–c (the refusal names Node 26
// and --permission but never the NETWORK CONTROLS the ruling gives as the reason). F1 and F4 already
// hold at origin/main and are red under their plants — F1 is the guard that keeps the floor from
// creeping back into the library path once the preinstall is gone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeSkill, executeSkillAsync } from "../src/skill_subprocess.js";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  engines?: { node?: string };
  exports: Record<string, string | { import?: string; default?: string }>;
};

const BELOW = "24.21.0"; // the hosted app's runtime (coltrane-ui, Vercel)
/** A preload that makes the child believe it is Node `v` before any module loads. */
const fakeNode = (v: string): string =>
  "data:text/javascript," +
  encodeURIComponent(
    `Object.defineProperty(process,"versions",{value:{...process.versions,node:${JSON.stringify(v)}},configurable:true});`,
  );

/** Run `fn` with THIS process claiming to be Node `v`; always restored. */
async function asNode<T>(v: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(process, "versions")!;
  Object.defineProperty(process, "versions", { value: { ...process.versions, node: v }, configurable: true });
  try {
    expect(process.versions.node, "the version seam did not land").toBe(v);
    return await fn();
  } finally {
    Object.defineProperty(process, "versions", saved);
  }
}

// The refusal must say WHAT is required and WHY — the ruling's reason is the network controls.
const NAMES_NODE_26 = /Node 26/;
const NAMES_NETWORK_CONTROLS = /network|--allow-net/i;

// ── F1 · a library import works below the floor ─────────────────────────────────────────────
describe("F1 — the package imports as a library below Node 26", () => {
  const entries = Object.entries(PKG.exports)
    .map(([k, v]) => [k, typeof v === "string" ? v : (v.import ?? v.default ?? "")] as const)
    .filter(([, p]) => p.endsWith(".js"));

  it("the exports map names the library entries the hosted app mounts (tool_surface, genome_store, the main entry)", () => {
    const keys = entries.map(([k]) => k);
    expect(keys).toEqual(expect.arrayContaining([".", "./tool_surface", "./genome_store"]));
    for (const [k, p] of entries) expect(existsSync(join(ROOT, p)), `${k} → ${p} is not built`).toBe(true);
  });

  it(`every exports-map entry imports under Node ${BELOW} without throwing or exiting`, () => {
    for (const [k, p] of entries) {
      const r = spawnSync(process.execPath, [
        "--import", fakeNode(BELOW), "--input-type=module", "-e",
        `await import(${JSON.stringify(pathToFileURL(join(ROOT, p)).href)}); process.stdout.write("imported under " + process.versions.node);`,
      ], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
      expect(r.status, `importing ${k} (${p}) under Node ${BELOW} exited ${r.status}: ${r.stderr.slice(0, 400)}`).toBe(0);
      expect(r.stdout, `importing ${k} did not complete under the faked runtime`).toBe(`imported under ${BELOW}`);
      expect(r.stderr, `importing ${k} printed a floor refusal`).not.toMatch(/requires Node|needs Node/);
    }
  });

  it(`createToolSurface builds a hosted surface under Node ${BELOW} (the coltrane-ui call)`, () => {
    const ts = entries.find(([k]) => k === "./tool_surface")![1];
    const r = spawnSync(process.execPath, [
      "--import", fakeNode(BELOW), "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, ts)).href)});
       const registry = m.createRegistry();
       const s = m.createToolSurface({ registry, outputs: m.createOutputStore(registry), ledger: new m.MemoryLedger(), gig_runs: new Map(), hosted: true });
       process.stdout.write(String(s.length));`,
    ], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    expect(r.status, `createToolSurface under Node ${BELOW} exited ${r.status}: ${r.stderr.slice(0, 400)}`).toBe(0);
    expect(Number(r.stdout), "the surface came back empty").toBeGreaterThan(0);
  });
});

// ── F2 · the install is not refused below the floor ──────────────────────────────────────────
describe("F2 — installing the package below Node 26 is not refused", () => {
  it(`F2a — no install lifecycle script refuses Node ${BELOW} (each one present is RUN under it)`, () => {
    // npm runs these on every consumer's `npm install`. Each is executed here, as npm would, with
    // the runtime faked through NODE_OPTIONS so any `node` it starts believes it is Node 24.
    for (const hook of ["preinstall", "install", "postinstall"]) {
      const cmd = PKG.scripts?.[hook];
      if (!cmd) continue;
      const r = spawnSync("sh", ["-c", cmd], {
        cwd: ROOT, encoding: "utf8", timeout: 60_000,
        env: { ...process.env, NODE_OPTIONS: `--import=${fakeNode(BELOW)}` },
      });
      expect(r.status, `"${hook}": ${cmd} refused Node ${BELOW} (exit ${r.status}): ${r.stderr.slice(0, 300)}`).toBe(0);
    }
  });

  it("F2b — engines.node admits Node 24 and still says 22 is no starter (lower bound exactly 24)", () => {
    // STRUCTURAL, with its reason: `engines` is read by package managers (yarn v1 and any
    // engine-strict npm/pnpm hard-fail on it), never by code in this repo, so there is no production
    // symbol to call — the invariant IS the manifest field. ">=26" hard-blocks those installs;
    // the ruling keeps 22 out ("no starter"), and 24 is the hosted app's runtime.
    const range = PKG.engines?.node ?? "";
    const lower = range.match(/^\s*>=\s*(\d+)(?:\.\d+){0,2}\s*$/);
    expect(lower, `engines.node is ${JSON.stringify(range)}; expected a plain ">=24"`).not.toBeNull();
    expect(Number(lower![1]), `engines.node ${range} blocks a Node 24 install`).toBe(24);
  });
});

// ── F3 · skill execution refuses below the floor, by name, before any skill code runs ────────
let root: string;
let marker: string;
/** A tier-1 skill whose code writes `marker` — so "ran" is observable on disk. */
function markingSkill(): string {
  const dir = join(root, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    slug: "probe", version: 1, skill_type: "deterministic", input_type: "note", output_type: "note",
    permission: { tier: 1 }, description: "writes a marker when it runs", determinism_ratio: 1,
  }));
  writeFileSync(join(dir, "skill.mjs"),
    `import { writeFileSync } from "node:fs";\nexport async function run() { writeFileSync(${JSON.stringify(marker)}, "ran"); return { ran: true }; }\n`);
  return dir;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "floor-skills-")); marker = join(root, "RAN"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const refusalOf = async (fn: () => unknown): Promise<string> => {
  try {
    const r = await fn();
    const o = r as { ok?: boolean; error?: string };
    return o && o.ok === false && typeof o.error === "string" ? o.error : `NOT REFUSED: ${JSON.stringify(r).slice(0, 300)}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe(`F3 — a skill does not run below Node 26; the refusal names Node 26 and the network controls`, () => {
  it(`F3a — executeSkill under Node ${BELOW} refuses by name and the skill's code never runs`, async () => {
    const dir = markingSkill();
    const msg = await asNode(BELOW, () => refusalOf(() => executeSkill(dir, {})));
    expect(existsSync(marker), "the skill's code RAN below the floor").toBe(false);
    expect(msg, "the refusal does not name Node 26").toMatch(NAMES_NODE_26);
    expect(msg, "the refusal does not name the network controls it exists for").toMatch(NAMES_NETWORK_CONTROLS);
  });

  it(`F3b — executeSkillAsync (the drain's skill chair) under Node ${BELOW} refuses by name; nothing spawns`, async () => {
    const dir = markingSkill();
    const msg = await asNode(BELOW, () => refusalOf(() => executeSkillAsync(dir, {})));
    expect(existsSync(marker), "the drain's skill spawn RAN below the floor").toBe(false);
    expect(msg).toMatch(NAMES_NODE_26);
    expect(msg).toMatch(NAMES_NETWORK_CONTROLS);
  });

  it(`F3c — skill_execute on the local surface under Node ${BELOW} refuses by name; the skill never runs`, async () => {
    const dir = markingSkill();
    const registry = createRegistry();
    const deps: ToolSurfaceDeps = {
      registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map(),
      skills: new Map([["probe", { slug: "probe", package_dir: dir, code_hash: "c0de" }]]) as never,
    };
    const tool = createToolSurface(deps).find((t) => t.name === "skill_execute")!;
    const msg = await asNode(BELOW, () => refusalOf(() => tool.call({ slug: "probe", input: {} })));
    expect(existsSync(marker), "skill_execute RAN a skill below the floor").toBe(false);
    expect(msg).toMatch(NAMES_NODE_26);
    expect(msg).toMatch(NAMES_NETWORK_CONTROLS);
  });

  it("control: at Node 26 the same skill runs (the refusal is the floor, not a broken fixture)", async () => {
    const dir = markingSkill();
    const r = await asNode("26.0.0", () => executeSkill(dir, {}));
    expect(r.ok, String(r.error)).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});

// ── F4 · the drain worker still refuses to start below the floor ─────────────────────────────
describe("F4 — `coltrane work` refuses to start below Node 26 (it runs skills)", () => {
  const cli = join(ROOT, "dist", "src", "cli_entry.js");
  const env = { ...process.env };
  delete env["COLTRANE_STORE_URL"]; delete env["COLTRANE_STORE_ANON"];
  const work = (v: string) =>
    spawnSync(process.execPath, ["--import", fakeNode(v), cli, "work"], { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });

  it(`under Node ${BELOW}: exit 1, naming Node 26 and the network controls, before the verb runs`, () => {
    const r = work(BELOW);
    expect(r.status, `coltrane work started under Node ${BELOW}: ${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`).toBe(1);
    expect(r.stderr).toMatch(/Node 26/);
    expect(r.stderr).toMatch(NAMES_NETWORK_CONTROLS);
    expect(r.stdout + r.stderr, "the work verb ran before the floor refused").not.toMatch(/work needs COLTRANE_STORE_URL/);
  });

  it("control: under Node 26 the verb runs (and asks for its store) — the seam is the only difference", () => {
    const r = work("26.0.0");
    expect(r.stderr).not.toMatch(/requires Node/);
    expect(r.stdout + r.stderr).toMatch(/work needs COLTRANE_STORE_URL/);
  });
});
