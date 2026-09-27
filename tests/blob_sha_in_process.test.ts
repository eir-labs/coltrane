// THE BLOB SHA IS A PURE FUNCTION OF THE FILE'S BYTES — so the engine computes it, in process.
//
// A git blob sha is `SHA-1("blob " + <byte length> + "\0" + <contents>)`. That is arithmetic over
// bytes the engine already has. It used to be bought with `git hash-object` run inside `tree_root`
// — a seat's OWN working tree, a directory the engine does not control — three times over: the
// change stamper (`stampChangeAddresses`), the fork's staleness check, and the seat-primer's
// at-seal blob. `blobShaOfFile` replaces all three with the arithmetic.
//
// This file is the EQUIVALENCE PROOF that makes that a refactor and not a behaviour change. It
// drives REAL `git hash-object --no-filters` over a corpus and asserts the in-process answer is
// the same string, byte for byte:
//
//   empty file · a single byte · binary with embedded NULs · CRLF line endings · a file larger
//   than the reader's chunk (so the chunk loop is exercised, not just its first pass) · a file
//   with no trailing newline · UTF-8 with multibyte characters.
//
// `--no-filters` is the comparand DELIBERATELY: it is the one spelling of `git hash-object` that
// is defined to hash the bytes as they sit on disk, which is exactly what the arithmetic computes.
// B8 pins the other half of the claim — that for a repository with no attributes and no filters
// configured, bare `git hash-object` returns that same value, so nothing any caller sees moves.
//
// Every git invocation in this file runs in a throwaway repository the law CREATES and deletes.
// Nothing here reads or writes this repository's own history, and nothing here configures git.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobShaOfFile } from "../src/runtime.js";

// The reader folds the file in 64 KiB chunks; the "large" corpus entry must exceed that several
// times over or the loop's second pass is never taken and the chunking is untested.
const CHUNK_BYTES = 64 * 1024;

/** name → the exact bytes written to disk. */
const CORPUS: ReadonlyArray<readonly [string, Buffer]> = [
  ["empty.txt", Buffer.alloc(0)],
  ["one-byte.bin", Buffer.from([0x61])],
  ["nuls.bin", Buffer.from([0x78, 0x00, 0x79, 0x01, 0x02, 0x7a, 0x00, 0xff])],
  ["crlf.txt", Buffer.from("line one\r\nline two\r\n", "latin1")],
  ["no-trailing-newline.txt", Buffer.from("the last line has no newline", "utf8")],
  ["utf8.txt", Buffer.from("café — 日本語 — 🎷\n", "utf8")],
  // 5 MiB of NON-uniform bytes across ~80 chunks: a chunk loop that drops or repeats a chunk
  // cannot survive this, where a loop over 5 MiB of one repeated byte would.
  ["large.bin", Buffer.from(Array.from({ length: 80 * CHUNK_BYTES + 777 }, (_, i) => (i * 31 + (i >> 8)) & 0xff))],
];

let repo: string;

