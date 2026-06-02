// Honest-broker config — picks up tests/honest_broker/*.spec.ts. Separate from
// the root unit-suite config so the discipline is named at the directory level.
// Subprocess MCP boots use single-fork to avoid stdin/stdout interleaving.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/honest_broker/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
