// A TREE THE GATE CANNOT VOUCH FOR REFUSES THE CHAIR — AND SAYS SO.
//
// ROUND 10 (#553, the non-author grade of bbc11ea). Two defects, both of the shape a rewrite loses.
//
// F2 — ONE SIDE OF A PAIR IS WRAPPED. The PRE-seat `gateRead()` (runtime.ts ~3690) is wrapped and
// raises a proper RuntimeError naming the chair: "the diff gate cannot read the tree it runs in … a
// seat whose changes cannot be judged is not run". Its POST-seat twin (runtime.ts ~3878) is BARE, so a
// read that fails after the seat escapes as whatever node threw:
//   phase "p" aborted — chair(s) failed: impl (impl: EACCES: permission denied, scandir '…/src/fixtures')
// The existing N1 laws assert only `sealed.length === 0`, and BOTH shapes satisfy that — a proper
// refusal and a raw error are indistinguishable to them. So the law below pins the SHAPE of the
// refusal, not only its effect: a green check that cannot tell a refusal from a crash is not coverage.
//
// THE `.git` PROBE RETURNS SILENTLY. `requireReadableGitDir` opens with
//   try { st = lstatSync(p); } catch { return; }   // "no .git at this root — nothing to probe"
// and that `return` cannot tell "this tree never had a `.git`" from "the seat just deleted it". So a
// seat that does `rm -rf .git` — or replaces `.git` with a plain file — leaves a tree whose whole git
// state is gone, the probe returns clean, the walk proceeds, and THE CHAIR SEALS. The old `git status`
// design REFUSED both: `git status` on such a tree exits non-zero. This is a REGRESSION, and the file's
// own stated invariant ("it MUST BE READABLE … the gate fails closed rather than walk on") does not hold.
//
//   law                                                           kind         drives                          plant
//   a post-seat read that fails raises the SAME RuntimeError      behavioural  runGig — src/runtime.ts:3878    (RED at bbc11ea) the bare
//     the pre-seat twin raises, naming the chair                                                                post-seat gateRead()
//   control: the PRE-seat twin already names it that way          behavioural  runGig — src/runtime.ts:3690    the wrapper the twin lacks
//   a seat that removes .git is refused; nothing is sealed        behavioural  requireReadableGitDir —        (RED at bbc11ea) the probe's
//   a seat that replaces .git with a plain file is refused                     src/diff_gate.ts                silent `catch { return }`
//   control: a tree that never had a .git still seals in scope    behavioural  same                            refuse every non-git tree
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { type Layout } from "./layout_grants_fixtures.js";

const LAYOUT = {
  paths: { source: ["src/**"] },
  commands: { build: ["npm run build"] },
  git: { stage: ["git add", "git mv", "git rm"], commit: ["git commit"] },
} as unknown as Layout;
const seat = (): Agent => testAgent({ slug: "impl", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", "Write(@source)", "Edit(@source)", "Bash(@git_stage)", "Bash(@git_commit)", "Bash(@build)"] });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (t: string, ...a: string[]) => execFileSync("git", ["-C", t, ...a], { env: ENV, encoding: "utf8" });
function tree(asGit: boolean): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "gate-vouch-")));
  mkdirSync(join(t, "src")); mkdirSync(join(t, "src", "fixtures"));
  writeFileSync(join(t, "src", "a.ts"), "a\n");
  writeFileSync(join(t, "src", "fixtures", "f.json"), "{}\n");
  if (asGit) {
    execFileSync("git", ["init", "-q", "-b", "main", t]);
    git(t, "add", "-A"); git(t, "commit", "-qm", "seed");
    git(t, "config", "user.name", "seat"); git(t, "config", "user.email", "seat@coltrane");
  }
  return t;
}

