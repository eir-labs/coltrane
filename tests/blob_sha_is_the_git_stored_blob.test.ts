// `blob_sha` NAMES THE CONTENT GIT STORES — NOT THE BYTES THAT HAPPEN TO BE ON DISK.
//
// THE QUESTION THIS SETTLES. `stampChangeAddresses` computes a change's `blob_sha` in process
// (`blobShaOfFile`), which is `git hash-object --no-filters`: the bytes exactly as they sit on disk.
// On a plain checkout that is also what bare `git hash-object` answers, so nothing moves. Where a
// checkout converts content on its way into git, the two answers DIVERGE, and something has to say
// which one the sealed field means. That is not a matter of taste and it is not a founder's call: it
// is a question about what a sealed field MEANS, and the record and its readers already answer it.
//
// THE EVIDENCE, four ways, all of it already in the tree:
//
//  1. THE SIBLINGS ON THE SAME RECORD SPEAK GIT-STORED CONTENT. A `ChangeAddress` is
//     `{path, base, blob_sha, patch_sha256, bytes}`. `base` is a commit. `patch_sha256` and `bytes`
//     are the sha256 and length of `git diff <base> -- <path>` — and `git diff` compares the
//     working tree AFTER conversion, in git's own terms. Measured: on a converting checkout, a file
//     whose on-disk bytes are unchanged produces an EMPTY diff (`bytes: 0`, "nothing changed from
//     base") while its raw-bytes sha differs from `base`'s blob. One record would then assert both
//     "no change from base" and "a different blob from base". A record that mixes the two
//     vocabularies is incoherent, and the incoherence is the answer.
//
//  2. THE SIBLING RECORD USES THE SAME FIELD NAME FOR A `rev-parse`. `stampLawAddresses` stamps a
//     `LawAddress.blob_sha` as `git rev-parse <commit>:<path>` — a git object id, by construction.
//     One name under one contract (`contract-records-by-address-v1`), refused by one code
//     (`law_bytes_mismatch`), cannot mean two different things on two records.
//
//  3. THE SHIPPED READERS COMPARE IT AGAINST GIT'S OBJECT DATABASE. `agents/change-verifier.json`
//     step 2b compares a sealed `blob_sha` with `git hash-object <path>` on the working tree and
//     FAILS the verdict on a difference ("a WEAKENED LAW"); `agents/red-law-reviewer.json` step 4
//     compares it with `git rev-parse <commit>:<path>`. Both comparands are git-stored content. A
//     raw-bytes seal would make an untouched law read as tampered with on a converting checkout —
//     a false accusation, arriving as a legitimate-looking verdict.
//
//  4. IT DECIDES WHAT A HONEST SEAT COMPUTED. `stampChangeAddresses` refuses a seat-supplied
//     `blob_sha` that disagrees with the engine (`law_bytes_mismatch`). The only value a seat is
//     ever told to compute is the one in (3) — bare `git hash-object <path>`. If the engine's field
//     meant raw bytes, the refusal would fire on a seat that did exactly as instructed.
//
// SO: `blob_sha` is the id of the object git holds (or would hold) for that path. It is an ADDRESS —
// `git cat-file blob <blob_sha>` is meant to return the sealed bytes — which is the whole point of
// `contract-records-by-address-v1`: a reviewer is handed an address that resolves, never a summary.
//
// WHAT THESE LAWS CAN AND CANNOT SEE. Every git call below runs in a throwaway repository this file
// creates, initialises and deletes; nothing reads or writes this repository's own history and
// nothing here configures git. In such a repository the two candidate meanings COINCIDE, so these
// laws cannot by themselves distinguish them — they pin the CONTRACT that makes one of them the
// right one, and each reds on a production edit that breaks it:
//
// The plants, applied to production and OBSERVED red, then reverted:
//
//   P1  src/runtime.ts, stampLawAddresses: `rev-parse <commit>:<path>` -> `rev-parse <commit>`
//   P2  src/runtime.ts, blobShaOfFile: drop the "blob " word from the header
//   P3  src/runtime.ts, blobShaOfFile: fold `size + 1` into the header
//   P4  src/runtime.ts, blobShaOfFile: drop the NUL from the header
//   P5  agents/change-verifier.json: delete "(`git hash-object <path>`)" from step 2b
//
//   law  kind         drives                                                    reds under
//   S1   behavioural  stampLawAddresses — src/runtime.ts                        P1
//   S2   behavioural  stampChangeAddresses + stampLawAddresses — src/runtime.ts P1, P2, P3, P4
//   S3   behavioural  stampChangeAddresses — src/runtime.ts                     P2, P3, P4
//   S4   behavioural  stampChangeAddresses — src/runtime.ts                     P2, P3, P4
//   S5   behavioural  stampChangeAddresses — src/runtime.ts                     P2, P3, P4
//   S6   behavioural  blobShaOfFile — src/runtime.ts                            P2, P3, P4
//   S7   structural   agents/change-verifier.json,                              P5
//                     agents/red-law-reviewer.json (method text)
//
// What does NOT red these laws, stated so the coverage is not overread: a chunk-loop defect. Every
// file here is well under the reader's 64 KiB chunk, so "hash only the first chunk" leaves all seven
// green — that plant belongs to tests/blob_sha_in_process.test.ts, whose corpus carries a 5 MiB
// entry for exactly that reason. These laws are about what the field MEANS, not about the folding.
//
// S7 is structural because the obligation IS text: a method is prose handed to a model and nothing
// executes it but the model. It is here so the two halves cannot drift apart silently — if a seat's
// method is ever rewritten to compare raw bytes, this law reds and the engine's side of the question
// is reopened in the same commit, instead of being remembered by nobody.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blobShaOfFile, stampLawAddresses, stampChangeAddresses } from "../src/runtime.js";
import { loadGenome } from "../src/loader.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

