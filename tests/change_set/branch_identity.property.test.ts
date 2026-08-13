// RED — the change-set branch IDENTITY, keyed once by the ORIGINATING gig.
//
// Covers contract invariants I1 (git-check-ref-format valid), I2 (round-trip + injectivity),
// I3 (slug is decorative, outside the key) and I19 (keyed by the originating gig, not the
// implementation gig). Property-based (fast-check) because these are UNIVERSAL properties over
// every gig id, not one hand-picked example — which is also how the spec-reviewer's tautology
// gate is satisfied: they can only go green when the derivation holds for ALL inputs.
//
// RED because src/change_set_branch.ts is an explicitly-stubbed throwing seam: deriveChangeSetBranch
// / parseOriginatingGig throw until the implementation pipeline turns this branch green. The
// git-check-ref-format validator below is REAL (implemented from git-scm.com/docs/git-check-ref-format),
// so once the derivation exists the property meaningfully checks the output — not a tautology.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  deriveChangeSetBranch,
  parseOriginatingGig,
  CHANGE_SET_BRANCH_PREFIX,
} from "../../src/change_set_branch.js";

/** git-check-ref-format(1), the load-bearing subset. A UUID + hyphen/underscore slug is legal. */
function isValidGitRef(ref: string): boolean {
  if (ref.length === 0) return false;
  if (ref.startsWith("/") || ref.endsWith("/")) return false;
  if (ref.includes("//")) return false;
  if (ref.endsWith(".") || ref.endsWith(".lock")) return false;
  if (ref.includes("..") || ref.includes("@{")) return false;
  if (ref === "@") return false;
  for (const ch of ref) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
    if (" ~^:?*[\\".includes(ch)) return false;
  }
  for (const comp of ref.split("/")) {
    if (comp.length === 0 || comp.startsWith(".") || comp.endsWith(".lock")) return false;
  }
  return true;
}

const SLUGS = ["my-slug", "fix-the-thing", "retarget_publish", "changeset-branch", "a"];

describe("change-set branch identity — keyed by the originating gig (I1, I2, I3, I19)", () => {
  it("I1 the derived name is a git-check-ref-format-valid `changeset/<uuid>[/<slug>]` ref", () => {
    fc.assert(
      fc.property(fc.uuid(), (gigId) => {
        const branch = deriveChangeSetBranch(gigId);
        expect(isValidGitRef(branch), `derived "${branch}" is not a valid git ref`).toBe(true);
        expect(branch.startsWith(CHANGE_SET_BRANCH_PREFIX)).toBe(true);
      }),
    );
  });

  it("I1 the name stays a valid ref when a human slug rides alongside", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.constantFrom(...SLUGS), (gigId, slug) => {
        const branch = deriveChangeSetBranch(gigId, slug);
        expect(isValidGitRef(branch), `derived "${branch}" is not a valid git ref`).toBe(true);
        expect(branch.startsWith(CHANGE_SET_BRANCH_PREFIX)).toBe(true);
      }),
    );
  });

  it("I2 round-trip: parseOriginatingGig(deriveChangeSetBranch(id)) === id", () => {
    fc.assert(
      fc.property(fc.uuid(), (gigId) => {
        expect(parseOriginatingGig(deriveChangeSetBranch(gigId))).toBe(gigId);
      }),
    );
  });

  it("I2 injectivity: two distinct gig ids never derive to colliding branch names", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        fc.pre(a !== b);
        expect(deriveChangeSetBranch(a)).not.toBe(deriveChangeSetBranch(b));
      }),
    );
  });

  it("I3 the slug is decorative and outside the key — with or without it parses to the same id", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.constantFrom(...SLUGS), (gigId, slug) => {
        expect(parseOriginatingGig(deriveChangeSetBranch(gigId, slug))).toBe(gigId);
        expect(parseOriginatingGig(deriveChangeSetBranch(gigId))).toBe(gigId);
      }),
    );
  });

  it("I19 the key is the ORIGINATING gig, not whatever gig is current when it is read", () => {
    // The spec gig derives the branch; the DIFFERENT implementation gig later parses it. The pure
    // API is keyed by its argument, never an ambient current-gig — so parsing during the impl gig
    // (a different id entirely) still yields the originating (spec) gig id.
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (specGigId, implGigId) => {
        fc.pre(specGigId !== implGigId);
        const branch = deriveChangeSetBranch(specGigId, "spec-run");
        expect(parseOriginatingGig(branch)).toBe(specGigId);
        expect(parseOriginatingGig(branch)).not.toBe(implGigId);
      }),
    );
  });
});
