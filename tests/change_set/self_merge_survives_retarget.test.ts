// RED — the seat that BUILDS the change still cannot MERGE it, and the retarget onto the
// change-set branch must not smuggle a merge grant in.
//
// Covers I8. This is genuinely RED, not a tautology that already holds: the "no merge grant" half
// is true today, so on its own it would pass regardless of the change. It is bound here to the
// retarget marker — after Item 1/Item 2 land, each publish seat's definition must state it targets
// the CHANGE-SET branch (its base is no longer main) — which is ABSENT today. So the test reds now
// on the missing retarget, and can only go green when the retarget lands WITHOUT adding a merge
// grant. If a future edit retargets the seat but also grants it `gh pr merge`, this stays red.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface AgentDef {
  slug: string;
  identity: string;
  method: string;
  allowed_tools: string[];
}

function loadAgent(slug: string): AgentDef {
  return JSON.parse(readFileSync(join(REPO_ROOT, "agents", `${slug}.json`), "utf8")) as AgentDef;
}

/** A grant that could merge a pull request — the capability the publish seat must never hold. */
function grantsMerge(tools: readonly string[]): boolean {
  return tools.some((t) => /\bmerge\b/i.test(t));
}

/** Does the seat's charter state it targets the change-set branch (its base is not main)? */
function targetsChangeSetBranch(a: AgentDef): boolean {
  return /change-set branch|changeset\//i.test(`${a.identity}\n${a.method}`);
}

const PUBLISH_SEATS = ["spec-publisher", "pr-publisher"] as const;

describe("the publish seat cannot merge, and the retarget does not smuggle a merge grant in (I8)", () => {
  for (const slug of PUBLISH_SEATS) {
    describe(slug, () => {
      const agent = loadAgent(slug);

      it("holds no tool grant that can merge a pull request", () => {
        expect(
          grantsMerge(agent.allowed_tools),
          `"${slug}" holds a merge grant — the seat that builds the change must not be able to land it`,
        ).toBe(false);
      });

      it("targets the change-set branch (the retarget landed) while STILL holding no merge grant", () => {
        // RED today: no publish seat mentions the change-set branch yet — its base is still main.
        expect(
          targetsChangeSetBranch(agent),
          `"${slug}" does not target the change-set branch yet — Item 1/Item 2 retarget is absent`,
        ).toBe(true);
        // and the retarget must not have widened its authority to merge.
        expect(grantsMerge(agent.allowed_tools)).toBe(false);
      });
    });
  }
});
