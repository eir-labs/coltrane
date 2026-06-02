// e2e vitest config — isolated tempdir per test, no parallelism (avoid tempdir bleed),
// 5min per-test timeout to cover the cold-start ramp.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.spec.ts"],
    testTimeout: 300_000, // 5 min — accommodates eng_mgr cold-start budget
    hookTimeout: 600_000, // setupTempdirColtrane copies repo
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // serialize: each test gets full tempdir isolation
      },
    },
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
