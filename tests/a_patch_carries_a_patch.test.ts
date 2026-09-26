// A LAW IS CARRIED BY ADDRESS, AND AN ADDRESS ALWAYS RESOLVES TO THE EXACT LAW — NEVER A SENTENCE.
//
// SUPERSEDED, AND WHY. The old law here defended `red-spec.diffs[].patch`: the field was typed
// `{ "type": "string" }`, so a drafter could seal a one-line SUMMARY ("full unified diff captured from
// `git diff --cached` … content present verbatim in the working tree") where the diff belonged. The
// review chair reads test bodies OUT OF THAT FIELD, so a summary STARVED the gate — it had nothing to
// read (gig 34ff466b). The structural fix was "a patch must contain a `+`/`-` line."
//
// The records-by-address contract retires `diffs` entirely: a red-spec now carries `laws:
// [{path, commit, blob_sha, tests}]` and no patch body reaches a record at all (contract
// records-by-address-v1, O1/O5). So the starvation guarantee has to survive in ADDRESS FORM — and it
// does, MORE strongly: there is no free-text patch field for prose to hide in, and a sealed address
// ALWAYS resolves to the exact committed bytes (git show <commit>:<path>), pinned by the engine-stamped
// blob_sha. A reviewing seat is handed the law, never a sentence about the law; and an address that
// does not resolve refuses loudly rather than degrading to a placeholder.
//
// These laws are RED by design: the type is still v2 (carries `diffs`) and the stamping mechanism does
// not exist yet. Each law that needs the mechanism leads with the assertion that it is absent, stating
// the contract's reason, so the file collects and fails on the contract rather than on a TypeError.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../src/registry.js";
import { loadGenome } from "../src/loader.js";
import * as runtime from "../src/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(REPO_ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

type Law = { path: string; commit: string; blob_sha?: string; tests?: string[] };
type StampLaws = (laws: readonly Law[], tree_root: string | undefined) => Array<Required<Law>>;
const stampLawAddresses = (runtime as unknown as Record<string, unknown>)["stampLawAddresses"] as StampLaws | undefined;

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "addr-o5-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  return dir;
}
const git = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
function writeIn(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

describe("a law is carried by address, and the address resolves to the exact law (O5)", () => {
  it("O5 — a sealed law address resolves to the EXACT committed bytes: the reviewer is handed the law, not a sentence", () => {
    // The starvation guarantee, in address form. Red today: the engine stamps nothing from an address.
    expect(
      typeof stampLawAddresses,
      "a sealed address must resolve to exact bytes (blob_sha = git rev-parse <commit>:<path>) so a reviewer can never be handed a summary — src/runtime.ts exports no such mechanism",
    ).toBe("function");
    const repo = newRepo();
    try {
      const body = `import { it, expect } from "vitest";\nit("a real law body", () => { expect(2).toBe(2); });\n`;
      writeIn(repo, "tests/law.test.ts", body);
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      const stamped = stampLawAddresses!([{ path: "tests/law.test.ts", commit }], repo);
      // The engine's stamp pins the exact object, and the reviewer's own re-acquisition returns the
      // exact bytes — there is nowhere for a "sentence about the law" to stand in.
      expect(stamped[0]!.blob_sha).toBe(git(repo, ["rev-parse", `${commit}:tests/law.test.ts`]).trim());
      expect(git(repo, ["show", `${commit}:tests/law.test.ts`]), "the address resolves to the exact committed law").toBe(body);
      expect(stamped[0]!.tests, "and the stamped titles are read from the real blob").toEqual(["a real law body"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("O5 — the v3 red-spec has no free-text patch field: a record carrying a prose `patch`/`diffs` is refused", () => {
    // The old hole was a string `patch` that accepted a summary. In address form that field does not
    // exist, so the starvation cannot recur. Red today: the type still REQUIRES `diffs`, so the
    // prose-carrying record is (wrongly, per the contract) accepted and the address record refused.
    const prose = {
      validation_criteria: ["x"], input_refs: ["y"],
      diffs: [{ path: "tests/law.test.ts", patch: "full unified diff captured from `git diff --cached`; content present verbatim in the tree" }],
      coverage_map: [{ invariant_id: "I1", test_name: "t", test_file: "f", kind: "behavioural", drives: "f — src/f.ts", plant: "make f return the wrong value" }],
      testing_method: "m",
    };
    const v = registry.validate({ core_type: "Artifact", domain_type: "red-spec", data: prose } as never);
    expect(v.valid, "a red-spec carrying a prose `patch` in `diffs` was accepted — the contract retired `diffs` for `laws`").toBe(false);
    expect(v.errors.join(" "), "the refusal must name the missing `laws` field").toMatch(/\blaws\b/);
  });
});
