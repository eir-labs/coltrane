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
  // The full gig id is the SOLE key segment; the slug, when present, rides in a SEPARATE ref
  // component after it, so parsing (which reads only the first segment after the prefix) ignores it.
  const key = `${CHANGE_SET_BRANCH_PREFIX}${originatingGigId}`;
  return slug ? `${key}/${slug}` : key;
}

/** Parse the ORIGINATING gig id back out of a change-set branch name (the slug is ignored). */
export function parseOriginatingGig(branchName: string): string {
  // Strip the namespace, then take the FIRST path component: that is the key. A trailing slug is a
  // later component and is dropped. A gig UUID carries no "/", so it survives the split whole.
  const rest = branchName.slice(CHANGE_SET_BRANCH_PREFIX.length);
  return rest.split("/")[0]!;
}

/** Whether a name is a well-formed change-set branch (prefix + a parseable originating gig id). */
export function isChangeSetBranch(branchName: string): boolean {
  if (!branchName.startsWith(CHANGE_SET_BRANCH_PREFIX)) return false;
  return parseOriginatingGig(branchName).length > 0;
}

// ── Publish targets: both PRs target the change-set branch, never the protected main line ───────

/** The base branch the RED spec PR targets: the change-set branch derived from the originating gig. */
export function specPrBase(originatingGigId: string): string {
  return deriveChangeSetBranch(originatingGigId);
}

/** The base branch the GREEN implementation PR targets: the SAME change-set branch it branched from. */
export function implPrBase(changeSetBranch: string): string {
  // The implementation branches FROM and targets the SAME change-set branch — an identity, not a
  // re-derivation, so `implPrBase(specPrBase(g)) === specPrBase(g)` holds structurally.
  return changeSetBranch;
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
  // Present ⇒ reuse (never fork a second, never clobber/force-reset the first); absent ⇒ create.
  return existingBranches.includes(branch)
    ? { created: false, reused: true, branch }
    : { created: true, reused: false, branch };
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
  // A base absent from the remote is a DEAD NAME — refused before any PR is sealed, the same
  // fail-closed altitude as a dead tool-grant. Present ⇒ the publish may proceed.
  return remoteBranches.includes(base) ? { ok: true } : { ok: false, refusal: "dead-branch", base };
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
  // The branch is CARRIED in the change-request. The working tree is NEVER consulted (inference is
  // how a run lands on the wrong branch silently), so `workingTreeBranch` is deliberately unused.
  void workingTreeBranch;
  if (req.change_set_branch === undefined || req.change_set_branch.length === 0) {
    return { ok: false, refusal: "branch-absent-but-expected" };
  }
  return { ok: true, branch: req.change_set_branch };
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
  /** Enqueued implementations keyed on the change-set branch — the idempotency key, not the delivery id. */
  private readonly byBranch = new Map<string, EnqueuedImplementation>();

  /** Handle one 'RED spec PR merged into the change-set branch' event. */
  handle(event: RedSpecMergedEvent): void {
    // At-most-once ENQUEUE keyed on the branch: once a branch carries an in-flight implementation,
    // every later delivery — a duplicate id or a fresh delivery of the same logical event — is a
    // no-op. The queue's atomic claim/lease is what gives at-most-once RUN; this guards the enqueue.
    if (this.byBranch.has(event.change_set_branch)) return;
    this.byBranch.set(event.change_set_branch, {
      standard: IMPLEMENTATION_STANDARD,
      change_request: { change_set_branch: event.change_set_branch },
    });
  }

  /** The implementation gigs enqueued for a change-set branch — 0 or exactly 1. */
  enqueued(changeSetBranch: string): readonly EnqueuedImplementation[] {
    const one = this.byBranch.get(changeSetBranch);
    return one ? [one] : [];
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
  private _state: ChangeSetState = "none";
  private readonly _retirements: RetirementRecord[] = [];

  constructor(private readonly changeSetBranch: string) {
    void this.changeSetBranch;
  }

  state(): ChangeSetState {
    return this._state;
  }

  /** Apply a command; return the merge attempts it performed (so a test can assert their targets). */
  apply(cmd: LifecycleCommand): readonly MergeAttempt[] {
    switch (cmd.kind) {
      case "create":
        // Creating the branch is not a merge — it produces no MergeAttempt.
        return [];
      case "merge-red":
        // The RED spec PR merges INTO the change-set branch — NEVER the protected main line.
        this._state = "red";
        return [{ action: "merge-red", target_branch: this.changeSetBranch }];
      case "merge-green":
        // The GREEN implementation PR merges INTO the change-set branch — again never main.
        this._state = "green";
        return [{ action: "merge-green", target_branch: this.changeSetBranch }];
      case "promote-to-main":
        // The ONLY main-targeting merge: the final change-set→main PR, merged by the governor on
        // green CI. It is not a red merge, so it composes with Law C rather than contradicting it.
        return [{ action: "promote-to-main", target_branch: PROTECTED_MAIN_LINE }];
      case "retire":
        // At-most-once, and always RECORDED — a second retire is a no-op, never a silent delete.
        if (this._retirements.length === 0) {
          this._retirements.push({ branch: this.changeSetBranch, by: cmd.by });
          this._state = "retired";
        }
        return [];
    }
  }

  /** How many times this branch has been retired (must never exceed 1). */
  retiredCount(): number {
    return this._retirements.length;
  }

  /** The recorded retirement events — length must equal retiredCount(); a silent retire is refused. */
  retirementLog(): readonly RetirementRecord[] {
    return this._retirements;
  }
}
