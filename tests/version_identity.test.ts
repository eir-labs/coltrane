// The engine's version identity must be trustworthy, because a downstream asserts on it.
//
// coltrane is vendored as a git clone, not installed from npm, so the only handshake a
// consumer can perform at boot is "what version do you say you are?". If COLTRANE_VERSION
// drifts from package.json, that handshake starts lying — a consumer would happily boot
// against an engine it was never built for, and the failure resurfaces mid-gig. These
// tests make the drift a build failure instead.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COLTRANE_VERSION, coltraneBuildCommit, coltraneIdentity } from "../src/version.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("engine version identity", () => {
  it("COLTRANE_VERSION equals package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(COLTRANE_VERSION).toBe(pkg.version);
  });

  it("is a real semver, and is no longer the npm-init default", () => {
    expect(COLTRANE_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    // 0.1.0 sat unchanged across 100+ commits and named nothing. Never go back.
    expect(COLTRANE_VERSION).not.toBe("0.1.0");
  });

  it("is re-exported from the package entrypoint (the surface a consumer imports)", async () => {
    const entry = (await import("../src/index.js")) as Record<string, unknown>;
    expect(entry["COLTRANE_VERSION"]).toBe(COLTRANE_VERSION);
    expect(typeof entry["coltraneBuildCommit"]).toBe("function");
  });

  it("resolves a build commit from the engine checkout, or honestly returns null", () => {
    const commit = coltraneBuildCommit();
    if (commit !== null) expect(commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("COLTRANE_BUILD_COMMIT overrides checkout detection (the baked-image path)", () => {
    const prev = process.env["COLTRANE_BUILD_COMMIT"];
    process.env["COLTRANE_BUILD_COMMIT"] = "a".repeat(40);
    try {
      expect(coltraneBuildCommit()).toBe("a".repeat(40));
      expect(coltraneIdentity()).toEqual({ version: COLTRANE_VERSION, commit: "a".repeat(40) });
    } finally {
      if (prev === undefined) delete process.env["COLTRANE_BUILD_COMMIT"];
      else process.env["COLTRANE_BUILD_COMMIT"] = prev;
    }
  });
});
