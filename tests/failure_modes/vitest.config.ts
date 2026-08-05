// Failure-mode vitest config — serialized + extended timeout for I/O-heavy tests.
// Lives outside the default suite (the root config matches *.test.ts; these are *.spec.ts).
// Run via: npx vitest run --config tests/failure_modes/vitest.config.ts
import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  test: {
    include: ["tests/failure_modes/**/*.spec.ts"],
    // The suite must never seed the audit spine into the checkout. bootstrapServerDeps()
    // resolves its genome root to the repo (src/server.ts), several suites dispatch real gigs
    // through it, and the ledger now defaults to <root>/.coltrane/ledger.jsonl — so without
    // this the developer's working tree accumulates rows from every test run and they get
    // mistaken for real history. This is the "bootstrap honors a test override" half of the
    // fix; FileLedger's lazy construction is the other half.
    env: { COLTRANE_LEDGER_PATH: join(tmpdir(), "coltrane-test-ledger", "ledger.jsonl") },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
