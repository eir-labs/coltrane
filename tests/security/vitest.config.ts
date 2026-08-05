// Security suite vitest config — isolated tempdir per spec, serialized to
// avoid claude-CLI rate contention. Long timeouts to cover full sub-thread
// runs (model latency + MCP boot).
//
// Run it: `npm run test:security` — collects the band and reports it skipped, at zero cost.
// `COLTRANE_LIVE=1 npm run test:security` spawns the real CLI and spends. `npm run verify`
// and the `security` CI job both invoke the un-gated form, so the band executes and is
// visible on every run. See prompt_injection.spec.ts's cost-gate header for why a security
// suite that nothing invoked was worse than no suite at all (#263).

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
