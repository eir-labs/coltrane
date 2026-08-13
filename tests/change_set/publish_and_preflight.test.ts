// RED — the retarget onto the change-set branch, the dead-branch pre-flight, and the CARRIED
// implementation branch.
//
// Covers I4 (RED spec PR base = change-set branch, != main), I5 (GREEN implementation PR base =
// the SAME change-set branch, != main), I7 (the implementation run's branch is the CARRIED
// change_set_branch, never inferred from the working tree), and I17 (a base branch that does not
// exist on the remote is refused as a dead name before any PR is sealed). Also exercises the
// acceptance criterion that a resumed re-publish neither forks a second branch nor clobbers the
// first (ensureChangeSetBranch), and the fail-closed refusal when the branch is absent-but-expected.
//
// RED because src/change_set_branch.ts throws in every body until the implementation exists. The
// assertions are strict (base !== main, refusal codes, carried value beats the working tree) so a
// wrong implementation — e.g. one that keeps targeting main, or infers the branch from the tree —
// stays red rather than passing by accident.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  deriveChangeSetBranch,
  parseOriginatingGig,
  specPrBase,
  implPrBase,
  ensureChangeSetBranch,
  assertBasePublishable,
  resolveImplementationBranch,
  isChangeSetBranch,
  PROTECTED_MAIN_LINE,
} from "../../src/change_set_branch.js";

describe("publish retarget — both PRs target the change-set branch, never main (I4, I5)", () => {
  it("I4 the RED spec PR base is the change-set branch keyed by the originating gig, not main", () => {
    fc.assert(
      fc.property(fc.uuid(), (gigId) => {
        const base = specPrBase(gigId);
        expect(base).not.toBe(PROTECTED_MAIN_LINE);
        expect(isChangeSetBranch(base)).toBe(true);
        expect(parseOriginatingGig(base)).toBe(gigId);
      }),
    );
  });

  it("I5 the GREEN implementation PR base is the SAME change-set branch, not main", () => {
    fc.assert(
      fc.property(fc.uuid(), (gigId) => {
        const changeSetBranch = deriveChangeSetBranch(gigId);
        const base = implPrBase(changeSetBranch);
        expect(base).not.toBe(PROTECTED_MAIN_LINE);
        expect(base).toBe(changeSetBranch);
        // spec and implementation seal the same base over one originating gig — the relationship
        // is structural (a shared branch), not a sentence in a PR body.
        expect(implPrBase(specPrBase(gigId))).toBe(specPrBase(gigId));
      }),
    );
  });
});

describe("resumed re-publish is idempotent on the branch (create-if-absent / reuse-if-present)", () => {
  it("creates the branch when it is absent", () => {
    const branch = "changeset/550e8400-e29b-41d4-a716-446655440000";
    const outcome = ensureChangeSetBranch(branch, ["main", "other"]);
    expect(outcome.created).toBe(true);
    expect(outcome.branch).toBe(branch);
  });

  it("reuses the existing branch when it is already present — never forks a second, never clobbers", () => {
    const branch = "changeset/550e8400-e29b-41d4-a716-446655440000";
    const outcome = ensureChangeSetBranch(branch, ["main", branch]);
    expect(outcome.created).toBe(false);
    expect(outcome.reused).toBe(true);
    expect(outcome.branch).toBe(branch);
  });
});

describe("dead-branch pre-flight — a PR naming an absent base is refused, nothing sealed (I17)", () => {
  it("I17 refuses when the base does not exist on the remote", () => {
    const gate = assertBasePublishable("changeset/does-not-exist", ["main", "changeset/real"]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.refusal).toBe("dead-branch");
      expect(gate.base).toBe("changeset/does-not-exist");
    }
  });

  it("I17 permits when the base does exist on the remote", () => {
    const gate = assertBasePublishable("changeset/real", ["main", "changeset/real"]);
    expect(gate.ok).toBe(true);
  });
});

describe("the implementation branch is CARRIED, never inferred from the working tree (I7)", () => {
  it("I7 resolves to the carried change_set_branch, ignoring the working-tree branch", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.string(), (gigId, workingTreeBranch) => {
        const carried = deriveChangeSetBranch(gigId);
        fc.pre(carried !== workingTreeBranch);
        const res = resolveImplementationBranch({ change_set_branch: carried }, workingTreeBranch);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.branch).toBe(carried); // the carried value, NOT the working tree
      }),
    );
  });

  it("I7/F4 refuses (hard stop) when the branch is absent-but-expected — it does not guess", () => {
    const res = resolveImplementationBranch({}, "whatever-branch-the-tree-is-on");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusal).toBe("branch-absent-but-expected");
  });
});
