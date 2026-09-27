// A SIBLING CHAIR CHURNING TEMP FILES NEVER REFUSES THIS CHAIR.
//
// ROUND 10 BLOCKER (#553, the non-author grade of bbc11ea). `snapshotWorktree`'s `walk` does a bare
// `readdirSync` then a bare `lstatSync` on every name it listed. Its TWIN IN THE SAME FILE,
// `collectIgnoreRules`, has exactly the guard it lacks — `try { … } catch { continue; }` around the
// same lstat. `readdirSync` returns a SNAPSHOT of the directory; between that snapshot and the lstat of
// any one name, the name can be gone.
//
// Concurrent chairs on one shared tree are a law-pinned FEATURE here (GATE-CONCURRENT, DiffGateWindows,
// GateWindow.overlaps). So a sibling chair writing and unlinking a temp file INSIDE ITS OWN SCOPE makes
// this chair's post-seat walk throw a raw ENOENT for a file this chair never touched, and nothing this
// chair made is sealed. Reproduced by the grader on a 300-file tree with one background writer:
//   THREW after 4 walks: ENOENT: no such file or directory, lstat '…/src/tmp-1.tmp'
// Exposure grew three orders of magnitude with this commit: 1314 paths lstat'd twice per writing chair,
// against 1 under the old `git status` design.
//
// It presents as a FLAKE, which is why it needs a law and not only a fix — and a law for a flake must
// not itself be a race. So the vanishing is DRIVEN, not awaited: `lstatSync` is wrapped so that the
// sibling chair's `unlink` of one registered path lands at exactly the moment the walk asks about it.
// The ENOENT is the real filesystem's, from a real unlink; only its TIMING is made deterministic.
//
//   law                                                          kind         drives                        plant
//   a path that vanishes between readdir and lstat is SKIPPED    behavioural  snapshotWorktree —            (RED at bbc11ea) the bare
//     — the walk completes and the rest of the tree is read                   src/diff_gate.ts              lstatSync in `walk`
//   the same, for a non-git tree (snapshotDirectory's walk)      behavioural  snapshotDirectory — same      same, in the second walk
//   control: the TWIN already survives it (collectIgnoreRules)   behavioural  readGitBaseline — same        the guard the other two lack
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// THE SIBLING CHAIR'S UNLINK, driven into the one instant that matters. Registered paths are unlinked
// FOR REAL the first time `lstatSync` is asked about them — i.e. after the `readdirSync` that listed
// them and before the stat that reads them, which is exactly the window a concurrent chair occupies.
const sibling = vi.hoisted(() => ({ unlinkOnLstat: new Set<string>() }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((p: unknown, ...rest: unknown[]) => {
    const s = String(p);
    if (sibling.unlinkOnLstat.delete(s)) real.unlinkSync(s);
    return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.lstatSync;
  return { ...real, lstatSync, default: { ...(real as unknown as object), lstatSync } };
});

const { readGitBaseline, snapshotWorktree, snapshotDirectory } = await import("../src/diff_gate.js");
type Git = (args: readonly string[]) => Buffer;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function tree(asGit: boolean): string {
  const t = realpathSync(mkdtempSync(join(tmpdir(), "gate-sibling-")));
  mkdirSync(join(t, "src"));
  writeFileSync(join(t, "src", "a.ts"), "a\n");
  writeFileSync(join(t, "src", "b.ts"), "b\n");
  if (asGit) {
    execFileSync("git", ["init", "-q", "-b", "main", t]);
    execFileSync("git", ["-C", t, "add", "-A"], { env: ENV });
    execFileSync("git", ["-C", t, "commit", "-qm", "seed"], { env: ENV });
  }
  return t;
}
const gitIn = (t: string): Git => (args) => execFileSync("git", ["-C", t, ...args], { stdio: ["ignore", "pipe", "pipe"] });

describe("a sibling chair's temp file, unlinked mid-walk, does not refuse this chair", () => {
  it("snapshotWorktree: the vanished path is skipped and the rest of the tree is still read", () => {
    const t = tree(true);
    const baseline = readGitBaseline(t, gitIn(t));
    // the sibling chair, mid-window, writes its own temp file and is about to remove it
    const temp = join(t, "src", "tmp-1.tmp");
    writeFileSync(temp, "scratch\n");
    expect(snapshotWorktree(t, baseline).has("src/tmp-1.tmp"), "premise: the walk does reach the temp file").toBe(true);

    writeFileSync(temp, "scratch\n");
    sibling.unlinkOnLstat.add(temp);
    const after = snapshotWorktree(t, baseline);

    expect(sibling.unlinkOnLstat.size, "non-vacuity: the unlink was driven into the walk's lstat").toBe(0);
    expect(after.has("src/tmp-1.tmp"), "a path that no longer exists is not state").toBe(false);
    expect([...after.keys()].sort(), "the rest of the tree was read").toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("snapshotDirectory (a non-git tree): the same vanished path is skipped, not thrown on", () => {
    const t = tree(false);
    const temp = join(t, "src", "tmp-1.tmp");
    writeFileSync(temp, "scratch\n");
    expect(snapshotDirectory(t).has("src/tmp-1.tmp"), "premise: the walk does reach the temp file").toBe(true);

    writeFileSync(temp, "scratch\n");
    sibling.unlinkOnLstat.add(temp);
    const after = snapshotDirectory(t);

    expect(sibling.unlinkOnLstat.size, "non-vacuity: the unlink was driven into the walk's lstat").toBe(0);
    expect(after.has("src/tmp-1.tmp")).toBe(false);
    expect([...after.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("control — the twin in the same file (collectIgnoreRules) ALREADY survives it: that guard is the shape the other two lack", () => {
    const t = tree(true);
    mkdirSync(join(t, "src", "scratch"));
    const temp = join(t, "src", "scratch", "tmp-1.tmp");
    writeFileSync(temp, "scratch\n");
    sibling.unlinkOnLstat.add(temp);
    expect(() => readGitBaseline(t, gitIn(t)), "collectIgnoreRules guards the lstat its twin leaves bare").not.toThrow();
    expect(sibling.unlinkOnLstat.size, "non-vacuity: the unlink was driven into the twin's lstat").toBe(0);
  });
});
