// Security suite vitest config — isolated tempdir per spec, serialized to
// avoid claude-CLI rate contention. Long timeouts to cover full sub-thread
// runs (model latency + MCP boot).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/security/**/*.spec.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
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
