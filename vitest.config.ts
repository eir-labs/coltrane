// Root vitest config — runs only the fast unit suite; e2e lives behind `npm run e2e`.
// The e2e folder is excluded so the existing `verify` gate stays fast + green-or-honest.
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
    // The suite must never seed the audit spine into the checkout. bootstrapServerDeps()
    // resolves its genome root to the repo (src/server.ts), several suites dispatch real gigs
    // through it, and the ledger now defaults to <root>/.coltrane/ledger.jsonl — so without
    // this the developer's working tree accumulates rows from every test run and they get
    // mistaken for real history. This is the "bootstrap honors a test override" half of the
    // fix; FileLedger's lazy construction is the other half.
    env: { COLTRANE_LEDGER_PATH: join(tmpdir(), "coltrane-test-ledger", "ledger.jsonl") },
    exclude: ["tests/e2e/**", "tests/security/**", "node_modules/**", "dist/**"],
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
