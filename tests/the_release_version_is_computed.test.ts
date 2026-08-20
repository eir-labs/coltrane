// RED-first — the release version is COMPUTED from the commits, never remembered by a human.
//
// THE DEFECT, measured. 0.11.0 published at 07:09 on 2026-08-20. Ten commits merged to main after
// it — including #466, the fix that unblocked the Fly drain, and #464, `coltrane enqueue`. None of
// them reached npm. Verified against the published tarball, not inferred:
//
//   npm pack @eir-labs/coltrane@0.11.0
//   grep -c resolveWorkingRepo   package/dist/src/worker.js          → 0
//   grep -c attemptedWriteBoundary package/dist/src/claude_invoker.js → 0
//   grep -c enqueue              package/dist/src/cli.js             → 0
//
// Nothing was broken. publish.yml runs on every push to main and does exactly what it says: it
// publishes IFF package.json's version is not already on npm. Nobody bumped it, so ten merges each
// ran the workflow, checked, and correctly no-op'd. The gate worked; the input to it rotted.
//
// This is the repo's own north star turned on its release process: "a rule that cannot fail is
// remembered, not enforced", and "status and inventory claims rot silently". package.json's version
// is a status claim about the release, maintained by memory, checked by nothing. A test proves a
// mechanism WORKS; nothing was asking whether it is REACHED.
//
// THE FIX IS TO DELETE THE REMEMBERING. The semver intent is ALREADY in the repo — every commit here
// is conventional (`fix(worker):`, `feat(cli):`, `test(census):`). The information was never missing,
// only unread. So the version stops being a number someone maintains and becomes a function of the
// commits since the last tag.
//
// These laws drive the REAL script the workflow runs, as a subprocess, rather than a retyped copy of
// its logic — a test of a duplicate would pass while the thing CI executes drifts.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "next_version.mjs");

/** Run the real script the way publish.yml does: last tag as an arg, commit subjects on stdin. */
function nextVersion(last: string, subjects: string[]): string {
  return execFileSync("node", [SCRIPT, "--last", last], {
    input: subjects.join("\n"),
    encoding: "utf8",
  }).trim();
}

describe("the release version is computed from the commits", () => {
  it("V1 — a fix-only merge bumps the PATCH", () => {
    expect(nextVersion("v0.11.0", ["fix(worker): the repo is typed input"])).toBe("0.11.1");
  });

  it("V2 — any feat bumps the MINOR, and resets patch", () => {
    expect(nextVersion("v0.11.1", ["feat(cli): `coltrane enqueue`"])).toBe("0.12.0");
  });

  it("V3 — a breaking change bumps the MAJOR, by either notation", () => {
    expect(nextVersion("v0.11.0", ["feat(api)!: drop the legacy seal"])).toBe("1.0.0");
    expect(nextVersion("v0.11.0", ["fix(api): tighten\n\nBREAKING CHANGE: removed"])).toBe("1.0.0");
  });

  it("V4 — housekeeping still ships: every merge to main is a release", () => {
    // The stated policy. A test-only or chore-only merge changes what is IN the package, so it gets
    // a version. The alternative — silently not publishing — is the defect this file exists for.
    expect(nextVersion("v0.11.0", ["test(census): 63 → 64"])).toBe("0.11.1");
    expect(nextVersion("v0.11.0", ["chore: bump actions/checkout"])).toBe("0.11.1");
    expect(nextVersion("v0.11.0", ["docs: fix a typo"])).toBe("0.11.1");
  });

  it("V5 — the HIGHEST bump in the batch wins, not the first or the last", () => {
    const mixed = ["fix(a): one", "feat(b): two", "chore: three"];
    expect(nextVersion("v0.11.0", mixed)).toBe("0.12.0");
    expect(nextVersion("v0.11.0", [...mixed, "feat(c)!: four"])).toBe("1.0.0");
  });

  it("V6 — the tag is read with or without its `v`, so the tag convention can't break the release", () => {
    expect(nextVersion("0.11.0", ["fix: x"])).toBe("0.11.1");
    expect(nextVersion("v0.11.0", ["fix: x"])).toBe("0.11.1");
  });

  it("V7 — NOTHING to release is not 'release nothing': no commits exits non-zero and prints no version", () => {
    // publish.yml must be able to tell "no new commits" from "version 0.0.0". A script that printed
    // a version here would republish the same tree on every no-op push.
    let code = 0;
    let out = "";
    try {
      out = execFileSync("node", [SCRIPT, "--last", "v0.11.0"], { input: "", encoding: "utf8" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).not.toBe(0);
    expect(out.trim()).toBe("");
  });

  it("V8 — a malformed last tag REFUSES rather than inventing a version", () => {
    // An absent or garbled tag is exactly when a default is most dangerous: it would publish over
    // whatever 0.0.1 happens to be. Absent must mean DECLINE.
    let code = 0;
    try {
      execFileSync("node", [SCRIPT, "--last", "not-a-version"], { input: "fix: x", encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).not.toBe(0);
  });
});

describe("the stamp writes BOTH statements of the version, or none", () => {
  // The two copies are deliberate (see scripts/stamp_version.mjs): COLTRANE_VERSION is compiled into
  // dist and is what a VENDORED consumer reads at boot, where a package.json range says what npm was
  // asked for rather than what loaded. They cannot be collapsed without giving up that case — so they
  // are kept in lockstep by a machine, and these laws are the check that the machine did both.
  const STAMP = join(REPO_ROOT, "scripts", "stamp_version.mjs");

  /** Stamp a throwaway COPY of the repo's two files, so the laws never mutate the working tree. */
  function stampInSandbox(version: string): { pkg: string; ver: string; code: number } {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-stamp-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "scripts"));
    copyFileSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
    copyFileSync(join(REPO_ROOT, "src", "version.ts"), join(dir, "src", "version.ts"));
    copyFileSync(STAMP, join(dir, "scripts", "stamp_version.mjs"));
    let code = 0;
    try {
      execFileSync("node", [join(dir, "scripts", "stamp_version.mjs"), version], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    return {
      pkg: readFileSync(join(dir, "package.json"), "utf8"),
      ver: readFileSync(join(dir, "src", "version.ts"), "utf8"),
      code,
    };
  }

  it("S1 — one command moves package.json AND COLTRANE_VERSION to the same number", () => {
    const { pkg, ver, code } = stampInSandbox("9.9.9");
    expect(code).toBe(0);
    expect(JSON.parse(pkg).version).toBe("9.9.9");
    expect(ver).toContain('export const COLTRANE_VERSION = "9.9.9"');
  });

  it("S2 — a non-semver argument REFUSES, and writes nothing", () => {
    // This writes the number a consumer's boot handshake asserts against. A default here would ship
    // a lying identity rather than fail a build.
    const before = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
    const { pkg, code } = stampInSandbox("not-a-version");
    expect(code).not.toBe(0);
    expect(JSON.parse(pkg).version).toBe(before); // untouched
  });

  it("S3 — the stamped pair satisfies the identity law that guards the vendored handshake", () => {
    // The same assertion tests/version_identity.test.ts makes, asserted against the stamper's output:
    // whatever CI publishes, these two agree by construction rather than by anyone remembering.
    const { pkg, ver } = stampInSandbox("3.4.5");
    const fromPkg = JSON.parse(pkg).version as string;
    const m = /export const COLTRANE_VERSION = "([^"]+)"/.exec(ver);
    expect(m?.[1]).toBe(fromPkg);
  });
});