/** `git hash-object --no-filters <path>` — the ground truth, in the throwaway repo. */
function gitBlobSha(name: string, ...flags: string[]): string {
  return execFileSync("git", ["-C", repo, "hash-object", ...flags, name]).toString().trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "coltrane-blob-sha-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  for (const [name, bytes] of CORPUS) writeFileSync(join(repo, name), bytes);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("a blob sha is computed in process, and equals the one git computes", () => {
  // B1 — the corpus, one law per entry. The assertion is EQUALITY WITH GIT, not equality with a
  // hard-coded digest: a hard-coded digest proves only that the implementation did not change.
  for (const [name] of CORPUS) {
    it(`B1 — ${name}: the in-process blob sha equals \`git hash-object --no-filters\``, () => {
      const mine = blobShaOfFile(repo, name);
      expect(mine).toMatch(/^[0-9a-f]{40}$/);
      expect(mine).toBe(gitBlobSha(name, "--no-filters"));
    });
  }

  it("B2 — the corpus covers what it claims: empty, single byte, embedded NULs, CRLF, multi-chunk, no trailing newline, multibyte UTF-8", () => {
    const by = new Map(CORPUS.map(([n, b]) => [n, b]));
    expect(by.get("empty.txt")!.length).toBe(0);
    expect(by.get("one-byte.bin")!.length).toBe(1);
    expect(by.get("nuls.bin")!.includes(0x00)).toBe(true);
    expect(by.get("crlf.txt")!.includes(Buffer.from("\r\n"))).toBe(true);
    expect(by.get("no-trailing-newline.txt")!.at(-1)).not.toBe(0x0a);
    // multibyte: more bytes than code points
    const utf8 = by.get("utf8.txt")!;
    expect(utf8.length).toBeGreaterThan([...utf8.toString("utf8")].length);
    // and the large entry must take more than one pass of the chunk loop, with a ragged last chunk
    const large = by.get("large.bin")!;
    expect(large.length).toBeGreaterThan(CHUNK_BYTES * 2);
    expect(large.length % CHUNK_BYTES).not.toBe(0);
  });

  it("B3 — the empty file is git's well-known empty blob", () => {
    // The one digest worth hard-coding: e69de29… is git's empty blob in every repository there is,
    // so this law also catches a corpus that silently stopped being empty.
    expect(blobShaOfFile(repo, "empty.txt")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("B4 — a relative path resolves against tree_root, the way `git -C <tree_root> hash-object` resolves it", () => {
    // git resolves a hash-object path against the CWD it was given, NOT against the repository
    // root — so a tree_root naming a SUBDIRECTORY must pick the file beside it, not its namesake
    // one level up. Two files of the same name, different content, one at each level.
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "same-name.txt"), Buffer.from("at the root\n"));
    writeFileSync(join(repo, "sub", "same-name.txt"), Buffer.from("in the subdirectory\n"));

    const fromSub = blobShaOfFile(join(repo, "sub"), "same-name.txt");
    const fromRoot = blobShaOfFile(repo, "same-name.txt");
    expect(fromSub).not.toBe(fromRoot);
    expect(fromSub).toBe(execFileSync("git", ["-C", join(repo, "sub"), "hash-object", "--no-filters", "same-name.txt"]).toString().trim());
    expect(fromRoot).toBe(gitBlobSha("same-name.txt", "--no-filters"));
  });

  it("B5 — an absolute path is taken as given", () => {
    expect(blobShaOfFile(repo, join(repo, "utf8.txt"))).toBe(gitBlobSha("utf8.txt", "--no-filters"));
    // and tree_root is not consulted when the path is already absolute
    expect(blobShaOfFile(join(repo, "sub"), join(repo, "utf8.txt"))).toBe(gitBlobSha("utf8.txt", "--no-filters"));
  });

  it("B6 — a symlink is followed, as git follows it", () => {
    symlinkSync(join(repo, "utf8.txt"), join(repo, "link-to-utf8.txt"));
    expect(blobShaOfFile(repo, "link-to-utf8.txt")).toBe(blobShaOfFile(repo, "utf8.txt"));
    expect(blobShaOfFile(repo, "link-to-utf8.txt")).toBe(gitBlobSha("link-to-utf8.txt", "--no-filters"));
  });

  it("B7 — what has no blob sha THROWS, where git failed: absent, and not a regular file", () => {
    // Every caller of this helper is written around a throw (the change stamper lets it out as a
    // refusal; the fork's staleness check reads it as stale; the primer's blobFor records ""). A
    // plausible stand-in — "", or a sha of nothing — would be the silent-absence defect, so:
    expect(() => blobShaOfFile(repo, "no-such-file.txt")).toThrow();
    expect(() => execFileSync("git", ["-C", repo, "hash-object", "--no-filters", "no-such-file.txt"], { stdio: "pipe" })).toThrow();

    mkdirSync(join(repo, "a-directory"), { recursive: true });
    expect(() => blobShaOfFile(repo, "a-directory")).toThrow(/blob_sha_unhashable|EISDIR/);
    expect(() => execFileSync("git", ["-C", repo, "hash-object", "--no-filters", "a-directory"], { stdio: "pipe" })).toThrow();
  });

  it("B8 — for a repository with no attributes and no filters configured, this is ALSO bare `git hash-object`", () => {
    // THE BASIS FOR CALLING THIS A REFACTOR. `--no-filters` is what the arithmetic computes by
    // construction (B1). What makes the swap invisible to every caller is that on a plain
    // repository — no .gitattributes, nothing configured — bare `git hash-object` returns the
    // same string. This law drives the bare form over the WHOLE corpus, CRLF included, in a
    // repository this file created and never configured.
    for (const [name] of CORPUS) {
      expect(blobShaOfFile(repo, name)).toBe(gitBlobSha(name));
    }
  });
});
