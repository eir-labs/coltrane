// A SEAT REACHES GIT AND THE NETWORK ONLY AS ITS REPOSITORY DECLARES — AND THEN ITS REAL WORK SUCCEEDS.
//
// Blocking finding 3 of the non-author grade (#553). The Bash sandbox denies `<tree>/.git` and (by default)
// all network, so today's agents that run git cannot work: under the sandbox `git add` fails
// (`index.lock: Operation not permitted`) and a push or `gh` call is refused by the proxy (403).
//
// THE DESIGN (the conductor's call — least privilege, fail closed; nothing is opened by default):
//   the LAYOUT declares what the repository permits —
//     git:    { stage?: [prefixes], commit?: [prefixes], push?: [prefixes] }   e.g. stage: ["git add"]
//     commands.publish: [prefixes]                                              e.g. ["gh pr create"]
//     egress: { <role>: [hosts] }  — role ∈ the command roles and git_stage / git_commit / git_push
//   and an AGENT reaches them only through role tokens it holds —
//     Bash(@git_stage) / Bash(@git_commit) / Bash(@git_push) expand to Bash(<prefix>:*) for layout.git.<op>;
//     Bash(@publish) to layout.commands.publish;
//   and the seat's sandbox follows the resolved tokens —
//     holding any git token: `<tree>/.git` is NO LONGER denied wholesale; `<tree>/.git/hooks` and
//       `<tree>/.git/config` stay denied (a hook or a config line is code that runs later);
//     `sandbox.network = { allowedDomains: <the egress hosts of the roles the seat holds>, strictAllowlist: true }`
//       for every Bash seat — `[]` when it holds none (the CLI 2.1.283 schema: `sandbox.network.allowedDomains`,
//       `strictAllowlist` "deterministically denies hosts not in allowedDomains instead of prompting").
//
// THE AGENTS' REAL WORK, read from agents/*.json:
//   code-implementer   Bash(git add:*)   — stages its change
//   red-spec-drafter   Bash(git add:*)   — stages its laws
//   pr-publisher       git switch / add / commit / push, gh pr create
//   deploy-agent       WebFetch(https://api.vercel.com/*) ONLY (code_tool_access "none") — no Bash, so no
//                      sandbox at all; its fetch is an in-process CLI tool, which the CLI's own schema says
//                      the sandbox network setting does not gate. (The grade's "fly" is not in its grants.)
// The fixtures below are those agents with their git/gh literals rewritten to role tokens (the migrated
// form an amendment would give them); the SHIPPED agents are used as-is for the fail-closed laws.
//
// REAL PROCESSES: the sandbox the invoker builds is enforced by @anthropic-ai/sandbox-runtime (`srt`, the
// runtime the CLI embeds), found by COLTRANE_SRT or PATH, with an OS sandbox; otherwise those laws are
// SKIPPED and printed UNVERIFIED. The remote is a local smart-HTTP git server and the API a local HTTP
// endpoint, both on 127.0.0.1 standing in for github.com / api.github.com; commands clear NO_PROXY so
// loopback is reached THROUGH the sandbox proxy, as a real host is.
//
//   law                                                        kind         drives                                        plant
//   LayoutSchema admits git / egress / commands.publish         behavioural  LayoutSchema — src/genome_schema.ts           (red today: the sections do not exist)
//   …and refuses an egress key that is no role                  behavioural  same                                          admit any egress key
//   argv: a declared git seat's sandbox opens .git but not       behavioural  makeClaudeInvoker(...) — src/claude_         keep `<tree>/.git` denied / drop the hooks deny
//   hooks/config; network strictAllowlist with held hosts only               invoker.ts (bashSandboxFor)
//   argv: an undeclared (shipped) seat keeps .git denied and     behavioural  same                                          open .git or the network by default
//   no network
//   argv: egress follows HELD tokens, not the layout             behavioural  same                                          allow every egress host the layout declares
//   REAL: code-implementer / red-spec-drafter stage (declared)   behavioural  the invoker's sandbox, enforced by srt        (red today)
//   REAL: pr-publisher switch/add/commit/push + publish fetch    behavioural  same                                          (red today)
//   REAL: undeclared — the shipped agents' git and network fail  behavioural  same                                          open .git or the network by default
//   REAL: a declared git seat still cannot write hooks or config behavioural  same                                          drop the .git/hooks or .git/config deny
//   deploy-agent's work is an in-process fetch, not sandboxed    behavioural  makeClaudeInvoker(...) argv                    sandbox a seat that holds no Bash
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { defineAgent } from "../src/composition.js";
import { layoutSchema, settingsOf, type Layout } from "./layout_grants_fixtures.js";
import { startGitHttpRemote, startApiStandIn, runAsync } from "./support/git_http_remote.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const shipped = (slug: string): Agent => defineAgent(JSON.parse(readFileSync(join(ROOT, "agents", `${slug}.json`), "utf8")));
const MIGRATE: Record<string, string> = {
  "Bash(git add:*)": "Bash(@git_stage)", "Bash(git commit:*)": "Bash(@git_commit)",
  "Bash(git push:*)": "Bash(@git_push)", "Bash(gh pr create:*)": "Bash(@publish)",
};
function migrated(slug: string): Agent {
  const a = shipped(slug);
  const tools = (a.allowed_tools ?? []).map((g) => MIGRATE[g] ?? g);
  expect(tools.some((g) => g.includes("(@")), `fixture: ${slug} holds none of the git/gh literals this law migrates — re-read agents/${slug}.json`).toBe(true);
  return { ...a, allowed_tools: tools } as Agent;
}

