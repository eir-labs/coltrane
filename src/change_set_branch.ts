// SEAM — the change-set branch subsystem, authored as explicitly-stubbed THROWING signatures.
//
// This file exists so the RED spec COMPILES (`tsc` / `npm run build` green) while every
// assertion in tests/change_set/** reds because the ENFORCEMENT is absent — never because a
// symbol is missing or a type does not line up. It is the same discipline
// src/institution_enforcement.ts uses on branch spec/coltrane-enforces-its-laws and
// src/venue_realize.ts uses on the venue-realization branches: real signatures, real return
// types, bodies that throw. No behaviour is implemented here. The implementation pipeline
// (software-change-pr-v1, running off the change-set branch) is what turns these red tests green.
//
// The subsystem: a change set is one identity that outlives every commit and spans TWO gigs —
// the spec-drafting gig that opens the RED spec, and the DIFFERENT implementation gig that turns
// it green. It can therefore be keyed only by the ORIGINATING (spec) gig. Prior art:
//   - Gerrit Change-Id — a stable id above the commit, associating many patch sets with one
//     logical change; its per-target-branch scoping is exactly why a 1:1 branch↔gig assumption
//     breaks (git-review Documentation/user-changeid.html).
//   - Graphite stacked diffs — a PR whose base is another branch (not main) is a normal,
//     mergeable workflow, so the RED spec PR and the GREEN implementation PR can both target the
//     change-set branch and main never sees red.
//   - git-check-ref-format(1) — a UUID and a hyphen/underscore slug are both legal ref
//     components, so `changeset/<uuid>[/<slug>]` is a well-formed ref.

const STUB = "change_set_branch: enforcement not implemented (RED spec seam)";

/** The institution's protected main line — the branch Law C gates, and a change-set branch is NOT. */
export const PROTECTED_MAIN_LINE = "main";

/** The namespace prefix that marks a change-set branch. */
export const CHANGE_SET_BRANCH_PREFIX = "changeset/";

/** The standard the trigger dispatches when a RED spec PR is merged into the change-set branch. */
export const IMPLEMENTATION_STANDARD = "software-change-pr-v1";

// ── Branch identity: derived from the ORIGINATING gig, round-trippable, injective ───────────────

/**
 * Derive the change-set branch name from the ORIGINATING (spec) gig id — never the current gig id.
 * Format: `changeset/<full-originating-gig-uuid>[/<slug>]`. The full UUID is the SOLE key
 * (truncation would forfeit the collision-freedom the branch exists to guarantee); the slug is
 * decorative, rides alongside for humans, and is OUTSIDE the key.
 */
export function deriveChangeSetBranch(originatingGigId: string, slug?: string): string {
  void originatingGigId;
  void slug;
  throw new Error(STUB);
}

/** Parse the ORIGINATING gig id back out of a change-set branch name (the slug is ignored). */
export function parseOriginatingGig(branchName: string): string {
  void branchName;
  throw new Error(STUB);
}

/** Whether a name is a well-formed change-set branch (prefix + a parseable originating gig id). */
export function isChangeSetBranch(branchName: string): boolean {
  void branchName;
  throw new Error(STUB);
}

// ── Publish targets: both PRs target the change-set branch, never the protected main line ───────

/** The base branch the RED spec PR targets: the change-set branch derived from the originating gig. */
export function specPrBase(originatingGigId: string): string {
  void originatingGigId;
  throw new Error(STUB);
}

/** The base branch the GREEN implementation PR targets: the SAME change-set branch it branched from. */
export function implPrBase(changeSetBranch: string): string {
  void changeSetBranch;
  throw new Error(STUB);
}

// ── Idempotent create: a resumed gig re-publishing must not fork a second branch nor clobber ────

export type CreateOutcome =
  | { created: true; reused: false; branch: string }
  | { created: false; reused: true; branch: string };

/**
 * Create-if-absent / reuse-if-present. A resumed gig that re-publishes MUST reuse the existing
 * change-set branch, never fork a second one and never clobber/force-reset the first.
 */
export function ensureChangeSetBranch(
  branch: string,
  existingBranches: readonly string[],
): CreateOutcome {
  void branch;
  void existingBranches;
  throw new Error(STUB);
}

// ── Dead-branch preflight: a PR naming a base that does not exist is refused, sealed nothing ────

export type PublishGate =
  | { ok: true }
  | { ok: false; refusal: "dead-branch"; base: string };