let repo: string;

function git(args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV }).toString();
}
function gitRaw(args: string[]): Buffer {
  return execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, maxBuffer: 1 << 24 });
}
function writeIn(rel: string, bytes: Buffer | string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}
function commitAll(message: string): string {
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

// The law body a drafter seals. Its exact titles do not matter here; what matters is that the file
// is real content with a real blob.
const LAW_BODY = 'import { it, expect } from "vitest";\nit("a law holds", () => { expect(1).toBe(1); });\n';

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "coltrane-blob-meaning-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { env: GIT_ENV });
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("blob_sha names the content git stores, and the record's readers can resolve it", () => {
  it("S1 — a sealed law's blob_sha is the value a verifying seat recomputes with `git hash-object <path>` on the untouched tree", () => {
    // The join agents/change-verifier.json step 2b actually performs: it reads the sealed blob_sha
    // (stamped by the engine from `git rev-parse <commit>:<path>`) and compares it with the working
    // tree's own `git hash-object <path>`, failing the verdict on a difference. That comparison is
    // only sound because both name the SAME thing — the content git stores for that path. If the
    // engine's field ever stopped meaning that, this seat would report an untouched law as weakened.
    writeIn("tests/x.test.ts", LAW_BODY);
    const commit = commitAll("seal the law");

    const sealed = stampLawAddresses([{ path: "tests/x.test.ts", commit }], repo)[0]!;
    const whatTheSeatComputes = git(["hash-object", "tests/x.test.ts"]).trim();

    expect(sealed.blob_sha, "the sealed blob_sha must be what `git hash-object <path>` answers for the same untouched file — that equality IS the change-verifier's tamper check").toBe(whatTheSeatComputes);
    expect(sealed.blob_sha, "and it must be git's own object id for <commit>:<path>").toBe(git(["rev-parse", `${commit}:tests/x.test.ts`]).trim());
  });

  it("S2 — one field name, one value: a change's blob_sha is the same object id the law address names for the same content", () => {
    // `blob_sha` appears on two records under one contract, stamped by two different mechanisms —
    // `blobShaOfFile` for a change, `git rev-parse <commit>:<path>` for a law. If the two ever
    // answered differently for identical content, a change-set and a red-spec could never be joined
    // on the field they share, and `law_bytes_mismatch` would be calibrated against two truths.
    const base = (() => { writeIn("src/f.ts", "export const a = 1;\n"); return commitAll("base"); })();
    writeIn("src/f.ts", "export const a = 2;\n");

    const asChange = stampChangeAddresses([{ path: "src/f.ts", base }], repo)[0]!;
    const commit = commitAll("the change, committed");
    const asLaw = stampLawAddresses([{ path: "src/f.ts", commit }], repo)[0]!;

    expect(asChange.blob_sha, "the change stamper and the law stamper must name the same object for the same bytes").toBe(asLaw.blob_sha);
  });

  it("S3 — a change's blob_sha is an ADDRESS: `git cat-file blob <blob_sha>` returns the sealed bytes", () => {
    // contract-records-by-address-v1's O5 — "a sealed address always resolves to exact bytes" —
    // applied to the change record. A value that is not a git object id resolves to nothing, and a
    // reviewer holding it has an address that does not deliver: the exact failure the contract was
    // written to foreclose. The builder stages what it wrote before sealing (red-spec-builder step
    // 8), so the object is in the database at seal.
    const base = (() => { writeIn("src/f.ts", "export const a = 1;\n"); return commitAll("base"); })();
    const newBytes = "export const a = 2;\nexport const b = 3;\n";
    writeIn("src/f.ts", newBytes);
    git(["add", "--", "src/f.ts"]);

    const stamped = stampChangeAddresses([{ path: "src/f.ts", base }], repo)[0]!;

    expect(stamped.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(["cat-file", "-t", stamped.blob_sha]).trim(), "the sealed blob_sha must be a blob git holds, not an id of nothing").toBe("blob");
    expect(gitRaw(["cat-file", "blob", stamped.blob_sha]).toString("utf8"), "and resolving it must yield the exact sealed bytes").toBe(newBytes);
  });

  it("S4 — a seat that computes the value it was told to compute is ACCEPTED, never refused as a liar", () => {
    // `law_bytes_mismatch` exists to catch a seat that claims bytes it does not hold. It is only
    // that if the engine agrees with what an honest seat computes — and the only recipe a seat is
    // ever given is agents/change-verifier.json step 2b's bare `git hash-object <path>`. A field
    // whose meaning drifted away from that recipe would turn the refusal on truthful seats.
    const base = (() => { writeIn("src/f.ts", "export const a = 1;\n"); return commitAll("base"); })();
    writeIn("src/f.ts", "export const a = 2;\n");
    const honest = git(["hash-object", "src/f.ts"]).trim();

    expect(() => stampChangeAddresses([{ path: "src/f.ts", base, blob_sha: honest }], repo), "a seat supplying `git hash-object <path>` must be accepted — the refusal is for liars, not for seats that followed the method").not.toThrow();
    // and the refusal is still live for a value that is NOT what git holds, so S4 is not vacuous
    expect(() => stampChangeAddresses([{ path: "src/f.ts", base, blob_sha: "0".repeat(40) }], repo)).toThrow(/law_bytes_mismatch/);
  });

  it("S5 — blob_sha and patch_sha256 answer the same question: an empty diff from base means base's own blob", () => {
    // The two fields are stamped by two different mechanisms over the same file, and they must not
    // speak different vocabularies. `bytes === 0` is the engine's own statement that `git diff
    // <base> -- <path>` found NOTHING between base and the tree. A blob_sha that nonetheless
    // differs from base's blob would have the one record assert, in the same breath, "unchanged
    // from base" and "a different object from base".
    writeIn("src/f.ts", "export const a = 1;\n");
    const base = commitAll("base");

    const stamped = stampChangeAddresses([{ path: "src/f.ts", base }], repo)[0]!;

    expect(stamped.bytes, "nothing was changed after base, so the diff is empty").toBe(0);
    expect(stamped.blob_sha, "an empty diff from base and a blob differing from base's cannot both be true of one file").toBe(git(["rev-parse", `${base}:src/f.ts`]).trim());
  });

  it("S6 — the seat-primer's two blob producers agree, so a fork's staleness check cannot read a false stale", () => {
    // The primer seals each read file at `git rev-parse <snapshot>:<path>` where the snapshot holds
    // it, and at `blobShaOfFile` where it does not; the FORK then decides staleness by comparing the
    // sealed value against `blobShaOfFile` alone (contract-seat-primer-v1 O4). Seal by one, read by
    // the other: if the two ever disagreed for an unmodified tracked file, every primed file would
    // read as stale forever and the fork would quietly stop reusing anything. Nothing would raise —
    // it would just fall back, which is exactly why it needs a law and not a comment.
    writeIn("src/a.ts", "export const a = 1;\n");
    writeIn("src/b.ts", "export const b = 2;\n");
    const snapshot = commitAll("what the primer read");

    for (const path of ["src/a.ts", "src/b.ts"]) {
      expect(blobShaOfFile(repo, path), `the primer's snapshot producer and the fork's staleness comparand must return one value for ${path}`).toBe(git(["rev-parse", `${snapshot}:${path}`]).trim());
    }
  });

  it("S7 — the seats that READ blob_sha name a git-stored comparand, so the field's meaning is fixed at both ends", () => {
    // Structural, and it must be: a method is prose a model reads. What it pins is the other half of
    // the contract — an engine-side change of meaning is only safe if these recipes change with it,
    // and this law makes that a red instead of a thing someone was supposed to remember.
    const genome = loadGenome(REPO_ROOT);
    const method = (slug: string): string => {
      const agent = genome.agents.get(slug);
      expect(agent, `${slug} must be in the genome — it is one of the two seats that read a sealed blob_sha`).toBeDefined();
      return agent!.method ?? "";
    };

    expect(method("change-verifier"), "the change-verifier recomputes a sealed blob_sha with bare `git hash-object <path>` — git-stored content, not the raw bytes on disk").toContain("git hash-object <path>");
    expect(method("red-law-reviewer"), "the red-law-reviewer recomputes it with `git rev-parse <commit>:<path>` — a git object id").toContain("git rev-parse <commit>:<path>");
    // Both must be talking about the SEALED field, not about some other hash they happen to run.
    expect(method("change-verifier")).toContain("sealed `blob_sha`");
    expect(method("red-law-reviewer")).toContain("sealed `blob_sha`");
  });
});