const DECLARED = (host: string): Layout => ({
  paths: { source: ["src/**"], tests: ["tests/**"], docs: ["docs/**"] },
  commands: { laws: ["npx vitest run"], publish: ["gh pr create"] },
  git: { stage: ["git add"], commit: ["git commit"], push: ["git push"] },
  egress: { git_push: [host], publish: [host] },
} as unknown as Layout);
const UNDECLARED: Layout = { paths: { source: ["src/**"], tests: ["tests/**"], docs: ["docs/**"] }, commands: { laws: ["npx vitest run"] } };

type Sandbox = { filesystem?: { allowWrite?: string[]; denyWrite?: string[] }; network?: { allowedDomains?: string[]; strictAllowlist?: boolean } };
async function spawnSandbox(agent: Agent, layout: Layout, tree: string): Promise<{ spawned: boolean; sandbox?: Sandbox | undefined; allowed: string[]; error: string }> {
  let args: string[] | undefined;
  const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
  let error = "";
  try { await invoke({ agent, phase: "p", inputs: [], gig_input: { request_text: "x" }, layout, tree_root: tree } as unknown as AgentInvocationContext); }
  catch (e) { error = String((e as Error)?.message ?? e); }
  if (!args) return { spawned: false, allowed: [], error };
  const i = args.indexOf("--allowedTools");
  return { spawned: true, sandbox: settingsOf(args)[0]?.["sandbox"] as Sandbox | undefined, allowed: i >= 0 ? args[i + 1]!.split(",") : [], error };
}

function gitTree(): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "seat-git-")));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main", t]);
  for (const d of ["src", "tests"]) mkdirSync(join(t, d));
  writeFileSync(join(t, "src", "a.ts"), "a\n");
  execFileSync("git", ["-C", t, "add", "-A"], { env });
  execFileSync("git", ["-C", t, "commit", "-qm", "seed"], { env });
  execFileSync("git", ["-C", t, "config", "user.name", "seat"]);
  execFileSync("git", ["-C", t, "config", "user.email", "seat@coltrane"]);
  return t;
}

describe("the layout declares what a repository permits", () => {
  it("LayoutSchema admits git, egress and commands.publish", () => {
    const r = layoutSchema().safeParse(DECLARED("github.com"));
    expect(r.success, `the git / egress / publish sections are refused: ${JSON.stringify((r as { error?: unknown }).error ?? "").slice(0, 300)}`).toBe(true);
  });
  it("…and refuses an egress key that names no role", () => {
    expect(layoutSchema().safeParse({ egress: { anything: ["github.com"] } }).success, "an egress entry for a role that grants nothing was admitted").toBe(false);
  });
});

