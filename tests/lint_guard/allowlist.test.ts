// Allowlist guard test. Proves that the project's import-hygiene eslint
// config actually rejects a forbidden import shape (absolute path).
//
// Strategy:
//   1. Write a temp .ts source file under a temp dir with a forbidden import.
//   2. Invoke `npx eslint --no-eslintrc --config .eslintrc.json <tempfile>`.
//   3. Assert: non-zero exit AND the violation is named in the output.
//
// If eslint is not available locally (the project does not ship eslint as
// a devDependency by design), the test logs a skip notice and exits early.
// CI installs eslint workflow-locally and runs this test for full coverage.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..");
const CONFIG = join(REPO_ROOT, "eslint.config.js");
// Flat config requires fixtures to live under the config's base path
// (the project root). Place them under a gitignored scratch dir within the
// project, not under the OS tmpdir.
const SCRATCH_ROOT = join(REPO_ROOT, "tests", "lint_guard", ".scratch");
mkdirSync(SCRATCH_ROOT, { recursive: true });

function eslintAvailable(): boolean {
  const probe = spawnSync("npx", ["--no-install", "eslint", "--version"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return probe.status === 0;
}

describe("import allowlist", () => {
  it("rejects an absolute-path import", () => {
    if (!eslintAvailable()) {
      // eslint is not a project devDependency. CI installs it workflow-locally.
      // Locally, install with: npm install --no-save eslint@^9
      console.warn(
        "eslint not installed; skipping subprocess assertion. " +
          "Install with: npm install --no-save eslint@^9",
      );
      return;
    }

    const dir = mkdtempSync(join(SCRATCH_ROOT, "case-"));
    try {
      const fixture = join(dir, "fixture.ts");
      // Forbidden: absolute path. The allowlist rejects `/**` patterns.
      writeFileSync(
        fixture,
        'import { x } from "/usr/local/lib/external";\nexport const y = x;\n',
      );

      const result = spawnSync(
        "npx",
        [
          "--no-install",
          "eslint",
          "--config",
          CONFIG,
          fixture,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );

      // eslint exits 1 when violations exist
      expect(result.status).not.toBe(0);
      const out = (result.stdout || "") + (result.stderr || "");
      // Either eslint surfaces the rule id or the custom message
      expect(out).toMatch(/no-restricted-imports|Imports must be relative/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a deep parent-traversal import", () => {
    if (!eslintAvailable()) {
      console.warn("eslint not installed; skipping subprocess assertion.");
      return;
    }

    const dir = mkdtempSync(join(SCRATCH_ROOT, "case-"));
    try {
      const fixture = join(dir, "fixture.ts");
      // Forbidden: 3+ levels of parent traversal escapes the project root.
      writeFileSync(
        fixture,
        'import { x } from "../../../external";\nexport const y = x;\n',
      );

      const result = spawnSync(
        "npx",
        [
          "--no-install",
          "eslint",
          "--config",
          CONFIG,
          fixture,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      const out = (result.stdout || "") + (result.stderr || "");
      expect(out).toMatch(/no-restricted-imports|Imports must be relative/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an in-tree relative import and a package-name import", () => {
    if (!eslintAvailable()) {
      console.warn("eslint not installed; skipping subprocess assertion.");
      return;
    }

    const dir = mkdtempSync(join(SCRATCH_ROOT, "case-"));
    try {
      const fixture = join(dir, "fixture.ts");
      writeFileSync(
        fixture,
        'import { z } from "zod";\nimport { local } from "./sibling.js";\nexport const y = { z, local };\n',
      );

      const result = spawnSync(
        "npx",
        [
          "--no-install",
          "eslint",
          "--config",
          CONFIG,
          fixture,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );

      // No restricted-import violation. (eslint may still warn about other
      // things like unresolved modules, but the no-restricted-imports rule
      // is what we are asserting on.)
      const out = (result.stdout || "") + (result.stderr || "");
      expect(out).not.toMatch(/no-restricted-imports/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