/**
 * Pre-flight, at the same altitude as runtime.ts's missing-gig-input hard stop: a publish that
 * would seal a pull-request whose base branch does not exist on the remote is refused as a DEAD
 * NAME — nothing is sealed. Same defect class the engine already refuses for dead tool-grants.
 */
export function assertBasePublishable(
  base: string,
  remoteBranches: readonly string[],
): PublishGate {
  void base;
  void remoteBranches;
  throw new Error(STUB);
}

// ── Implementation branch: CARRIED in the change-request, never inferred from the working tree ──

export interface ChangeRequestBranchCarrier {
  /** The change-set branch the implementation run must work on. Additive optional field. */
  change_set_branch?: string;
}

export type BranchResolution =
  | { ok: true; branch: string }
  | { ok: false; refusal: "branch-absent-but-expected" };

/**
 * Resolve the branch the implementation run works on. It is CARRIED in the change-request; the
 * working-tree branch is NOT consulted (inference is how a run lands on the wrong branch
 * silently). Absent-but-expected is a hard stop, not a guess.
 */
export function resolveImplementationBranch(
  req: ChangeRequestBranchCarrier,
  workingTreeBranch: string,
): BranchResolution {
  void req;
  void workingTreeBranch;
  throw new Error(STUB);
}

// ── Trigger seam: RED-spec-merged → enqueue software-change-pr-v1, idempotent on the branch ─────

export interface RedSpecMergedEvent {
  /** The change-set branch the RED spec PR was merged into. The idempotency key. */
  change_set_branch: string;
  /** The originating (spec) gig id the branch is keyed by. */
  originating_gig_id: string;
  /** GitHub's X-GitHub-Delivery id — at-least-once delivery, so this only guards literal re-sends. */
  delivery_id: string;
}

export interface EnqueuedImplementation {
  standard: string;
  change_request: ChangeRequestBranchCarrier & Record<string, unknown>;
}

/**
 * The trigger consumer. Its ONLY job is at-most-once ENQUEUE keyed on the change-set branch: the
 * queue's atomic claim/lease already gives at-most-once RUN. Firing twice (a duplicate
 * X-GitHub-Delivery, or a different delivery of the same logical event) must enqueue nothing the
 * second time — the branch already carries an in-flight implementation gig.
 */
export class ChangeSetTrigger {
  /** Handle one 'RED spec PR merged into the change-set branch' event. */
  handle(event: RedSpecMergedEvent): void {
    void event;
    throw new Error(STUB);
  }

  /** The implementation gigs enqueued for a change-set branch — 0 or exactly 1. */
  enqueued(changeSetBranch: string): readonly EnqueuedImplementation[] {
    void changeSetBranch;
    throw new Error(STUB);
  }
}

// ── Lifecycle: {none, red, green, retired}; main never the target of a red merge; retire logged ─

export type ChangeSetState = "none" | "red" | "green" | "retired";

export type LifecycleCommand =
  | { kind: "create" }
  | { kind: "merge-red" } // the RED spec PR merged INTO the change-set branch
  | { kind: "merge-green" } // the GREEN implementation PR merged INTO the change-set branch
  | { kind: "promote-to-main" } // the final change-set→main PR merged by the governor on green CI
  | { kind: "retire"; by: string };

/** A merge the machine performed while applying a command — action + the branch it targeted. */
export interface MergeAttempt {
  action: "merge-red" | "merge-green" | "promote-to-main";
  target_branch: string;
}

export interface RetirementRecord {
  branch: string;
  by: string;
}

/**
 * The change-set branch as a state machine. The load-bearing invariants: a red merge (the spec or
 * the implementation PR) is NEVER performed against the protected main line (Law C composition),
 * the branch is retired at most once, and every retirement is RECORDED, never silent.
 */
export class ChangeSetBranchMachine {
  constructor(private readonly changeSetBranch: string) {
    void this.changeSetBranch;
  }

  state(): ChangeSetState {
    throw new Error(STUB);
  }

  /** Apply a command; return the merge attempts it performed (so a test can assert their targets). */
  apply(cmd: LifecycleCommand): readonly MergeAttempt[] {
    void cmd;
    throw new Error(STUB);
  }

  /** How many times this branch has been retired (must never exceed 1). */
  retiredCount(): number {
    throw new Error(STUB);
  }

  /** The recorded retirement events — length must equal retiredCount(); a silent retire is refused. */
  retirementLog(): readonly RetirementRecord[] {
    throw new Error(STUB);
  }
}
