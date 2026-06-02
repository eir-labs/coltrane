// Root vitest config — runs only the fast unit suite; e2e lives behind `npm run e2e`.
// The e2e folder is excluded so the existing `verify` gate stays fast + green-or-honest.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
  },
});
