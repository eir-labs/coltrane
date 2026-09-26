// A SEAT'S BASH RUNS IN A SANDBOX THAT CANNOT WRITE THE LAYOUT, THE GIT DIR, OR THE SEAT'S OWN SETTINGS.
//
// The founder's ruling ("sandbox + diff gate"). Layout grants scope Write and Edit by path; a Bash grant
// is a command prefix, and `Bash(sed:*)` can `sed -i` any file — including coltrane.layout.json. The CLI
// has an OS sandbox for Bash, configured through `--settings`. The conductor probed Claude Code 2.1.283
// on macOS (26 Sep) and these facts shape the laws:
//   · sandbox.enabled with no filesystem config leaves the whole cwd writable; allowWrite only ADDS;
//   · denyWrite beats allowWrite;
//   · RELATIVE paths passed through --settings were SILENTLY IGNORED — denies not enforced; ABSOLUTE
//     paths were enforced;
//   · absolute denies held against a hostile project .claude/settings.json only because project
//     settings were not loaded; array keys MERGE across setting scopes.
// So: every Bash seat spawns sandboxed, failing closed when no sandbox is available, with no escape
// hatch (no unsandboxed fallback, no excluded commands), with ABSOLUTE denies over the tree's layout
// file, .git and .claude, and with project/local settings never loaded.
//
// <tree> is where the seat runs: the room's workspace when the seat runs inside a room
// (ctx.seatExec.workspace — the `docker exec -w` directory), else ctx.tree_root (threaded by runGig
// from RunDeps.tree_root). The settings ride in the ONE `--settings` JSON the invoker already emits
// (tests pin exactly one), merged beside autoMemoryEnabled.
//
//   law                                                kind         drives                                   plant
//   D1 a Bash seat is sandboxed, fail-closed, no hatch  behavioural  makeClaudeInvoker(...)(ctx) argv via     omit `sandbox` from the --settings JSON (or set
//                                                                   the run seam — src/claude_invoker.ts     failIfUnavailable false / allowUnsandboxedCommands true)
//   D1 project/local settings never load                behavioural  same                                     --setting-sources user,project
//   D2 every sandbox path is ABSOLUTE                    behavioural  same                                     write "./coltrane.layout.json" (relative) into denyWrite
//   D2 denyWrite covers layout, .git, .claude            behavioural  same                                     drop <tree>/.git from denyWrite
//   D2 denyWrite covers .coltrane (round 7)               behavioural  same                                     drop <tree>/.coltrane from denyWrite
//   D5 a room seat gets the same sandbox, over the       behavioural  same, with ctx.seatExec (docker exec)    build the sandbox only on the host path (skip it
//      ROOM's workspace                                                                                        when seatExec is set) / deny the host tree_root
import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { settingsOf, LAYOUT_FILE, type Layout } from "./layout_grants_fixtures.js";

const TREE = "/srv/coltrane-tree/gig-1";
const LAYOUT: Layout = { paths: { source: ["src/**"] }, commands: { laws: ["npx vitest run"] } };

const seat = (allowed_tools: string[]) =>
  testAgent({ slug: "builder", primitives: ["CREATE"], input_types: [], output_types: ["built-thing"], domain: "demo", allowed_tools });

async function spawn(agent: Agent, over: Record<string, unknown> = {}): Promise<{ bin: string; args: string[]; error: string }> {
  let bin = "";
  let args: string[] = [];
  const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (b, a) => { bin = b; args = a; return "{}"; } });
  let error = "";
  try {
    await invoke({ agent, phase: "build", inputs: [], gig_input: { request_text: "x" }, layout: LAYOUT, tree_root: TREE, ...over } as unknown as AgentInvocationContext);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
  }
  return { bin, args, error };
}

type Sandbox = {
  enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown; excludedCommands?: unknown;
  filesystem?: Record<string, unknown>;
};
function sandboxOf(args: string[]): Sandbox | undefined {
  const all = settingsOf(args);
  expect(all.length, "the spawn must carry exactly ONE --settings (the sandbox merges into it)").toBe(1);
  return all[0]!["sandbox"] as Sandbox | undefined;
}
/** Every string anywhere under the sandbox's filesystem config. */
const fsPaths = (sb: Sandbox): string[] =>
  Object.values(sb.filesystem ?? {}).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []));

const BASH_SEATS: Array<[string, string[]]> = [
  ["an expanded Bash role (Bash(@laws))", ["Read", "Bash(@laws)"]],
  ["a literal Bash prefix (Bash(git diff:*))", ["Read", "Bash(git diff:*)"]],
];

