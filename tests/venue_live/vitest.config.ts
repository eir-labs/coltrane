// Live-room config — picks up the daemon-gated container laws. Separate from the root unit-suite
// config for the SAME reason tests/honest_broker has its own, and the root config already writes
// that reasoning down: a suite whose specs boot real subprocesses "handed vitest's 5s default and
// the shared parallel pool instead" is "passing on luck, against the conditions their own config
// says they need."
//
// These laws stand up REAL containers: compose up, docker exec, teardown. One run takes ~100s of
// wall clock on CI. Under the root config that produced a job which reported `Tests 7 passed` and
// then exited 1 on `[vitest-worker]: Timeout calling "onTaskUpdate"` — the reporter RPC timing out
// after every law had already passed. A job that fails AFTER passing is worse than one that fails,
// because it teaches the reader to discount red.
//
// singleFork + fileParallelism:false are not politeness. Two of these laws realize rooms
// CONCURRENTLY on purpose, and the compose project name derives from the gig id's first 8
// characters — parallel files racing the same daemon is how container-name collisions appear that
// have nothing to do with the code under test.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/spec_venue_room_live.test.ts"],
    // A single law realizes two rooms, execs into both, and tears both down; 240s is the wall the
    // slowest observed run (99.5s on CI) sits well inside, with room for a cold image cache.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    teardownTimeout: 120_000,
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
