// SPLIT 2026-09-17 from tests/spec_records_by_address.test.ts, laws byte-identical: these are the
// src-side stamping laws a build seat can turn green. The type-shape and genome laws stay in that file,
// because only the conducting session's type_extend / agent_evolve can make them green.

// RECORDS BY ADDRESS — a red-spec carries its laws, and a change-set its changes, BY ADDRESS.
//
// THE MEASURED PROBLEM (seat-briefing census, 2026-09-17). gig c1771b13's attester hit the 32,000
// output-token cap THREE TIMES re-emitting ~150KB of verbatim law patches into `red-spec.diffs`, and
// every downstream seat receives the whole record through JSON.stringify(o.data) (claude_invoker.ts).
// The bytes are the cost. THE CONTRACT (decided by the operator): a seat supplies only WHERE the bytes
// are — {path, commit} for a law, {path, base} for a change — and the ENGINE stamps WHAT they are, from
// git, AT SEAL. No patch body is ever model output or a record field.
//
// These laws are RED by design: the address-stamping mechanism does not exist yet. Each law that needs
// the mechanism LEADS with the assertion that the mechanism is absent, stating the contract's reason —
// so the file COLLECTS (namespace import, no missing-export link error) and fails on the contract, not
// on a TypeError. The seal helpers are the real callsite: they are invoked from executeChair's seal
// loop, beside the *_sha backfill (runtime.ts), exactly as computeAppendCost/workingModel are exported
// seal helpers the runtime calls. See docs/specs/records-by-address.red-spec.md.
//
// Every git call runs in a temporary repository the law creates itself; nothing reads or writes this
// repository's own history.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { sealDrill } from "../src/seal_drill.js";
import * as runtime from "../src/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── the not-yet-existing seal-path mechanism, reached reflectively so a missing export is `undefined`
//    (red for the contract's reason via the leading assertion below) rather than an ESM link error. ──
type Law = { path: string; commit: string; blob_sha?: string; tests?: string[] };
type StampLaws = (laws: readonly Law[], tree_root: string | undefined) => Array<Required<Law>>;
type Change = { path: string; base: string; blob_sha?: string; patch_sha256?: string; bytes?: number };
type StampChanges = (changes: readonly Change[], tree_root: string | undefined) => Array<Required<Change>>;
const rt = runtime as unknown as Record<string, unknown>;
function requireFn<T>(name: string, why: string): T {
  const fn = rt[name];
  // THE LEADING, CONTRACT-STATING ASSERTION. Red today because the engine stamps nothing from an
  // address; green once the seal path exports this mechanism. Failing here aborts the `it`, so a
  // later `.toThrow()` can never pass on a spurious "not a function".
  expect(typeof fn, why).toBe("function");
  return fn as T;
}

