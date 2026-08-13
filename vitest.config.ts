// Root vitest config — runs only the fast unit suite; the other bands have their own configs
// and their own scripts, and `npm run verify` runs all of them:
//
//   vitest.config.ts (this file)          npm test / npm run verify
//   tests/failure_modes/vitest.config.ts  npm run test:failure-modes
//   tests/honest_broker/vitest.config.ts  npm run test:honest-broker
//   tests/security/vitest.config.ts       npm run test:security       (spend gated on COLTRANE_LIVE)
//   tests/e2e/vitest.config.ts            npm run e2e                 (needs a live claude CLI)
//   tests/e2e/vitest.offline.config.ts    npm run e2e:offline
//
// tests/test_band_wiring.test.ts enforces that table: every test file is claimed by some
// config, every config is run by some script, and every script runs somewhere in CI or is
// exempted in writing. Add a band → add a script → or that guard goes red (#262).
//
// The excludes below are DELEGATIONS, not omissions: each excluded directory is owned by the
// config named above. tests/security/** in particular is not "skipped" — it is a real band
// with a real script and a real CI job; leaving it in this config would spawn the live CLI
// inside the fast unit suite.
//
// Coverage: opt-in via `vitest run --coverage`. Requires @vitest/coverage-v8 in
// devDependencies. Thresholds are intentionally absent on first land — measure
// the baseline first, gate on regressions later.

import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Build dist/ once, before any file runs. Two pack-audit files each fired `npm pack`,
    // which fires `prepare` -> `npm run build`, and in parallel they raced on dist/ — one read
    // runtime.js mid-write and npm reported an unexpected EOF. See tests/_support/build_once.ts.
    globalSetup: ["tests/_support/build_once.ts"],
    // The suite must never seed the audit spine into the checkout. bootstrapServerDeps()
    // resolves its genome root to the repo (src/server.ts), several suites dispatch real gigs
    // through it, and the ledger now defaults to <root>/.coltrane/ledger.jsonl — so without
    // this the developer's working tree accumulates rows from every test run and they get
    // mistaken for real history. This is the "bootstrap honors a test override" half of the
    // fix; FileLedger's lazy construction is the other half.
    // Same reasoning for the two-tier output mirror: bootstrapServerDeps roots it at
    // <root>/.coltrane, so without an override a gig dispatched through a bootstrap-wired test
    // would seed Tier-1/Tier-2 files into the developer's checkout. Point it at a tmp dir.
    env: {
      COLTRANE_LEDGER_PATH: join(tmpdir(), "coltrane-test-ledger", "ledger.jsonl"),
      COLTRANE_MIRROR_DIR: join(tmpdir(), "coltrane-test-mirror"),
    },
    // #328 — the env above keeps the checkout clean but pointed every file at ONE ledger and ONE
    // mirror, so both grew across the run and `system_health`'s full scan of them became a function
    // of suite progress rather than of the test. This narrows the same protection to per-file, so a
    // scan is bounded by its own file's writes. See the setup file for the measurements.
    setupFiles: ["tests/_support/isolate_audit_spine.ts"],
    // tests/honest_broker/** is delegated to its own config (#262): those two specs boot a
    // subprocess MCP server over stdio, and their config declares testTimeout 120_000 +
    // singleFork for that reason. Running them here handed them vitest's 5s default and the
    // shared parallel pool instead — passing on luck, against the conditions their own config
    // says they need. One file, one config, run once.
    exclude: ["tests/e2e/**", "tests/security/**", "tests/honest_broker/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/test_topology.ts",
        "node_modules/**",
        "dist/**",
        "tests/**",
      ],
      all: true,
      clean: true,
    },
  },
});
