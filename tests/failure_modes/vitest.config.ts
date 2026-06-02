// Failure-mode vitest config — serialized + extended timeout for I/O-heavy tests.
// Lives outside the default suite (the root config matches *.test.ts; these are *.spec.ts).
// Run via: npx vitest run --config tests/failure_modes/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/failure_modes/**/*.spec.ts"],
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