// ── temp-git-repo helpers (the workspace.test.ts house pattern) ──
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  return dir;
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
}
function writeIn(repo: string, path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const lawFile = (titles: string[]): string =>
  `import { it, expect } from "vitest";\n` +
  titles.map((t) => `it(${JSON.stringify(t)}, () => { expect(1).toBe(1); });`).join("\n") + "\n";

const genome = loadGenome(REPO_ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);


describe("records by address — the engine stamps from git at seal (O1, O2, O3, I2, I3)", () => {
  it("I2 — the stamped blob_sha equals `git rev-parse <commit>:<path>`, and tests equals the titles in that blob, in file order", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "the seal must stamp blob_sha (git rev-parse <commit>:<path>) and tests (the it/test titles in that blob) from a supplied {path, commit} — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-i2-");
    try {
      const titles = ["a red law holds", "a second law", "and a third, in order"];
      writeIn(repo, "tests/x.test.ts", lawFile(titles));
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      const stamped = stamp([{ path: "tests/x.test.ts", commit }], repo);
      const expectedBlob = git(repo, ["rev-parse", `${commit}:tests/x.test.ts`]).trim();
      expect(stamped[0]!.blob_sha, "blob_sha must be git's own object id for <commit>:<path>").toBe(expectedBlob);
      expect(stamped[0]!.tests, "tests must be the it/test titles in that blob, in file order").toEqual(titles);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("I3 — a change's patch_sha256 and bytes equal the sha256 and length of `git diff <base> -- <path>` in tree_root", () => {
    const stamp = requireFn<StampChanges>(
      "stampChangeAddresses",
      "the seal must stamp blob_sha (git hash-object), patch_sha256 (sha256 of `git diff <base> -- <path>`) and bytes (that diff's length) from a supplied {path, base} — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-i3-");
    try {
      writeIn(repo, "src/f.ts", "export const a = 1;\n");
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "base"]);
      const base = git(repo, ["rev-parse", "HEAD"]).trim();
      writeIn(repo, "src/f.ts", "export const a = 2;\n"); // an unstaged working-tree change
      const stamped = stamp([{ path: "src/f.ts", base }], repo);
      const diff = git(repo, ["diff", base, "--", "src/f.ts"]);
      expect(stamped[0]!.patch_sha256, "patch_sha256 must be sha256 of the real diff").toBe(sha256(diff));
      expect(stamped[0]!.bytes, "bytes must be the diff's length").toBe(Buffer.byteLength(diff, "utf8"));
      expect(stamped[0]!.blob_sha, "blob_sha must be git hash-object of the file in tree_root").toBe(git(repo, ["hash-object", "src/f.ts"]).trim());
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("O2 — a file absent from the tree stamps blob_sha as the literal \"deleted\"", () => {
    const stamp = requireFn<StampChanges>(
      "stampChangeAddresses",
      "a deletion must stamp blob_sha as the literal \"deleted\" rather than fail — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-del-");
    try {
      writeIn(repo, "src/gone.ts", "export const a = 1;\n");
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "base"]);
      const base = git(repo, ["rev-parse", "HEAD"]).trim();
      git(repo, ["rm", "--quiet", "src/gone.ts"]); // deleted in the tree
      const stamped = stamp([{ path: "src/gone.ts", base }], repo);
      expect(stamped[0]!.blob_sha, "a deleted file's blob_sha is the literal \"deleted\"").toBe("deleted");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("O3 — stamping reads RunDeps.tree_root, not process.cwd(): a path present only in the supplied root resolves", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "stamping must resolve against the supplied tree_root, never process.cwd() — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-o3-");
    try {
      // A path that exists in THIS temp repo but not in the coltrane checkout (cwd). If the mechanism
      // read cwd it would fail to resolve; reading tree_root, it resolves to this repo's blob.
      writeIn(repo, "tests/only_here.test.ts", lawFile(["a law that lives only in the supplied root"]));
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      const stamped = stamp([{ path: "tests/only_here.test.ts", commit }], repo);
      expect(stamped[0]!.blob_sha, "must resolve against tree_root").toBe(git(repo, ["rev-parse", `${commit}:tests/only_here.test.ts`]).trim());
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("records by address — the record stays small (I1)", () => {
  it("I1 — 14 laws of ~10KB files each seal as a record whose JSON is under 4KB: it carries addresses, not bytes", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "a 14-law red-spec must seal under 4KB by carrying addresses; the engine stamp is the only way it can — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-i1-");
    try {
      let totalBytes = 0;
      for (let i = 0; i < 14; i++) {
        const body = lawFile([`law ${i} holds`]) + "// " + "x".repeat(10000) + "\n";
        writeIn(repo, `tests/law_${i}.test.ts`, body);
        totalBytes += Buffer.byteLength(body, "utf8");
      }
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      const laws: Law[] = Array.from({ length: 14 }, (_, i) => ({ path: `tests/law_${i}.test.ts`, commit }));
      const stamped = stamp(laws, repo);
      const data = {
        validation_criteria: ["every invariant has a failing test"],
        input_refs: ["subsystem-contract-x"],
        laws: stamped,
        testing_method: "property-based where universal",
      };
      expect(totalBytes, "the fixture must actually be large, or the < 4KB claim is trivial").toBeGreaterThan(100000);
      expect(JSON.stringify(data).length, "a red-spec of 14 laws must seal under 4KB").toBeLessThan(4000);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("records by address — the seal refuses loudly (F1, F2, F3)", () => {
  it("F1 — an unresolvable law address (path absent at that commit) refuses with `law_record_unresolvable` naming path@commit", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "an address that does not resolve must refuse with law_record_unresolvable, not seal a hollow record — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-f1a-");
    try {
      writeIn(repo, "tests/present.test.ts", lawFile(["present"]));
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      expect(() => stamp([{ path: "tests/absent.test.ts", commit }], repo)).toThrow(/law_record_unresolvable[\s\S]*tests\/absent\.test\.ts/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("F1 — an unknown commit refuses with `law_record_unresolvable`", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "an unknown commit must refuse with law_record_unresolvable — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-f1b-");
    try {
      writeIn(repo, "tests/present.test.ts", lawFile(["present"]));
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      expect(() => stamp([{ path: "tests/present.test.ts", commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }], repo)).toThrow(/law_record_unresolvable/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("F2 — a red-spec sealed with no tree_root refuses with `tree_root_unknown`, never falling back to process.cwd()", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "stamping with no tree_root must refuse with tree_root_unknown, never silently read process.cwd() — src/runtime.ts exports no such mechanism",
    );
    expect(() => stamp([{ path: "tests/x.test.ts", commit: "a".repeat(40) }], undefined)).toThrow(/tree_root_unknown/);
  });

  it("F2 — a change-set sealed with no tree_root refuses with `tree_root_unknown`", () => {
    const stamp = requireFn<StampChanges>(
      "stampChangeAddresses",
      "stamping a change-set with no tree_root must refuse with tree_root_unknown — src/runtime.ts exports no such mechanism",
    );
    expect(() => stamp([{ path: "src/f.ts", base: "a".repeat(40) }], undefined)).toThrow(/tree_root_unknown/);
  });

  it("F3 — a seat-supplied blob_sha that disagrees with the engine refuses with `law_bytes_mismatch` naming the path and field", () => {
    const stamp = requireFn<StampLaws>(
      "stampLawAddresses",
      "a seat's blob_sha/tests claim that disagrees with git must refuse with law_bytes_mismatch, never be silently overwritten — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-f3a-");
    try {
      writeIn(repo, "tests/x.test.ts", lawFile(["a law"]));
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "seed"]);
      const commit = git(repo, ["rev-parse", "HEAD"]).trim();
      // The seat lies about the blob: a real-looking but wrong sha. The engine must catch, not clobber.
      expect(() => stamp([{ path: "tests/x.test.ts", commit, blob_sha: "1".repeat(40) }], repo))
        .toThrow(/law_bytes_mismatch[\s\S]*tests\/x\.test\.ts[\s\S]*blob_sha|law_bytes_mismatch[\s\S]*blob_sha[\s\S]*tests\/x\.test\.ts/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("F3 — a seat-supplied change `bytes` that disagrees with the engine refuses with `law_bytes_mismatch` naming the path and field", () => {
    const stamp = requireFn<StampChanges>(
      "stampChangeAddresses",
      "a seat's patch_sha256/bytes claim that disagrees with git must refuse with law_bytes_mismatch — src/runtime.ts exports no such mechanism",
    );
    const repo = newRepo("addr-f3b-");
    try {
      writeIn(repo, "src/f.ts", "export const a = 1;\n");
      git(repo, ["add", "-A"]); git(repo, ["commit", "--quiet", "-m", "base"]);
      const base = git(repo, ["rev-parse", "HEAD"]).trim();
      writeIn(repo, "src/f.ts", "export const a = 2;\n");
      expect(() => stamp([{ path: "src/f.ts", base, bytes: 999999 }], repo))
        .toThrow(/law_bytes_mismatch[\s\S]*src\/f\.ts[\s\S]*bytes|law_bytes_mismatch[\s\S]*bytes[\s\S]*src\/f\.ts/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

