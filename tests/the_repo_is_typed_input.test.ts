// THE WORKING-TREE REPOSITORY COMES FROM THE WORK, NOT FROM THE ORGANIZATION.
//
// The drain sourced the tree from `coltrane_organization.repo_url` — one repository per org,
// returned on the claim as `claim.repo_url` and used for the clone and the per-gig git-credential
// mint. That is the wrong home, on two counts:
//
//   1. A GIG IS NOT REPO-SHAPED. A research standard (lineage-pass-v1, a repo survey, any analysis)
//      has no repository and needs none. Binding the repo to the org forces a repo concept onto work
//      that has nothing to do with code.
//   2. A FACTORY SERVES MANY REPOSITORIES. One org runs work across many repos, so "which repo does
//      this work land in" became an ENVIRONMENT CONSTANT instead of a property of the work — exactly
//      backwards. server.ts:768 already says it out loud: "A venue is at rest and serves many
//      repositories".
//
// The right source already exists and already arrives. `repository` is a typed field in the input
// contract of every code-touching standard (domain_types/change-request.json,
// domain_types/change-context.json), and coltrane_drain_claim already returns the typed input as
// `claim.input`. The correct value was being passed and IGNORED in favour of the org column.
//
// These laws pin the resolution ORDER, and pin that a standard with no repository in its contract
// still touches no tree and mints no credential — which is what makes this a correctness fix rather
// than a migration.
import { describe, it, expect } from "vitest";
import { resolveWorkingRepo } from "../src/worker.js";

const claim = (over: Record<string, unknown> = {}): Parameters<typeof resolveWorkingRepo>[0] =>
  ({ gig_id: "g", standard_slug: "s", standard_version: null, mode: "live",
     input: {}, acting_for: "a", ...over }) as Parameters<typeof resolveWorkingRepo>[0];

describe("the working-tree repository is typed input", () => {
  it("R0 the resolver exists and is a pure function of the claim — one home for the decision", () => {
    expect(typeof resolveWorkingRepo).toBe("function");
    expect(resolveWorkingRepo.length).toBe(1);
  });

  it("R1 the TYPED INPUT wins — a repository named by the work is the tree the work lands in", () => {
    const r = resolveWorkingRepo(claim({
      input: { repository: "https://github.com/eir-labs/telescope" },
      repo_url: "https://github.com/eir-labs/org-default",
    }));
    expect(r, "the org column overrode the repository the standard's own contract named").toBe(
      "https://github.com/eir-labs/telescope",
    );
  });

  it("R2 the org column is a FALLBACK, not the source — single-repo orgs keep working", () => {
    const r = resolveWorkingRepo(claim({ input: {}, repo_url: "https://github.com/eir-labs/org-default" }));
    expect(r, "an org default was dropped, breaking every existing single-repo deployment").toBe(
      "https://github.com/eir-labs/org-default",
    );
  });

  it("R3 NEITHER is null — a research standard touches no tree and mints no credential", () => {
    expect(
      resolveWorkingRepo(claim({ input: { q: "a question" } })),
      "a standard with no repository in its contract was given one anyway",
    ).toBeNull();
  });

  it("R4 an empty or non-string repository is not a repository", () => {
    expect(resolveWorkingRepo(claim({ input: { repository: "" } })), "empty string read as a repo").toBeNull();
    expect(resolveWorkingRepo(claim({ input: { repository: 42 } })), "a number read as a repo").toBeNull();
    expect(
      resolveWorkingRepo(claim({ input: { repository: "   " } })),
      "whitespace read as a repo — a clone would be attempted against nothing",
    ).toBeNull();
  });

  it("R5 an empty typed repository still falls back rather than losing the org default", () => {
    const r = resolveWorkingRepo(claim({
      input: { repository: "" },
      repo_url: "https://github.com/eir-labs/org-default",
    }));
    expect(r, "an empty typed field swallowed a usable org default").toBe("https://github.com/eir-labs/org-default");
  });
});
