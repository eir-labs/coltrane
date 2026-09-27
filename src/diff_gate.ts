// diff_gate.ts — THE POST-SEAT DIFF GATE: what a seat DID, judged against what it was granted.
//
// The Bash sandbox (claude_invoker.ts bashSandboxFor) bounds what a seat's Bash CAN touch: nothing
// outside the tree, never the layout file, .git or .claude. It cannot bound what Bash does INSIDE the
// tree — `Bash(npx vitest run:*)` can still write any file there. So after a seat returns, runGig
// compares the tree with its state before the seat ran. Every path that changed (modified, added,
// untracked, deleted, both sides of a rename) must lie inside the seat's resolved Write/Edit scope
// (layout_grants.ts writeScopeOf / inWriteScope). A path that does not refuses the chair, naming it,
// and nothing that chair made is sealed.
//
// THE SNAPSHOT, NEVER THE STATUS LINE — and this is the whole of it. A seat that holds a git role has
// `.git` opened to its Bash, and every way git answers "what changed" is then a thing the SEAT writes:
//   · the index — `update-index --skip-worktree|--assume-unchanged <path>` makes git stop reporting a
//     tracked file it edits;
//   · `.git/info/exclude` (and core.excludesFile) — a rule appended there makes a planted file untracked
//     AND unlisted;
//   · HEAD — a seat holding `git_commit` commits its out-of-scope edit, and the status is then clean
//     against the HEAD the seat itself left behind.
// So the gate does not ask git what changed. It holds a BASELINE THE SEAT CANNOT WRITE, taken before the
// seat is let in, and compares real file content against it:
//   · the pre-seat CONTENT of every file in the tree — HEAD's tree (read from the object store before the
//     seat runs, so no later commit or reset can restate it) plus a full walk of the worktree;
//   · the pre-seat IGNORE RULES — the `.gitignore` files that were in the tree before the seat ran,
//     compiled once and frozen. Never `.git/info/exclude`, never core.excludesFile: those live in the
//     room's own `.git` and a seat writes them. A `.gitignore` the seat plants is not a rule the gate
//     reads — it is a file the gate judges.
// The after-state is read by WALKING THE WORKTREE with those frozen facts. Nothing in the after-read
// consults git, so nothing the seat can write steers it.
//
// THE ROOT `.git` ITSELF IS NOT JUDGED (a git role legitimately stages and commits, which rewrites the
// index and moves HEAD) but it MUST BE THERE AND READABLE, in the same shape the baseline found it: a
// seat that leaves it unreadable — or deletes it, or replaces it with a plain file — leaves a tree the
// gate cannot vouch for, and the gate fails closed rather than walk on. Only the ROOT `.git` is git's:
// a directory NAMED `.git` at any other depth is an ordinary path and is walked and judged, exactly as
// the engine's own state dir is exempt at the root and nowhere else.
//
// KNOWN LIMIT, unchanged: a path an already-present `.gitignore` covers is not walked, so a write into
// an ignored path is not seen by this gate. The sandbox still confines it to the tree, and it never
// leaves the tree through the engine: stampChangeAddresses (runtime.ts) refuses a change-set naming an
// ignored path. What is NO LONGER a limit is hiding a path by making it ignored DURING THE RUN: the
// baseline — and with it the compiled ignore rules — is frozen ONCE PER RUN (runtime.ts diffGateRead),
// before the run's first gated seat, so neither this seat nor any earlier chair on the shared tree can
// plant a `.gitignore` that the gate will then read. A `.gitignore` a seat writes is a file the gate
// judges, never a rule the gate honours.
//
// A PATH THAT VANISHES MID-WALK IS SKIPPED; A PATH THE WALK IS DENIED REFUSES. `readdirSync` returns a
// snapshot of a directory, and concurrent chairs (below) legitimately create and unlink temp files
// inside their own scopes, so between that snapshot and the stat of any one name the name can be gone.
// ENOENT/ENOTDIR therefore skips: the path is absent from BOTH reads, so it cancels in changedPaths. A
// PERMISSION failure (EACCES/EPERM) is the opposite case and must never take the same door — a blanket
// `catch { continue; }` would turn `chmod 000 <dir>` into an invisible escape, because directories are
// not recorded in the state map and the whole subtree would silently drop out of the walk. The gate's
// whole contract is that it cannot be blinded, so a path it was denied the right to look at throws.
//
// CONCURRENT CHAIRS share one tree. A change inside the scope of another chair whose seat overlapped
// this one's window is not blamed on this chair — that chair's own gate judges it. A change inside NO
// overlapping chair's scope is refused.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { inWriteScope, type WriteScope } from "./layout_grants.js";