describe("D1 — a Bash seat spawns sandboxed, fail-closed, with no escape hatch", () => {
  for (const [what, grants] of BASH_SEATS) {
    it(`${what}: sandbox.enabled, failIfUnavailable, allowUnsandboxedCommands false, no excluded commands`, async () => {
      const { args, error } = await spawn(seat(grants));
      expect(args.length, `the invoker never reached the spawn: ${error}`).toBeGreaterThan(0);
      const sb = sandboxOf(args);
      expect(sb, "a seat holding Bash spawned with no sandbox").toBeDefined();
      expect(sb!.enabled, "sandbox not enabled").toBe(true);
      expect(sb!.failIfUnavailable, "a host without a sandbox would run the seat's Bash unsandboxed").toBe(true);
      expect(sb!.allowUnsandboxedCommands, "the seat may retry a command outside the sandbox").toBe(false);
      const excluded = sb!.excludedCommands;
      expect(excluded === undefined || (Array.isArray(excluded) && excluded.length === 0), `commands excluded from the sandbox: ${JSON.stringify(excluded)}`).toBe(true);
    });
  }

  it("--setting-sources loads neither project nor local settings (a repo's .claude/settings.json cannot merge in allowWrite or excludedCommands)", async () => {
    const { args } = await spawn(seat(["Read", "Bash(@laws)"]));
    const i = args.indexOf("--setting-sources");
    expect(i, "no --setting-sources: every scope loads by default").toBeGreaterThanOrEqual(0);
    const sources = args[i + 1]!.split(",").map((x) => x.trim());
    expect(sources, "project settings load into a seat").not.toContain("project");
    expect(sources, "local settings load into a seat").not.toContain("local");
    // Non-vacuity for the whole describe: the sandbox must be there too, or the setting-sources half is
    // guarding a sandbox that does not exist.
    expect(sandboxOf(args)?.enabled).toBe(true);
  });
});

describe("D2 — the sandbox denies the layout, .git and .claude by ABSOLUTE path", () => {
  it("denyWrite holds <tree>/coltrane.layout.json, <tree>/.git and <tree>/.claude", async () => {
    const { args } = await spawn(seat(["Read", "Bash(@laws)"]));
    const deny = (sandboxOf(args)?.filesystem?.["denyWrite"] ?? []) as string[];
    expect(deny, "the sandbox lets Bash rewrite the layout that grants the seat").toContain(`${TREE}/${LAYOUT_FILE}`);
    expect(deny, "the sandbox lets Bash rewrite .git (hooks, config, refs)").toContain(`${TREE}/.git`);
    expect(deny, "the sandbox lets Bash rewrite the tree's .claude settings").toContain(`${TREE}/.claude`);
  });

  it("denyWrite holds <tree>/.coltrane — the engine's own ledger, locks and checkpoints (round 7: a surviving plant)", async () => {
    const { args } = await spawn(seat(["Read", "Bash(@laws)"]));
    const deny = (sandboxOf(args)?.filesystem?.["denyWrite"] ?? []) as string[];
    expect(deny, "non-vacuity: the sandbox denies the layout file").toContain(`${TREE}/${LAYOUT_FILE}`);
    expect(deny, "the sandbox lets Bash rewrite the engine's .coltrane state, which the diff gate exempts by design").toContain(`${TREE}/.coltrane`);
  });

  it("every path anywhere in the sandbox's filesystem config is absolute — a relative one is silently ignored by the CLI", async () => {
    const { args } = await spawn(seat(["Read", "Bash(@laws)"]));
    const sb = sandboxOf(args);
    const paths = fsPaths(sb ?? {});
    expect(paths.length, "non-vacuity: the sandbox names paths").toBeGreaterThan(0);
    const relative = paths.filter((p) => !isAbsolute(p));
    expect(relative, `relative sandbox paths are not enforced (measured): ${JSON.stringify(relative)}`).toEqual([]);
  });
});

describe("D5 — a seat inside a room gets the same sandbox, over the ROOM's workspace", () => {
  const ROOM_WS = "/workspace/g-room-1";
  it("docker exec … claude carries the sandbox, and its denies name the room's workspace — not the host tree", async () => {
    const { bin, args, error } = await spawn(seat(["Read", "Bash(@laws)"]), { seatExec: { container: "room-1", workspace: ROOM_WS } });
    expect(bin, `the seat did not run inside the room: ${error}`).toBe("docker");
    expect(args.slice(0, 5), "non-vacuity: the docker exec wrap").toEqual(["exec", "-i", "-w", ROOM_WS, "room-1"]);
    const sb = sandboxOf(args);
    expect(sb?.enabled, "a room seat's Bash ran unsandboxed").toBe(true);
    expect(sb?.failIfUnavailable, "a room without a sandbox would run the seat unsandboxed").toBe(true);
    expect(sb?.allowUnsandboxedCommands).toBe(false);
    const deny = (sb?.filesystem?.["denyWrite"] ?? []) as string[];
    expect(deny, "the room seat's sandbox does not deny the ROOM's layout file").toContain(`${ROOM_WS}/${LAYOUT_FILE}`);
    expect(deny).toContain(`${ROOM_WS}/.git`);
    expect(deny.some((p) => p.startsWith(TREE)), "the room seat's denies name the HOST tree, which does not exist in the container").toBe(false);
  });
});