describe("argv: the sandbox follows the tokens a seat holds (runs everywhere)", () => {
  const TREE = "/srv/coltrane-tree/g";
  it("a declared git seat (migrated code-implementer): .git is not denied wholesale, hooks and config are, and the network is a strict, empty allowlist", async () => {
    const r = await spawnSandbox(migrated("code-implementer"), DECLARED("github.com"), TREE);
    expect(r.spawned, r.error).toBe(true);
    const deny = r.sandbox?.filesystem?.denyWrite ?? [];
    expect(deny, "a seat that may stage still has .git denied wholesale — `git add` cannot write the index").not.toContain(`${TREE}/.git`);
    expect(deny, "opening .git opened its hooks").toContain(`${TREE}/.git/hooks`);
    expect(deny, "opening .git opened its config").toContain(`${TREE}/.git/config`);
    expect(r.sandbox?.network?.strictAllowlist, "the network allowlist is not strict").toBe(true);
    expect(r.sandbox?.network?.allowedDomains ?? null, "a seat holding no egress role was given hosts").toEqual([]);
  });

  it("a declared publishing seat (migrated pr-publisher) is allowed exactly the hosts of the roles it holds", async () => {
    const r = await spawnSandbox(migrated("pr-publisher"), DECLARED("github.com"), TREE);
    expect(r.spawned, r.error).toBe(true);
    expect(r.sandbox?.network?.allowedDomains, "the publisher's declared egress did not reach its sandbox").toEqual(["github.com"]);
    expect(r.sandbox?.network?.strictAllowlist).toBe(true);
  });

  it("egress follows HELD tokens: a seat holding only Bash(@laws) gets none of the layout's hosts", async () => {
    const a = { ...shipped("red-spec-drafter"), allowed_tools: ["Read", "Bash(@laws)"] } as Agent;
    const r = await spawnSandbox(a, DECLARED("github.com"), TREE);
    expect(r.spawned, r.error).toBe(true);
    expect(r.sandbox?.network?.allowedDomains ?? [], "the layout's egress reached a seat that holds no role for it").toEqual([]);
    expect(r.sandbox?.filesystem?.denyWrite ?? [], "a seat holding no git token had .git opened").toContain(`${TREE}/.git`);
  });

  it("an undeclared seat (the SHIPPED code-implementer, literal Bash(git add:*)) keeps .git denied and has no network — fail closed", async () => {
    const r = await spawnSandbox(shipped("code-implementer"), UNDECLARED, TREE);
    expect(r.spawned, r.error).toBe(true);
    expect(r.sandbox?.filesystem?.denyWrite ?? [], "a literal git grant opened .git").toContain(`${TREE}/.git`);
    expect(r.sandbox?.network?.allowedDomains ?? [], "an undeclared seat was given network").toEqual([]);
  });

  it("a migrated agent under a layout that declares no git is refused before the spawn, naming the role", async () => {
    const r = await spawnSandbox(migrated("pr-publisher"), UNDECLARED, TREE);
    expect(r.spawned, "a seat holding git role tokens its repository never declared was spawned").toBe(false);
    expect(r.error).toMatch(/git_(stage|commit|push)|publish/);
  });

  it("deploy-agent: its real work is an in-process WebFetch — it holds no Bash, so no sandbox is built and its grant reaches the spawn", async () => {
    const r = await spawnSandbox(shipped("deploy-agent"), UNDECLARED, TREE);
    expect(r.spawned, r.error).toBe(true);
    expect(r.allowed, "deploy-agent's only grant did not reach the spawn").toContain("WebFetch(https://api.vercel.com/*)");
    expect(r.sandbox, "a seat that cannot run Bash was given a Bash sandbox").toBeUndefined();
  });
});

// ── real processes under the runtime the CLI embeds ─────────────────────────────────────────────
function onPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  return undefined;
}
const SRT = process.env["COLTRANE_SRT"] || onPath("srt");
const OS_SANDBOX = process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : process.platform === "linux" ? onPath("bwrap") !== undefined : false;
const UNAVAILABLE = !SRT ? "no srt (sandbox-runtime) on PATH and COLTRANE_SRT unset" : !OS_SANDBOX ? `no OS sandbox on ${process.platform}` : "";
if (UNAVAILABLE) console.warn(`[UNVERIFIED] a_seat_reaches_git_and_the_network_only_as_declared (real processes): SKIPPED — ${UNAVAILABLE}`);

