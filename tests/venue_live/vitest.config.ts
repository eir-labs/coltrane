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
    // THREADS, NOT FORKS — because a forked worker could not reach the main process reliably.
    //
    // Under `pool: "forks"` with `singleFork`, EVERY run of this band emitted
    // `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` while all laws passed. Measured
    // 2026-08-20: constant locally with both `verbose` and `default` reporters, and present in CI.
    // What varied was only whether it made the process exit NON-ZERO — once in 15 CI runs, which
    // read as a ~7% flaky test and is not what it was. The laws were never flaky; the reporter RPC
    // was, and its effect on the exit code was nondeterministic.
    //
    // That is why "reduce reporter chatter" was tried first and FAILED: the error is not a function
    // of how much is sent. It is the fork's RPC channel back to the main process, under a run whose
    // work is 80+ seconds of real container startup and teardown.
    //
    // `threads` changes that channel entirely. Verified by absence, which is possible precisely
    // because the error was CONSTANT rather than intermittent: three consecutive runs, zero errors,
    // against a baseline that errored every time. `singleThread` preserves what `singleFork` was
    // for — this band stands up real containers and must not run its files in parallel.
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
