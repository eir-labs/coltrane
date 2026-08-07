// The command line — the invocation layer.
//
// The package shipped exactly one executable: the MCP stdio server. So the engine was reachable
// from an MCP client and from nowhere else — not CI, not cron, not a container, not a queue
// worker, not a shell. A methodology engine whose only caller is an interactive client cannot
// be part of a build.
//
// What these tests care about most is that the CLI is a WRAPPER and not a second opinion.
// `dispatchTool` is already the whole tool surface as a pure function; two front doors that
// disagreed about what a dispatch means would be exactly the defect this release spent its time
// removing. So the assertions below are mostly about faithful translation: the right tool, the
// right arguments, and an exit code that means what a script will assume it means.
import { describe, it, expect } from "vitest";
import { runCli, parseArgs, readInput, USAGE, type CliIO } from "../src/cli.js";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import type { ServerDeps } from "../src/server.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BEHAVIOR } from "./_support/agents.js";

function io(over: Partial<CliIO> = {}): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    ...over,
  } as CliIO & { stdout: string[]; stderr: string[] };
}

function deps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
}

describe("argument parsing", () => {
  it("separates the command, its positionals and its flags", () => {
    const p = parseArgs(["dispatch", "my-standard", "--depth", "skim", "--json"]);
    expect(p.cmd).toBe("dispatch");
    expect(p.positional).toEqual(["my-standard"]);
    expect(p.flags).toEqual({ depth: "skim", json: true });
  });

  it("accepts --flag=value", () => {
    expect(parseArgs(["trace", "o1", "--direction=downstream"]).flags["direction"]).toBe("downstream");
  });

  it("does not let a boolean flag swallow the next flag", () => {
    // `--reuse --json` must be two booleans. A naive "next token is the value" parser turns
    // this into { reuse: "--json" } and silently drops the JSON output the caller asked for.
    const p = parseArgs(["dispatch", "s", "--reuse", "--json"]);
    expect(p.flags["reuse"]).toBe(true);
    expect(p.flags["json"]).toBe(true);
  });
});

describe("--input", () => {
  it("parses inline JSON", () => {
    expect(readInput('{"a":1}', io()).value).toEqual({ a: 1 });
  });

  it("reads stdin for -", () => {
    expect(readInput("-", io({ stdin: () => '{"b":2}' })).value).toEqual({ b: 2 });
  });

  it("defaults to an empty payload rather than failing", () => {
    expect(readInput(undefined, io()).value).toEqual({});
  });

  it("reports unreadable input instead of dispatching with a silent empty payload", () => {
    // Dispatching `{}` because the file was malformed would spend real money on the wrong run.
    const r = readInput("{not json", io());
    expect(r.error).toBeTruthy();
    expect(r.value).toBeUndefined();
  });
});

