// Gate: pack-manifest audit — asserts WHAT FILES `npm pack` would ship (issue #149).
//
// Runs `npm pack --dry-run --json` (no tarball written, nothing uploaded) and
// checks the produced manifest against an explicit allow/deny list. Codifies the
// pre-publish content gate so any drift in the shipped file set fails CI before
// a publish step is ever reached.
//
// RED-first: on the no-`files`-glob state the manifest carries tests/, src/,
// dist/tests/, vitest.config — the forbidden assertions fail honestly until the
// `files` array lands in package.json.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface PackEntry {
  path: string;
}
interface PackResult {
  files: PackEntry[];
}

let manifest: string[] = [];

// #231 — this hook was dying on "Hook timed out in 10000ms", vitest's DEFAULT hookTimeout,
// and the failure was indistinguishable from a genuine packaging break.
//
// It is not a hang. `npm pack` fires the `prepare` lifecycle, which is `npm run build`, which
// is a full `tsc`. Measured on this branch: 3.3s cold (no dist/), 3.1s warm, 5.6s with six
// competing tsc processes — and 12.76s was measured standalone on the machine that filed
// #231. The suite runs ~140 files across every core, so the loaded number is the one that
// matters, and 10s is inside the noise band of a build that legitimately costs 3-13s.
//
// So the hook is given a budget far above the real cost. This does NOT slow a real break
// down: a `tsc` error or a bad manifest makes execFileSync throw immediately: the only thing
// a generous timeout buys is that "packaging is broken" stops being spelled the same way as
// "the machine was busy".
const PACK_HOOK_TIMEOUT_MS = 120_000;

beforeAll(() => {
  // `npm pack --dry-run --json` enumerates the would-ship manifest without
  // writing a tarball or touching the registry. Deterministic + side-effect-free.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  const parsed = JSON.parse(out) as PackResult[];
  const first = parsed[0];
  if (!first) throw new Error("npm pack --dry-run returned an empty manifest");
  manifest = first.files.map((f) => f.path.replace(/^\.\//, ""));
}, PACK_HOOK_TIMEOUT_MS);

// Files that MUST be in the published tarball for the engine to function.
const REQUIRED: RegExp[] = [
  /^package\.json$/,
  /^README\.md$/i,
  /^LICENSE$/i,
  /^dist\/src\/server_entry\.js$/,
];

// Files that must NEVER ship — source, tests, scratch, repo-private state.
const FORBIDDEN: RegExp[] = [
  /^tests\//,
  /\.test\.ts$/,
  /\.test\.js$/,
  /^src\/.*\.ts$/,
  /^dist\/tests\//,
  /^tmp\//,
  /^scratch\//,
  /^\.coltrane\//,
  /^coverage\//,
  /^MEMORY\.md$/,
  /^READY_FOR_DEMO\.md$/,
  /tracking\.json$/,
  /^\.github\//,
  /^vitest\.config\./,
];

describe("pack-manifest — required entries present", () => {
  it.each(REQUIRED.map((re) => [re.source, re] as const))(
    "ships a file matching %s",
    (_src, re) => {
      expect(manifest.some((p) => re.test(p)), `no shipped path matches ${re}`).toBe(true);
    },
  );

  it("ships compiled engine code under dist/src", () => {
    expect(manifest.some((p) => /^dist\/src\/.*\.js$/.test(p))).toBe(true);
  });
});

describe("pack-manifest — forbidden entries absent", () => {
  it.each(FORBIDDEN.map((re) => [re.source, re] as const))(
    "ships no file matching %s",
    (_src, re) => {
      const hits = manifest.filter((p) => re.test(p));
      expect(hits, `forbidden entries present: ${hits.join(", ")}`).toEqual([]);
    },
  );
});

describe("pack-manifest — metadata", () => {
  function readPkg(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
  }

  it("declares a files glob or an .npmignore", () => {
    const pkg = readPkg();
    const hasFiles = Array.isArray(pkg.files) && (pkg.files as unknown[]).length > 0;
    const hasNpmignore = existsSync(join(REPO_ROOT, ".npmignore"));
    expect(hasFiles || hasNpmignore).toBe(true);
  });

  it("license is Apache-2.0", () => {
    expect(readPkg().license).toBe("Apache-2.0");
  });

  it("bin entry points at a file that exists in dist", () => {
    const bin = readPkg().bin as Record<string, string> | string | undefined;
    const entries = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(existsSync(join(REPO_ROOT, entry)), `bin target missing: ${entry}`).toBe(true);
    }
  });

  it("README + LICENSE present on disk", () => {
    expect(existsSync(join(REPO_ROOT, "README.md"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "LICENSE"))).toBe(true);
  });
});
