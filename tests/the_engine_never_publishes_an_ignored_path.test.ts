// A GITIGNORED WRITE IS NEVER SEALED, COMMITTED OR PUSHED BY THE ENGINE.
//
// The conductor's ruling (26 Sep, round 4): the diff gate does not see paths git ignores — `git status`
// does not list them. That is a DOCUMENTED LIMIT, named as a non-goal in the red-spec, not something this
// change enforces. What IS enforced is its consequence: a write the gate could not see must never leave
// the tree through the engine.
//
// WHERE COULD IT LEAVE? The drafter checked (26 Sep, at 9ff943c): the engine has NO publish step. No
// src/ file runs `git add`, `git commit` or `git push`; committing and pushing are done by SEATS through
// their own Bash grants (pr-publisher, spec-publisher), which the sandbox and the diff gate already bound.
// The engine's only path from a tree file into a sealed record is stampChangeAddresses (src/runtime.ts),
// which stamps a change-set's `changes` from `git hash-object` / `git diff` for whatever path the seat
// names. Named an ignored path, it stamps it — an unjudged file's bytes sealed as if it were a change.
//
//   law                                                   kind         drives                                     plant
//   a change-set naming an ignored path is refused         behavioural  stampChangeAddresses — src/runtime.ts       drop the ignored-path refusal (stamp every
//                                                                                                                  named path)
//   control: a tracked, changed path stamps                behavioural  same                                       refuse every change
//   the engine has no publish step (no add/commit/push)    structural   src/*.ts                                   add gitInTree(tree_root, ["add", "-A"]) (or
//                                                                                                                  any commit/push) to src/
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stampChangeAddresses } from "../src/runtime.js";

function treeWithIgnore(): { root: string; base: string } {
  const root = mkdtempSync(join(tmpdir(), "ignored-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", root]);
  writeFileSync(join(root, ".gitignore"), "secret.env\nbuild/\n");
  writeFileSync(join(root, "a.ts"), "a\n");
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "seed"], { env });
  const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  writeFileSync(join(root, "a.ts"), "a changed\n");
  writeFileSync(join(root, "secret.env"), "TOKEN=written-where-the-gate-cannot-see\n");
  return { root, base };
}

describe("a gitignored path never leaves the tree through the engine", () => {
  it("control — a tracked, changed path is stamped", () => {
    const { root, base } = treeWithIgnore();
    const [c] = stampChangeAddresses([{ path: "a.ts", base } as never], root);
    expect(c!.bytes, "non-vacuity: the diff was read").toBeGreaterThan(0);
  });

  it("a change-set naming an IGNORED path is refused, naming it — its bytes are never sealed", () => {
    const { root, base } = treeWithIgnore();
    let err = "";
    let stamped: unknown;
    try {
      stamped = stampChangeAddresses([{ path: "a.ts", base } as never, { path: "secret.env", base } as never], root);
    } catch (e) {
      err = String((e as Error)?.message ?? e);
    }
    expect(stamped, "the engine stamped a gitignored file into a sealed change-set — a write the diff gate never saw").toBeUndefined();
    expect(err, "the refusal does not name the ignored path").toContain("secret.env");
  });

  it("the engine has no publish step: no src/ file runs git add, commit or push", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const offenders: string[] = [];
    for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(src, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      text.split("\n").forEach((line, i) => {
        const gitCall = /\bgit\b|gitInTree|execFileSync\(\s*["']git["']/.test(line);
        if (/\bgit\s+(add|commit|push)\b/.test(line) || (gitCall && /["'](add|commit|push)["']/.test(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `the engine grew a publish step — it would ship whatever the tree holds, including ignored paths the gate never saw:\n${offenders.join("\n")}`).toEqual([]);
  });
});