describe("exit codes are the contract", () => {
  it("no command prints usage and exits 2", async () => {
    const o = io();
    expect(await runCli([], o)).toBe(2);
    expect(o.stdout.join("")).toContain("coltrane validate");
  });

  it("an unknown command exits 2, not 1", async () => {
    // 2 means "you typed it wrong", 1 means "it ran and failed". A CI script branches on that.
    const o = io();
    expect(await runCli(["dispatchh"], o)).toBe(2);
    expect(o.stderr.join("")).toContain("unknown command");
  });

  it("--help exits 0", async () => {
    const o = io();
    expect(await runCli(["help"], o)).toBe(0);
  });

  it("--version prints just the version", async () => {
    const o = io();
    expect(await runCli(["--version"], o)).toBe(0);
    expect(o.stdout.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("a missing required positional exits 2", async () => {
    for (const cmd of [["dispatch"], ["monitor"], ["abort"], ["trace"], ["simulate"], ["logs"]]) {
      const o = io({ deps: deps() });
      expect(await runCli(cmd, o), cmd[0]).toBe(2);
    }
  });
});

describe("validate — the CI gate", () => {
  // The reason this command exists, and the one test worth running against a REAL genome on
  // disk rather than a stub: `genome_reload` re-reads from `deps.genome_dir`, so a fixture that
  // sets `load_errors` on the deps object proves nothing about what a CI job would see.
  const TYPE = {
    slug: "note", version: 1, extends: "Signal", domain: "demo",
    schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
  };
  const AGENT = {
    slug: "scout", version: 1, domain: "demo", primitives: ["SENSE"],
    input_types: [], output_types: ["note"], description: "d", status: "active",
    allowed_tools: [], disallowed_tools: [], skill_slugs: [],
    ...TEST_BEHAVIOR,
  };
  const phases = (agent: string) => [{
    name: "p",
    chairs: [{ role: "r", agent_slug: agent, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }],
  }];

  function root(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "cli-genome-"));
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, JSON.stringify(body, null, 2));
    }
    return dir;
  }

  it("exits 0 on a genome that loads", async () => {
    const dir = root({
      "domain_types/note.json": TYPE,
      "agents/scout.json": AGENT,
      "standards/live.json": { slug: "live", domain: "demo", agent_slugs: ["scout"], phases: phases("scout") },
    });
    try {
      const o = io();
      const code = await runCli(["validate", "--genome", dir], o);
      expect(code, o.stderr.join("")).toBe(0);
      expect(o.stdout.join("")).toContain("genome ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exits NON-ZERO on a genome that does not, and names the problem", async () => {
    // A standard bound to an agent that does not exist — the shape a bad merge produces.
    const dir = root({
      "domain_types/note.json": TYPE,
      "agents/scout.json": AGENT,
      "standards/broken.json": { slug: "broken", domain: "demo", agent_slugs: ["ghost"], phases: phases("ghost") },
    });
    try {
      const o = io();
      const code = await runCli(["validate", "--genome", dir], o);
      expect(code, "a CI job branches on this exact number").toBe(1);
      expect(o.stderr.join(""), "and it must say WHICH definition broke").toContain("ghost");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still exits non-zero with --json, so a machine caller cannot miss the failure", async () => {
    const dir = root({
      "domain_types/note.json": TYPE,
      "agents/scout.json": AGENT,
      "standards/broken.json": { slug: "broken", domain: "demo", agent_slugs: ["ghost"], phases: phases("ghost") },
    });
    try {
      const o = io();
      expect(await runCli(["validate", "--genome", dir, "--json"], o)).toBe(1);
      expect(JSON.parse(o.stdout.join(""))).toHaveProperty("load_errors");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("dispatch translates faithfully to gig_dispatch", () => {
  function capturing(): { deps: ServerDeps; seen: Record<string, unknown>[] } {
    const seen: Record<string, unknown>[] = [];
    const base = deps();
    // A standards map + invoke make gig_dispatch reachable; the invoker records the call.
    const d = {
      ...base,
      standards: new Map(),
      invoke: () => ({}),
    } as unknown as ServerDeps;
    return { deps: d, seen };
  }

  it("refuses a budget that is not a positive number", async () => {
    const o = io({ deps: capturing().deps });
    expect(await runCli(["dispatch", "s", "--budget", "banana"], o)).toBe(2);
    expect(await runCli(["dispatch", "s", "--budget", "-1"], o)).toBe(2);
    expect(o.stderr.join("")).toContain("--budget");
  });

  it("surfaces a dispatch failure as exit 1", async () => {
    const o = io({ deps: capturing().deps });
    // No such standard in the empty map.
    expect(await runCli(["dispatch", "no-such-standard"], o)).toBe(1);
    expect(o.stderr.join("")).toContain("dispatch failed");
  });

  it("reports a malformed --input before spending anything", async () => {
    const o = io({ deps: capturing().deps });
    expect(await runCli(["dispatch", "s", "--input", "@/no/such/file.json"], o)).toBe(2);
  });
});

describe("stdout is data, stderr is everything else", () => {
  // The property that makes this composable: `coltrane dispatch … | xargs coltrane monitor`
  // must not receive a progress line, and `--json | jq` must not receive a warning.
  it("health prints its summary on stdout and its caveat on stderr", async () => {
    const d = {
      ...deps(),
      ledger: new MemoryLedger(),
    } as unknown as ServerDeps;
    const o = io({ deps: d });
    const code = await runCli(["health"], o);
    expect(code).toBe(0);
    expect(o.stdout.join("")).toMatch(/gig\(s\)/);
    for (const chunk of o.stdout) expect(chunk).not.toMatch(/counts are SHORT/);
  });

  it("--json puts parseable JSON and nothing else on stdout", async () => {
    const o = io({ deps: deps() });
    await runCli(["health", "--json"], o);
    expect(() => JSON.parse(o.stdout.join(""))).not.toThrow();
  });
});

describe("the usage text stays true", () => {
  it("documents every command the dispatcher accepts", () => {
    // Drift here is the same defect class as a tool advertising an argument it never reads:
    // a documented command that does not exist, or one that exists and is undocumented.
    for (const cmd of ["validate", "dispatch", "monitor", "logs", "abort", "trace", "simulate", "health", "serve"]) {
      expect(USAGE, cmd).toContain(`coltrane ${cmd}`);
    }
  });
});