/** Runs `git <args>` in the seat's tree (on the host, or inside the room) and returns stdout. */
export type TreeGit = (args: readonly string[]) => Buffer;

/** path → an opaque state token ("<kind>:<mode>:<content hash>"). */
export type TreeState = Map<string, string>;

/** git's own state directory AT THE TREE ROOT. Never judged (a git role writes it), always required to
 *  be readable, and matched by FULL PATH — a `.git` deeper in the tree is not git's and is judged. */
const GIT_DIR = ".git";
/** The per-directory ignore file git reads from the WORKTREE. The only ignore source this gate honours. */
const IGNORE_FILE = ".gitignore";

/**
 * The facts about a git tree that the gate reads ONCE, before the seat runs, and then holds: everything
 * here is something the seat could rewrite while it works, so re-reading it after would be reading the
 * seat's own testimony about itself.
 */
export interface GitBaseline {
  /** Tree-relative directory ("" for the root) → the `.gitignore` that was there before the seat. */
  readonly rules: ReadonlyMap<string, Ignore>;
  /** Tree-relative paths HEAD's tree named before the seat. A tracked path is never skipped as ignored,
   *  even when the tree's own `.gitignore` covers it (a checked-in `dist/`). */
  readonly tracked: ReadonlySet<string>;
  /** What the ROOT `.git` was before the seat: a state directory, a gitfile, or nothing at all (a
   *  tree_root that is a SUBDIRECTORY of its repository has no `.git` of its own). Recorded because a
   *  probe that cannot tell "this tree never had one" from "the seat just deleted it" cannot fail
   *  closed on the second — and `rm -rf .git` would seal. */
  readonly git_dir: "dir" | "file" | "absent";
}

/** Reads the pre-seat baseline facts. Called on the BEFORE read only; a throw refuses the chair. */
export function readGitBaseline(root: string, git: TreeGit): GitBaseline {
  // ls-tree paths are relative to the REPOSITORY root; the seat's grants are relative to ITS tree, so
  // the listing is limited to the tree (`-- .`) and the tree's prefix inside the repository is stripped.
  const prefix = git(["rev-parse", "--show-prefix"]).toString("utf8").trim();
  const tracked = new Set<string>();
  let head = "";
  // An empty repository has no HEAD to read. That is an answer (nothing is tracked), not a failure.
  try { head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).toString("utf8").trim(); } catch { head = ""; }
  if (head !== "") {
    for (const p of git(["ls-tree", "-r", "-z", "--name-only", "--full-name", head, "--", "."]).toString("utf8").split("\0")) {
      if (p !== "") tracked.add(prefix !== "" && p.startsWith(prefix) ? p.slice(prefix.length) : p);
    }
  }
  const rules = new Map<string, Ignore>();
  collectIgnoreRules(root, "", rules, tracked);
  let git_dir: GitBaseline["git_dir"] = "absent";
  try { git_dir = lstatSync(join(root, GIT_DIR)).isDirectory() ? "dir" : "file"; } catch { git_dir = "absent"; }
  return { rules, tracked, git_dir };
}

/** Compiles every `.gitignore` already in the tree, walking exactly the subtree the gate will judge. */
function collectIgnoreRules(root: string, rel: string, rules: Map<string, Ignore>, tracked: ReadonlySet<string>): void {
  const here = compileIgnoreFile(root, rel);
  if (here !== undefined) rules.set(rel, here);
  const names = listDir(root, rel);
  if (names === undefined) return;
  for (const name of names) {
    const r = rel === "" ? name : `${rel}/${name}`;
    // The ROOT `.git` only — matched by full path, exactly as the engine's state dir is on the next
    // line. A `docs/.git/` is not git's and its `.gitignore` is compiled like any other.
    if (r === GIT_DIR) continue;
    if (r === ENGINE_STATE_DIR) continue;
    const st = statEntry(root, r);
    if (st === undefined || !st.isDirectory()) continue;
    if (isIgnoredBy(rules, r, true) && !hasTrackedUnder(tracked, r)) continue;
    collectIgnoreRules(root, r, rules, tracked);
  }
}

/** ENOENT/ENOTDIR — the path genuinely is not there any more. Everything else (EACCES, EPERM, EMFILE,
 *  EIO …) is the gate being stopped from looking, which is never a thing to skip past. */
