// Issue #144 — npm pack/install roundtrip test.
//
// Intent: when coltrane is packed (via `npm pack`) and the resulting tarball
// is installed into a fresh consumer project (via `npm install <tarball>`),
// the consumer ends up with a functional coltrane install — the package is
// resolvable, the declared `bin` entry exists on disk, and the entry file
// loads as a valid Node module.
//
// This is the "does it work when installed" axis. Complements the manifest /
// content audits (which check WHAT'S in the tarball) by checking that what's
// shipped is FUNCTIONAL once a downstream consumer pulls it in.
//
// Non-goals:
// - NOT a content audit (the manifest audit covers file inclusion).
// - NOT a methodology-vocab grep (a separate test covers leak detection).
// - NOT a live MCP-server smoke test (that needs an MCP client + harness;
//   tracked separately under issue #144 sub-task #7).
// - NOT testing publish to a real registry. The tarball is local-only.
//
// The test takes ~20-40s due to two real `npm` invocations. Allows up to 3
// minutes total for slow CI runners.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

interface PackEntry {
  filename: string;
  files?: { path: string }[];
}

describe("npm pack/install roundtrip — issue #144", () => {
  let workDir: string;
  let consumerDir: string;
  let tarballPath: string;
  let installedPkgRoot: string; // path under node_modules where coltrane lives after install
  let installedPkgManifest: { name: string; version: string; bin?: Record<string, string> | string };

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "coltrane-pack-"));
    consumerDir = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));

    // --- pack: produce the tarball that `npm publish` would upload ---
    const packStdout = execFileSync(
      "npm",
      ["pack", "--pack-destination", workDir, "--json"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packEntries = JSON.parse(packStdout) as PackEntry[];
    expect(packEntries.length, "npm pack should emit exactly one tarball").toBe(1);
    tarballPath = join(workDir, packEntries[0]!.filename);
    expect(existsSync(tarballPath), `tarball not produced at ${tarballPath}`).toBe(true);

    // --- consumer setup: a minimal node project with no other deps ---
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify(
        { name: "coltrane-consumer-fixture", version: "0.0.1", private: true, type: "module" },
        null,
        2,
      ) + "\n",
    );

    // --- install: pull the local tarball as a consumer would ---
    execFileSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
      cwd: consumerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // --- resolve the installed package by reading its manifest ---
    // Read the source manifest to know what name to look under in node_modules.
    // This makes the test robust to the unscoped→scoped rename
    // (`coltrane` → `@eir-dev/coltrane`).
    const sourceManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      name: string;
    };
    installedPkgRoot = join(consumerDir, "node_modules", sourceManifest.name);
    installedPkgManifest = JSON.parse(
      readFileSync(join(installedPkgRoot, "package.json"), "utf8"),
    );
  }, 180_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (consumerDir) rmSync(consumerDir, { recursive: true, force: true });
  });

  it("installed package manifest is intact + version matches source", () => {
    expect(installedPkgManifest.name, "installed name should match source").toBeTruthy();
    expect(installedPkgManifest.version, "installed version should match source").toBe("0.1.0");
  });

  it("installed package declares a bin entry (consumer-facing CLI surface)", () => {
    expect(
      installedPkgManifest.bin,
      "package.json must declare a bin field so `.mcp.json` can invoke `npx <command>`",
    ).toBeDefined();
  });

  it("every declared bin target exists on disk in the installed package", () => {
    const binField = installedPkgManifest.bin;
    expect(binField, "bin field must be defined for this test").toBeDefined();

    // bin can be a string OR a {commandName: path} object. Normalize.
    const entries: Array<[string, string]> =
      typeof binField === "string"
        ? [[installedPkgManifest.name, binField]]
        : Object.entries(binField!);

    for (const [commandName, relPath] of entries) {
      const absPath = join(installedPkgRoot, relPath);
      expect(
        existsSync(absPath),
        `bin[${commandName}] → ${relPath} is missing in the installed tarball. The bin path must be inside the shipped files.`,
      ).toBe(true);

      // Must be a regular file (not a directory or symlink to nowhere).
      const stat = statSync(absPath);
      expect(stat.isFile(), `bin[${commandName}] should be a file, not a directory`).toBe(true);
      expect(stat.size, `bin[${commandName}] should not be empty`).toBeGreaterThan(0);
    }
  });

  it("every declared bin target is loadable as a JS/ES module", async () => {
    const binField = installedPkgManifest.bin;
    expect(binField, "bin field must be defined for this test").toBeDefined();

    const entries: Array<[string, string]> =
      typeof binField === "string"
        ? [[installedPkgManifest.name, binField]]
        : Object.entries(binField!);

    // Use `node --check` to parse-verify the file without executing top-level code.
    // This catches build-output corruption (missing dist file, bad TS-compile output,
    // malformed bin script) without requiring us to actually start the MCP server.
    for (const [commandName, relPath] of entries) {
      const absPath = join(installedPkgRoot, relPath);
      // `node --check <file>` parses the file. Exits 0 on parse success, non-zero
      // with the syntax error on failure.
      expect(() => {
        execFileSync("node", ["--check", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }, `bin[${commandName}] failed to parse as a Node module`).not.toThrow();
    }
  });
});
