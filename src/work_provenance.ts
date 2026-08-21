/** WHOSE WORK IS THIS? — the question a run must answer before it claims a diff.
 *
 *  This repository's working tree is shared. More than one session operates in it, branches are cut
 *  and checked out underneath a run that did not cut them, and a `changeset/*` branch created by one
 *  session becomes the checkout another session reads as its own. The failure that follows is not a
 *  merge conflict — it is quieter than that. A run finishes, looks at `git diff`, sees changes, and
 *  reports them as what it did. The diff is real; the authorship is invented.
 *
 *  Measured on 2026-08-19: a run verified a 526-line diff, described it as the output of a named gig,
 *  and was wrong — the diff came from a different session in the same tree. Every test result quoted
 *  about it was true. Only the sentence naming who made it was false, and nothing in the toolchain
 *  could have contradicted that sentence.
 *
 *  So this is not a lint. It is the difference between "these tests pass" and "these tests pass ON MY
 *  WORK", and only the second one licenses a run to publish.
 *
 *  THE MECHANISM IS AN ANCHOR, NOT A HEURISTIC. Author names, timestamps and branch names are all
 *  guesses about provenance: two sessions share an author, clocks tell you when not who, and a branch
 *  name is only a label. The one fact a run can actually hold is what HEAD was when it started, and
 *  which commits it created after that. Everything else in the range is somebody else's.
 */

/** What a run knows about itself. `anchor` is HEAD's sha at the moment the run began — recorded, not
 *  inferred. `owned` is the shas the run created since, in any order. */
export interface RunAnchor {
  readonly anchor: string;
  readonly owned: readonly string[];
}

/** The state of the branch at the moment the question is asked. `range` is every commit between the
 *  merge-base with the publishing target and HEAD — the commits a PR would actually carry. */
export interface BranchState {
  readonly branch: string;
  /** The branch the run was on when it recorded its anchor. A different value means the checkout moved
   *  underneath the run, which is the loudest available signal that the tree is shared. */
  readonly branchAtAnchor: string;
  readonly range: readonly string[];
}

export type ProvenanceVerdict =
  /** Every commit the branch carries was created by this run. Safe to claim. */
  | { readonly status: "own-work"; readonly commits: number }
  /** The branch carries commits this run did not create. The diff is not this run's to describe. */
  | { readonly status: "foreign-commits"; readonly foreign: readonly string[]; readonly commits: number }
  /** The checkout moved under the run. Reported separately from foreign commits because it can happen
   *  even when the range looks clean, and it invalidates the anchor rather than merely dirtying it. */
  | { readonly status: "branch-moved"; readonly from: string; readonly to: string }
  /** No anchor was recorded, so the question cannot be answered. NOT a pass — see the note on
   *  `scanBoundary`'s `unavailable`: a check that did not run did not pass. */
  | { readonly status: "no-anchor"; readonly reason: string };

/** Shas are compared on their first 7 characters so an abbreviated sha from one source and a full one
 *  from another do not read as different commits. Comparison is case-insensitive; git emits lowercase,
 *  but a hand-written anchor should not fail on capitalisation. */
const key = (sha: string): string => sha.trim().toLowerCase().slice(0, 7);

/** Answer the question. Pure: the caller supplies what git said, so the same logic serves a pre-push
 *  hook, a publishing seat, and a law, with nothing to drift between them.
 *
 *  ORDER OF CHECKS IS DELIBERATE. A moved branch is reported BEFORE foreign commits, because once the
 *  checkout has changed the anchor describes a different history and the commit comparison is no
 *  longer meaningful — reporting "3 foreign commits" there would invite someone to inspect three
 *  commits when the real answer is that the question was asked of the wrong branch. */
export function checkProvenance(anchor: RunAnchor | undefined, state: BranchState): ProvenanceVerdict {
  if (!anchor || !anchor.anchor.trim()) {
    return { status: "no-anchor", reason: "no anchor sha was recorded at the start of this run" };
  }
  if (state.branch !== state.branchAtAnchor) {
    return { status: "branch-moved", from: state.branchAtAnchor, to: state.branch };
  }
  const owned = new Set(anchor.owned.map(key));
  const foreign = state.range.filter((sha) => !owned.has(key(sha)));
  return foreign.length === 0
    ? { status: "own-work", commits: state.range.length }
    : { status: "foreign-commits", foreign, commits: state.range.length };
}

/** True only for the one verdict that licenses a run to publish a diff as its own. Written as a
 *  function rather than left to each caller, because `!== "foreign-commits"` is the mistake this
 *  module exists to prevent: `no-anchor` and `branch-moved` are also not-own-work. */
export function mayClaim(v: ProvenanceVerdict): boolean {
  return v.status === "own-work";
}

export function formatVerdict(v: ProvenanceVerdict): string {
  switch (v.status) {
    case "own-work":
      return `provenance clean — all ${v.commits} commit(s) in range were created by this run`;
    case "foreign-commits":
      return (
        `provenance REFUSED — ${v.foreign.length} of ${v.commits} commit(s) in range were not created ` +
        `by this run: ${v.foreign.map(key).join(", ")}`
      );
    case "branch-moved":
      return `provenance REFUSED — the checkout moved under this run: ${v.branchAtAnchor ?? v.from} → ${v.to}`;
    case "no-anchor":
      return `provenance UNKNOWN — ${v.reason}`;
  }
}
