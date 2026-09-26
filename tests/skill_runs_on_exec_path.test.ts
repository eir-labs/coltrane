// A SKILL RUNS ON THE NODE THAT CHECKED THE FLOOR — process.execPath, never `node` from PATH.
//
// The non-author grade of #557 (issuecomment-5847532054) found the door the F3 laws could not see.
// assertSandboxCapableRuntime() and tierFlags() read process.versions.node, the PARENT's version, but
// executeSkill / executeSkillAsync spawned the bare string "node", which is resolved from PATH. A Node 26
// parent with a Node 24 first on PATH (nvm, a system node, npx under another Node, a host whose PATH
// differs from the binary that launched `coltrane work`) passes the floor, and the skill then runs on 24.
// Reproduced on the packed tarball: parent 26.7.0, PATH node 24.21.0, a tier-0 skill with NO network
// grant fetched a local listener and got 200. F3 faked the parent's version, which is exactly the
// object this defect leaves alone.
//
// THE SHIM. A fake `node` goes first on PATH. It records that it was invoked, then behaves like a Node
// with no permission model: it drops `--permission` and every `--allow-*` flag and runs the real
// binary. So a spawn that resolves `node` from PATH is SEEN (the log), and would run unconfined
// (tests/security/skill_runs_on_exec_path.spec.ts proves the leak with a real request; the root suite
// may not open a socket).
//
// P3 — THE SWEEP of every launch of a bare `node`/`npx` in src/ (verdicts in the red-spec,
// docs/specs/node-floor-where-skills-run.red-spec.md). Sites that launch skill or engine child code
// get a law here:
//
//   law  kind         drives                                                  plant (smallest production edit → red)
//   P1a  behavioural  executeSkill — src/skill_subprocess.ts                 (red at ad9d5ec) · after: spawnSync("node", …) in executeSkill
//   P1b  behavioural  executeSkillAsync — src/skill_subprocess.ts            (red at ad9d5ec) · after: spawn("node", …) in executeSkillAsync
//   P1c  behavioural  createToolSurface(...).skill_execute — src/server.ts   (red at ad9d5ec) · after: skill_execute spawns "node" itself instead of calling executeSkill
//   P3a  behavioural  bootstrapServerDeps(root).mcpServerConfigs — src/server.ts, readMcpServerConfigs fallback
//                                                                            (red at ad9d5ec: command "node")
//   P3b  behavioural  dist/src/server_entry.js relay → runRelay/spawnChild — src/server_relay.ts
//                                                                            spawn("node", [entryPath]) in spawnChild (holds at ad9d5ec)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeSkill, executeSkillAsync } from "../src/skill_subprocess.js";
import { bootstrapServerDeps, createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let root: string;
let shimLog: string;
let savedPath: string | undefined;

/** A `node` that logs its invocation and runs the real binary WITHOUT the permission model. */
function installShim(): string {
  const bin = join(root, "shim-bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "node");
  writeFileSync(shim, [
    "#!/bin/sh",
    `printf 'invoked\\n' >> ${JSON.stringify(shimLog)}`,
    'for a do shift; case "$a" in --permission|--allow-*) ;; *) set -- "$@" "$a" ;; esac; done',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(shim, 0o755);
  return bin;
}

/** A tier-0 skill with no grants that reports it ran. */
function probeSkill(): string {
  const dir = join(root, "probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    slug: "probe", version: 1, skill_type: "deterministic", input_type: "note", output_type: "note",
    permission: { tier: 0 }, description: "reports it ran", determinism_ratio: 1,
  }));
  writeFileSync(join(dir, "skill.mjs"), "export async function run() { return { ran: true }; }\n");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "exec-path-"));
  shimLog = join(root, "shim.log");
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${installShim()}${delimiter}${savedPath ?? ""}`;
  // The shim must actually be what PATH resolves, or "never invoked" is a pass about nothing.
  const probe = spawnSync("node", ["-e", "0"], { encoding: "utf8" });
  expect(probe.status, "the PATH shim does not run").toBe(0);
  expect(existsSync(shimLog), "a bare `node` did not resolve to the shim — the seam did not land").toBe(true);
  rmSync(shimLog);
});
afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

const NEVER = "the skill was launched through `node` on PATH, not process.execPath — the floor checked a different Node than the one that ran it";

describe("P1 — skill execution never launches `node` from PATH; it runs on process.execPath", () => {
  it("P1a — executeSkill", () => {
    const r = executeSkill(probeSkill(), {});
    expect(r.ok, String(r.error)).toBe(true);
    expect(existsSync(shimLog), NEVER).toBe(false);
  });

  it("P1b — executeSkillAsync (the runtime's skill chair — what the drain runs)", async () => {
    const r = await executeSkillAsync(probeSkill(), {});
    expect(r.ok, String(r.error)).toBe(true);
    expect(existsSync(shimLog), NEVER).toBe(false);
  });

  it("P1c — skill_execute on the local surface", async () => {
    const dir = probeSkill();
    const registry = createRegistry();
    const deps: ToolSurfaceDeps = {
      registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map(),
      skills: new Map([["probe", { slug: "probe", package_dir: dir, code_hash: "c0de" }]]) as never,
    };
    const r = await createToolSurface(deps).find((t) => t.name === "skill_execute")!.call({ slug: "probe", input: {} });
    expect(r.ok, String(r.error)).toBe(true);
    expect(existsSync(shimLog), NEVER).toBe(false);
  });
});

describe("P3 — the sweep: every engine child the engine launches names its Node explicitly", () => {
  it("P3a — the engine MCP server a chair is handed (bootstrap's fallback when no .mcp.json) runs on process.execPath", () => {
    // Launched by the claude CLI as the chair's `coltrane` MCP server. Its `command` was "node": the
    // chair's engine tools ran on whichever Node the CLI found first. server_entry refuses below 26, so
    // this fails CLOSED (the chair loses its engine tools) rather than open — but it is still the
    // wrong Node, and the one the engine that booted it did not check.
    const genome = join(root, "genome");
    mkdirSync(genome, { recursive: true });
    cpSync(join(ROOT, "core_types"), join(genome, "core_types"), { recursive: true });
    expect(existsSync(join(genome, ".mcp.json")), "the fixture has a .mcp.json — the fallback is not what is driven").toBe(false);
    const cfg = (bootstrapServerDeps(genome).mcpServerConfigs ?? {})["coltrane"] as { command?: string } | undefined;
    expect(cfg, "bootstrap handed the chair no engine server").toBeDefined();
    expect(cfg!.command, "the engine MCP server is launched as a bare `node` from PATH").toBe(process.execPath);
  });

  it("P3b — the MCP relay spawns its server child on process.execPath", async () => {
    // `coltrane-server` (relay mode) re-launches server_entry as its child on start and on
    // server_restart. The child is engine code serving skill_execute.
    //
    // DETERMINISTIC by construction. The first version fed the relay `input: ""`: stdin closed, the
    // relay exited and killed its child, and the PATH shim was often not yet reached, so the plant
    // went red 1 run in 4. Now stdin stays OPEN until the child is PROVEN started, and the proof does
    // not depend on which binary ran it: a NODE_OPTIONS preload, inherited by the child through the
    // relay's `{...process.env}`, records the execPath of every Node that starts with
    // COLTRANE_SERVER_DIRECT=1 (the relay's child, and only it). Under the plant the shim logs BEFORE
    // it execs the real binary, so by the time the child is recorded, the shim log exists.
    const started = join(root, "child-started.log");
    const preload = "data:text/javascript," + encodeURIComponent(
      `import { appendFileSync } from "node:fs";` +
      `if (process.env.COLTRANE_SERVER_DIRECT === "1") appendFileSync(${JSON.stringify(started)}, process.execPath + "\\n");`,
    );
    const relay = spawn(process.execPath, [join(ROOT, "dist", "src", "server_entry.js")], {
      cwd: ROOT, stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, COLTRANE_SERVER_DIRECT: "", NODE_OPTIONS: `--import=${preload}` },
    });
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(started) && relay.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Non-vacuity: the relay must have started a server child at all, or "the shim was never
      // invoked" says nothing.
      expect(existsSync(started), `the relay never started its server child (relay exit ${relay.exitCode})`).toBe(true);
      expect(existsSync(shimLog), "the relay launched its server child through `node` on PATH").toBe(false);
      expect(readFileSync(started, "utf8").trim().split("\n"), "the server child ran on a Node other than the relay's").toEqual([process.execPath]);
    } finally {
      relay.stdin?.end();
      relay.kill("SIGKILL");
    }
  });
});