/** Run `cmd` in `tree` under srt, configured from the sandbox the invoker put on the seat's argv. */
async function underSandbox(sb: Sandbox | undefined, tree: string, cmd: string): Promise<{ status: number | null; out: string }> {
  const cfg = join(mkdtempSync(join(tmpdir(), "srt-cfg-")), "srt.json");
  writeFileSync(cfg, JSON.stringify({
    network: { allowedDomains: sb?.network?.allowedDomains ?? [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: sb?.filesystem?.allowWrite ?? [], denyWrite: sb?.filesystem?.denyWrite ?? [] },
  }));
  return runAsync(SRT!, ["--settings", cfg, "--", "sh", "-c", cmd], { cwd: tree, timeoutMs: 90_000 });
}

describe("REAL: each agent's own git and network work, inside the sandbox (skipped as UNVERIFIED without srt + an OS sandbox)", () => {
  for (const [slug, file] of [["code-implementer", "src/a.ts"], ["red-spec-drafter", "tests/x.test.ts"]] as const) {
    it.skipIf(Boolean(UNAVAILABLE))(`${slug} (declared): \`git add ${file}\` succeeds and the file is staged`, async () => {
      const t = gitTree();
      writeFileSync(join(t, file), "changed\n");
      const r = await spawnSandbox(migrated(slug), DECLARED("127.0.0.1"), t);
      expect(r.spawned, r.error).toBe(true);
      const run = await underSandbox(r.sandbox, t, `git add ${file}`);
      expect(run.status, `git add failed inside the declared sandbox: ${run.out}`).toBe(0);
      expect(execFileSync("git", ["-C", t, "diff", "--cached", "--name-only"], { encoding: "utf8" })).toContain(file);
    }, 120_000);

    it.skipIf(Boolean(UNAVAILABLE))(`${slug} (SHIPPED, undeclared): \`git add ${file}\` fails closed — .git stays denied`, async () => {
      const t = gitTree();
      writeFileSync(join(t, file), "changed\n");
      const r = await spawnSandbox(shipped(slug), UNDECLARED, t);
      expect(r.spawned, r.error).toBe(true);
      const run = await underSandbox(r.sandbox, t, `git add ${file}`);
      expect(run.status, "an undeclared seat staged a change — .git was open by default").not.toBe(0);
      expect(execFileSync("git", ["-C", t, "diff", "--cached", "--name-only"], { encoding: "utf8" })).not.toContain(file);
    }, 120_000);
  }

  it.skipIf(Boolean(UNAVAILABLE))("pr-publisher (declared): switch, add, commit and push to the remote, and the publish call reaches the API stand-in", async () => {
    const remote = await startGitHttpRemote();
    const api = await startApiStandIn();
    try {
      const t = gitTree();
      execFileSync("git", ["-C", t, "remote", "add", "origin", remote.url]);
      writeFileSync(join(t, "src", "a.ts"), "published\n");
      const r = await spawnSandbox(migrated("pr-publisher"), DECLARED("127.0.0.1"), t);
      expect(r.spawned, r.error).toBe(true);
      const run = await underSandbox(r.sandbox, t,
        `git switch -q -c change && git add src/a.ts && git commit -qm change && NO_PROXY= no_proxy= git push -q origin change && NO_PROXY= no_proxy= curl -sf ${api.url} >/dev/null`);
      expect(run.status, `the publisher's real work failed inside its declared sandbox: ${run.out}`).toBe(0);
      expect(execFileSync("git", ["-C", remote.bare, "rev-parse", "--verify", "refs/heads/change"], { encoding: "utf8" }).trim()).toMatch(/^[0-9a-f]{40}$/);
      expect(api.hits(), "the publish call never reached the API stand-in").toBe(1);
    } finally { await remote.close(); await api.close(); }
  }, 180_000);

  it.skipIf(Boolean(UNAVAILABLE))("pr-publisher (SHIPPED, undeclared): the push and the publish call both fail closed — no host is reachable by default", async () => {
    const remote = await startGitHttpRemote();
    const api = await startApiStandIn();
    try {
      const t = gitTree();
      execFileSync("git", ["-C", t, "remote", "add", "origin", remote.url]);
      const r = await spawnSandbox(shipped("pr-publisher"), UNDECLARED, t);
      expect(r.spawned, r.error).toBe(true);
      const push = await underSandbox(r.sandbox, t, "NO_PROXY= no_proxy= git push -q origin HEAD:refs/heads/leak");
      const call = await underSandbox(r.sandbox, t, `NO_PROXY= no_proxy= curl -sf ${api.url}`);
      expect(push.status, "an undeclared seat pushed").not.toBe(0);
      expect(call.status, "an undeclared seat reached the API").not.toBe(0);
      expect(api.hits()).toBe(0);
    } finally { await remote.close(); await api.close(); }
  }, 180_000);

  it.skipIf(Boolean(UNAVAILABLE))("a declared git seat still cannot write .git/hooks or .git/config", async () => {
    const t = gitTree();
    const r = await spawnSandbox(migrated("pr-publisher"), DECLARED("127.0.0.1"), t);
    expect(r.spawned, r.error).toBe(true);
    const before = readFileSync(join(t, ".git", "config"), "utf8");
    await underSandbox(r.sandbox, t, "echo 'exit 0' > .git/hooks/pre-commit; git config core.hooksPath /tmp/evil");
    expect(existsSync(join(t, ".git", "hooks", "pre-commit")), "a declared git seat planted a hook").toBe(false);
    expect(readFileSync(join(t, ".git", "config"), "utf8"), "a declared git seat rewrote .git/config").toBe(before);
  }, 120_000);
});
