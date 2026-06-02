// Root vitest config — runs only the fast unit suite; e2e lives behind `npm run e2e`.
// The e2e folder is excluded so the existing `verify` gate stays fast + green-or-honest.
//
// Coverage: opt-in via `vitest run --coverage`. Requires @vitest/coverage-v8 in
// devDependencies. Thresholds are intentionally absent on first land — measure
// the baseline first, gate on regressions later.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
