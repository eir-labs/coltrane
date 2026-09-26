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
// THE STATE, not the status line. The snapshot is `git status --porcelain=v1 -z --untracked-files=all
// --no-renames` plus a content hash of every listed path that exists: a file that was ALREADY dirty
// before the seat and that the seat edited again keeps the same status letters, so comparing statuses
// alone would miss it. `--no-renames` reports a staged rename as its two sides (a deletion and an
// addition), so a move out of scope is judged by its SOURCE as well as its destination.
//
// KNOWN LIMIT: paths git ignores (.gitignore) are not in `git status`, so a write into an ignored path
// is not seen by this gate. The sandbox still confines it to the tree.
//
// CONCURRENT CHAIRS share one tree. A change inside the scope of another chair whose seat overlapped
// this one's window is not blamed on this chair — that chair's own gate judges it. A change inside NO
// overlapping chair's scope is refused.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inWriteScope, type WriteScope } from "./layout_grants.js";

/** Runs `git <args>` in the seat's tree (on the host, or inside the room) and returns stdout. */
export type TreeGit = (args: readonly string[]) => Buffer;

/** path → "<XY>:<content hash | -deleted->". */
export type TreeState = Map<string, string>;

export function snapshotTree(git: TreeGit): TreeState {
  // Porcelain paths are relative to the REPOSITORY root; the seat's grants are relative to ITS tree.
  // So the status is limited to the tree (`-- .`) and the tree's prefix inside the repository is
  // stripped, making every path tree-relative.
  const prefix = git(["rev-parse", "--show-prefix"]).toString("utf8").trim();
  const raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."]).toString("utf8");
  const entries: Array<{ xy: string; path: string }> = [];
  for (const rec of raw.split("\0")) {
    if (rec.length < 4) continue;
    const full = rec.slice(3);
    entries.push({ xy: rec.slice(0, 2), path: prefix && full.startsWith(prefix) ? full.slice(prefix.length) : full });
  }
  const existing = entries.filter((e) => e.xy[1] !== "D" && !(e.xy[0] === "D" && e.xy[1] === " "));
  const hashes = new Map<string, string>();
  if (existing.length > 0) {
    // One call for every existing listed path. `--no-filters` hashes the bytes as they are on disk.
    const out = git(["hash-object", "--no-filters", "--", ...existing.map((e) => e.path)]).toString("utf8").trim().split("\n");
    existing.forEach((e, i) => hashes.set(e.path, out[i] ?? ""));
  }
  const state: TreeState = new Map();
  for (const e of entries) state.set(e.path, `${e.xy}:${hashes.get(e.path) ?? "-deleted-"}`);
  return state;
}

/**
 * A tree that is NOT a git work tree (a genome directory, a scratch tree) has no `git status` to read,
 * so its state is read from the filesystem itself: every entry's size and change time (ctime moves on
 * any write, rename or chmod). Nothing is skipped — a skipped directory would be a place to write
 * unseen. A symlink is recorded as itself and never followed.
 */
export function snapshotDirectory(root: string): TreeState {
  const state: TreeState = new Map();
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, r));
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
 * there is not evidence of what the seat did, and is not judged. The seat's Bash is denied it by the
 * sandbox (bashSandboxFor); a Write/Edit grant that covers it is the one remaining way in.
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
