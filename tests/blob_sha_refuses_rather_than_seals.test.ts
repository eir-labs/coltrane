// THE REFUSALS OF `blobShaOfFile`, EACH WITH A LAW THAT CAN GO RED.
//
// `tests/blob_sha_in_process.test.ts` is the equivalence proof — it pins that the arithmetic
// agrees with `git hash-object` over a corpus. It does NOT reach the helper's three refusals,
// and a non-author grade of the change measured exactly that: with BOTH mid-read length
// refusals deleted from `src/runtime.ts`, all 21 blob laws stayed green; with the
// `!stat.isFile()` refusal deleted, all 21 stayed green. The isFile guard survived because the
// only non-regular file any law drove was a DIRECTORY, and B7 forgave it with
// `/blob_sha_unhashable|EISDIR/` — `readSync` on a directory fd raises EISDIR by itself, so the
// alternation was satisfied whether the guard existed or not. Three refusals, zero laws:
// advertised behaviour that could not fail. This file is the close.
//
//   law  kind         drives                                    plant (observed red, then reverted)
//   R1   behavioural  blobShaOfFile — src/runtime.ts            delete the `read > size` throw
//   R2   behavioural  blobShaOfFile — src/runtime.ts            delete the `read !== size` throw
//   R3   behavioural  blobShaOfFile — src/runtime.ts            delete the `!stat.isFile()` throw
//
// WHY THE SIZE IS INJECTED RATHER THAN RACED. A length that moves under the read is a race, and
// the grade ran one: a child appending 256 KiB to an 8 MiB file while the helper folded it
// returned 9 clean values / 5 refusals / 0 torn values across 14 attempts. That proves the guard
// FIRES, but a law with a 9-in-14 verdict is a flaky law, and a flaky law is worse than none —
// it teaches the suite to be re-run until it agrees. The condition the guard actually tests is
// `fstat`'s size disagreeing with what the fd yields, so that is what these laws produce
// directly: `fstatSync` is mocked to under- or over-report the size of ONE call, everything else
// passing straight through. Deterministic, and it distinguishes the two refusals from each other
// — a lie LOW overruns mid-read (R1), a lie HIGH comes up short at the end (R2). The mock is off
// (`lie.size === undefined`) for every other call in this file and in the suite.
//
// WHY A CHARACTER DEVICE AND NOT A FIFO OR A SOCKET (all three measured here, on darwin):
//   · a FIFO with no writer BLOCKS IN `open` — `timeout 5 node` killed it; git blocks the same
//     way. A law that hangs is not a law.
//   · a unix socket cannot be opened at all (`openSync` → EOPNOTSUPP), so `open` refuses it
//     before the guard is ever reached — it would pass with the guard deleted.
//   · `/dev/null` opens, is a character device, and is the sharpest case there is: with the
//     guard deleted it does not throw and does not hang, it returns
//     e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 — git's empty blob. A PLAUSIBLE STAND-IN for a
//     thing that has no blob sha, sealed into a record as if it were an address. That is the
//     defect this repo names "absent must mean DECLINE", and R3 is the refusal of it.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** When set, the NEXT `fstatSync` reports this size instead of the real one. */
const lie = vi.hoisted(() => ({ size: undefined as number | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    // A PASSTHROUGH unless `lie.size` is set — the real stat, with one property answered
    // differently, so `isFile()` and every other reader still see the truth.
    fstatSync: ((fd: number, options?: unknown) => {
      const stat = (real.fstatSync as (f: number, o?: unknown) => ReturnType<typeof real.fstatSync>)(fd, options);
      if (lie.size === undefined) return stat;
      return new Proxy(stat, {
        get: (target, prop, receiver) => (prop === "size" ? lie.size : Reflect.get(target, prop, receiver)),
      });
    }) as typeof real.fstatSync,
  };
});

// Imported AFTER the mock is declared: vi.mock is hoisted, and this await-import is what makes
// the ordering explicit rather than implied.
const { blobShaOfFile } = await import("../src/runtime.js");

/** A throwaway directory with one file of known content. Returns [tree_root, name, byteLength]. */
function oneFile(content: string): [string, string, number] {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-blob-refusal-"));
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(join(dir, "subject.txt"), bytes);
  return [dir, "subject.txt", bytes.length];
}

/** Run `blobShaOfFile` with `fstat` reporting `size`, and put the truth back whatever happens. */
function withReportedSize<T>(size: number, run: () => T): T {
  lie.size = size;
  try {
    return run();
  } finally {
    lie.size = undefined;
  }
}

describe("a file whose length does not hold still, and a file that is not a file, are refused", () => {
  it("R1 — a file that yields MORE bytes than its own stat is refused mid-read, not folded into a sha", () => {
    const [dir, name, length] = oneFile("eight hundred and one\n");
    // The shape of a file that GREW after `fstat`: the fd keeps yielding past the stated end.
    const short = length - 5;
    expect(short).toBeGreaterThan(0);
    withReportedSize(short, () => {
      expect(() => blobShaOfFile(dir, name)).toThrow(/blob_sha_unhashable: .* grew while it was being hashed/);
    });
    // The lie is what causes it, and only the lie: the same file hashes cleanly on the next call.
    expect(lie.size).toBeUndefined();
    expect(blobShaOfFile(dir, name)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("R2 — a file that yields FEWER bytes than its own stat is refused at the end, not sealed short", () => {
    const [dir, name, length] = oneFile("eight hundred and two\n");
    // The shape of a file TRUNCATED after `fstat`: the fd runs out before the stated end. This one
    // is the more dangerous of the two — the loop simply ends, so without the guard a short read
    // returns a well-formed 40-hex string that is the sha of a prefix.
    const over = length + 4096;
    withReportedSize(over, () => {
      expect(() => blobShaOfFile(dir, name)).toThrow(
        new RegExp(`blob_sha_unhashable: .* is ${over} bytes by its own stat but only ${length} could be read`),
      );
    });
    expect(lie.size).toBeUndefined();
    expect(blobShaOfFile(dir, name)).toMatch(/^[0-9a-f]{40}$/);
  });

  // /dev/null is POSIX. This suite runs on ubuntu and macos (.github/workflows/test.yml); a
  // Windows runner would SKIP this law loudly rather than report a green it did not earn.
  it.skipIf(process.platform === "win32")(
    "R3 — a character device is refused BY NAME as not a regular file, never sealed as the empty blob",
    () => {
      // Deliberately NOT an alternation. The refusal has to be the helper's own, because every
      // other way this could throw (EISDIR on a directory read, EOPNOTSUPP opening a socket) is an
      // error the guard's absence would produce just as well — which is exactly how B7 came to
      // pass with the guard deleted.
      // Both path forms, since the refusal sits after the resolution: relative to a tree_root,
      // and absolute. The message must NAME the thing it refused.
      expect(() => blobShaOfFile("/dev", "null")).toThrow(/blob_sha_unhashable: \/dev\/null is not a regular file/);
      expect(() => blobShaOfFile("/", "/dev/null")).toThrow(/blob_sha_unhashable: \/dev\/null is not a regular file/);
      // The value it is refusing to return is git's empty blob — what the arithmetic yields for a
      // zero-length read — so a caller sealing it would hold an address to a file never read.
    },
  );
});