function vanished(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Lists one directory of the walk. The ROOT is listed bare: a root the gate cannot list is a tree it
 * cannot vouch for, and that must refuse rather than return an empty state (which would read as "the
 * seat changed nothing"). Below the root, a directory that vanished between its parent's readdir and
 * this listing is a concurrent chair's temp directory — skipped; a directory the walk is DENIED throws.
 */
function listDir(root: string, rel: string): string[] | undefined {
  if (rel === "") return readdirSync(root);
  try { return readdirSync(join(root, rel)); } catch (e) { if (vanished(e)) return undefined; throw e; }
}

/** lstat of one listed name. Gone between the readdir and here → undefined (it is absent from both the
 *  before- and the after-read, so it cancels in changedPaths). Denied → throws. */
function statEntry(root: string, rel: string): Stats | undefined {
  try { return lstatSync(join(root, rel)); } catch (e) { if (vanished(e)) return undefined; throw e; }
}

function compileIgnoreFile(root: string, rel: string): Ignore | undefined {
  let text: string;
  try { text = readFileSync(join(root, rel === "" ? IGNORE_FILE : `${rel}/${IGNORE_FILE}`), "utf8"); } catch { return undefined; }
  // ignoreCase OFF: a case-folded rule would hide MORE paths from the gate, and this guard errs toward
  // seeing a file, never toward missing one.
  return ignore({ ignoreCase: false }).add(text);
}

/** Does any frozen rule, at or above this path's directory, cover it? */
function isIgnoredBy(rules: ReadonlyMap<string, Ignore>, rel: string, isDir: boolean): boolean {
  for (const [dir, ig] of rules) {
    if (dir !== "" && !rel.startsWith(`${dir}/`)) continue;
    const sub = dir === "" ? rel : rel.slice(dir.length + 1);
    if (sub === "") continue;
    if (ig.ignores(sub) || (isDir && ig.ignores(`${sub}/`))) return true;
  }
  return false;
}

function hasTrackedUnder(tracked: ReadonlySet<string>, dir: string): boolean {
  for (const p of tracked) if (p.startsWith(`${dir}/`)) return true;
  return false;
}

/**
 * The tree's state, read from the WORKTREE ITSELF against the frozen baseline. Called before each
 * gated seat and again after it, and the two are compared. The baseline is the RUN's — taken before
 * the run's FIRST gated seat, so it predates every chair on this shared tree, not just this one.
 */
export function snapshotWorktree(root: string, baseline: GitBaseline): TreeState {
  requireReadableGitDir(root, baseline);
  const state: TreeState = new Map();
  const walk = (rel: string, inIgnored: boolean): void => {
    const names = listDir(root, rel);
    if (names === undefined) return;
    for (const name of names) {
      const r = rel === "" ? name : `${rel}/${name}`;
      // git's own state AT THE ROOT: written by the very roles this gate exists to allow, so never
      // state to judge. Matched by full path, exactly as the engine's state dir is on the next line —
      // by BASENAME it would exempt `docs/.git/` too, and a seat would write there unseen.
      if (r === GIT_DIR) continue;
      // The engine's own state dir at the tree root — the engine writes it while the seat runs.
      if (r === ENGINE_STATE_DIR) continue;
      const st = statEntry(root, r);
      if (st === undefined) continue; // vanished between the readdir and here — absent from both reads
      const dir = st.isDirectory();
      const ig = inIgnored || isIgnoredBy(baseline.rules, r, dir);
      if (dir) {
        if (ig && !hasTrackedUnder(baseline.tracked, r)) continue;
        walk(r, ig);
      } else {
        if (ig && !baseline.tracked.has(r)) continue;
        const s = entryState(root, r, st);
        if (s !== undefined) state.set(r, s);
      }
    }
  };
  walk("", false);
  return state;
}

/**
 * The root `.git` is not judged, but a tree whose git state is gone, replaced or unreadable is not a
 * tree the gate can vouch for. What "gone" means is only knowable against the BASELINE: a tree_root
 * that is a subdirectory of its repository never had a `.git` of its own, and refusing that would
 * refuse every such run. So the probe demands exactly what the baseline found, and nothing more.
 */
function requireReadableGitDir(root: string, baseline: GitBaseline): void {
  if (baseline.git_dir === "absent") return; // nothing was there before the seat — nothing to probe
  const p = join(root, GIT_DIR);
  let st: Stats;
  try {
    st = lstatSync(p);
  } catch (e) {
    throw new Error(`.git is gone: the git state this tree's baseline was taken from cannot be read (${(e as Error).message})`);
  }
  const now = st.isDirectory() ? "dir" : "file";
  if (now !== baseline.git_dir) {
    throw new Error(`.git is no longer ${baseline.git_dir === "dir" ? "a git state directory" : "a gitfile"}: the git state this tree's baseline was taken from was replaced`);
  }
  if (st.isDirectory()) readdirSync(p);
  else readFileSync(p);
}

/** undefined when the entry went away between its lstat and its read — the same cancelling skip the
 *  walk makes. A file the gate is DENIED (no read permission on its bytes) still throws. */
function entryState(root: string, rel: string, st: Stats): string | undefined {
  try {
    if (st.isSymbolicLink()) return `l:${st.mode}:${readlinkSync(join(root, rel))}`;
    if (!st.isFile()) return `o:${st.mode}:${st.size}`;
    return `f:${st.mode}:${hashFile(join(root, rel))}`;
  } catch (e) {
    if (vanished(e)) return undefined;
    throw e;
  }
}

/** The bytes as they are on disk, read in chunks so a large file cannot be a memory bound on the gate. */
function hashFile(abs: string): string {
  const h = createHash("sha256");
  const fd = openSync(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * A tree that is NOT a git work tree (a genome directory, a scratch tree) has no `git status` to read,
 * so its state is read from the filesystem itself: every entry's size and change time (ctime moves on
 * any write, rename or chmod). Nothing is skipped — a skipped directory would be a place to write
 * unseen, so only a path that is genuinely GONE drops out (listDir / statEntry: never a permission
 * failure, which refuses). A symlink is recorded as itself and never followed.
 */
export function snapshotDirectory(root: string): TreeState {
  const state: TreeState = new Map();
  const walk = (rel: string): void => {
    const names = listDir(root, rel);
    if (names === undefined) return;
    for (const name of names) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = statEntry(root, r);
      if (st === undefined) continue;
      if (st.isDirectory()) {
        walk(r);
      } else {
        state.set(r, `${st.size}:${st.ctimeMs}:${st.mtimeMs}:${st.mode}`);
      }
    }
  };
  walk("");
  return state;
}

/**
 * The engine's OWN state directory at a tree's root (the gig ledger, repo locks, checkpoints, gig
 * logs). The engine writes it while seats run — including this chair's own spend row — so a change
 * there is not evidence of what the seat did, and is not judged. The seat cannot write it either way:
 * its Bash is denied it by the sandbox (bashSandboxFor), and every Write/Edit grant that could reach it
 * carries a `Write/Edit(.coltrane/**)` denial (layout_grants.ts, src/grant_scope.ts PROTECTED_PATHS).
 */
export const ENGINE_STATE_DIR = ".coltrane";

/** Every path whose state differs between the two snapshots, sorted — the engine's own state dir
 *  excluded. */
export function changedPaths(before: TreeState, after: TreeState): string[] {
  const out = new Set<string>();
  for (const [p, v] of after) if (before.get(p) !== v) out.add(p);
  for (const p of before.keys()) if (!after.has(p)) out.add(p);
  return [...out].filter((p) => p !== ENGINE_STATE_DIR && !p.startsWith(`${ENGINE_STATE_DIR}/`)).sort();
}

/** One seat's open window on a shared tree. */
export interface GateWindow {
  readonly scope: WriteScope;
  /** Scopes of the other seats whose windows overlapped this one. */
  readonly overlaps: Set<WriteScope>;
}

/** The windows open on one run's tree. One per runGig. */
export class DiffGateWindows {
  private readonly open = new Set<GateWindow>();
  enter(scope: WriteScope): GateWindow {
    const w: GateWindow = { scope, overlaps: new Set([...this.open].map((o) => o.scope)) };
    for (const o of this.open) o.overlaps.add(scope);
    this.open.add(w);
    return w;
  }
  leave(w: GateWindow): void {
    this.open.delete(w);
  }
}

/** The changed paths this seat had no authority to change: outside its own scope and outside every
 *  overlapping seat's scope. Protected paths (the layout, .claude, .git) are never covered. */
export function outOfScope(changed: readonly string[], w: GateWindow): string[] {
  return changed.filter((p) => !inWriteScope(p, w.scope) && ![...w.overlaps].some((o) => inWriteScope(p, o)));
}