async function run(t: string, act: (t: string) => void | Promise<void>) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  let invoked = 0;
  const invoke: AgentInvoker = async () => { invoked += 1; await act(t); return { ...coreInvariantFields("Signal"), value: "done" }; };
  const standard = { slug: "s", domain: "demo", agents: [seat()], phases: [{ name: "p", chairs: [{ role: "impl", agent_slug: "impl", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] } as unknown as Standard;
  let said = "";
  try { said = JSON.stringify(await runGig(standard, { request_text: "x" }, { outputs, ledger: new MemoryLedger(), invoke, layout: LAYOUT, tree_root: t } as never)); }
  catch (e) { said = String((e as Error)?.message ?? e); }
  return { invoked, said, sealed: outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === "impl") };
}

/** Does chmod 000 actually blind a read here? It does not when the suite runs as root. */
function chmodBlinds(): boolean {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "gate-chmod-")));
  mkdirSync(join(t, "d")); chmodSync(join(t, "d"), 0o000);
  try { execFileSync("ls", [join(t, "d")], { stdio: "ignore" }); return false; } catch { return true; }
  finally { chmodSync(join(t, "d"), 0o755); }
}
const CHMOD_BLINDS = chmodBlinds();

describe("F2 — a post-seat read that fails refuses the chair in the SAME shape the pre-seat read does", () => {
  it("the post-seat read fails: the refusal names the chair and says the gate cannot read the tree — not a bare EACCES", async () => {
    expect(CHMOD_BLINDS, "premise: this law needs chmod 000 to blind a read (it does not, running as root)").toBe(true);
    const t = tree(true);
    const dir = join(t, "src", "fixtures");
    let r;
    try { r = await run(t, () => { chmodSync(dir, 0o000); }); } finally { chmodSync(dir, 0o755); }
    expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
    expect(r.sealed, "a tree the gate could not read still sealed").toHaveLength(0);
    expect(r.said, "the post-seat failure escaped raw instead of refusing the chair").toContain("the diff gate cannot read the tree it runs in");
    expect(r.said, "the refusal does not name the chair").toContain('chair "impl"');
  });

  it("control — the PRE-seat twin already refuses in exactly that shape", async () => {
    expect(CHMOD_BLINDS, "premise: this law needs chmod 000 to blind a read (it does not, running as root)").toBe(true);
    const t = tree(true);
    const dir = join(t, "src", "fixtures");
    chmodSync(dir, 0o000);
    let r;
    try { r = await run(t, () => { /* the gate never lets the seat in */ }); } finally { chmodSync(dir, 0o755); }
    expect(r.invoked, "the seat must not be run at all when the tree cannot be read first").toBe(0);
    expect(r.said).toContain("the diff gate cannot read the tree it runs in");
    expect(r.said).toContain('chair "impl"');
  });
});

describe("the gate's `.git` probe fails closed — a seat cannot seal by destroying the git state it is judged against", () => {
  it("a seat that removes .git entirely is refused, and nothing it made is sealed", async () => {
    const t = tree(true);
    const r = await run(t, (tt) => { writeFileSync(join(tt, "src", "a.ts"), "b\n"); rmSync(join(tt, ".git"), { recursive: true, force: true }); });
    expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
    expect(r.sealed, "the git state the baseline was taken from is GONE and the chair sealed anyway").toHaveLength(0);
    expect(r.said, "the refusal does not name .git").toContain(".git");
  });

  it("a seat that replaces .git with a plain file is refused, and nothing it made is sealed", async () => {
    const t = tree(true);
    const r = await run(t, (tt) => {
      writeFileSync(join(tt, "src", "a.ts"), "b\n");
      rmSync(join(tt, ".git"), { recursive: true, force: true });
      writeFileSync(join(tt, ".git"), "not a gitfile\n");
    });
    expect(r.invoked, "non-vacuity: the seat ran").toBe(1);
    expect(r.sealed, "`.git` is no longer a git state directory and the chair sealed anyway").toHaveLength(0);
    expect(r.said, "the refusal does not name .git").toContain(".git");
  });

  it("control — a tree that never had a `.git` is still judged and in-scope work still seals", async () => {
    const t = tree(false);
    const r = await run(t, (tt) => { writeFileSync(join(tt, "src", "a.ts"), "b\n"); });
    expect(r.sealed, `an in-scope edit in a non-git tree was refused: ${r.said.slice(0, 300)}`).toHaveLength(1);
  });
});
