#!/usr/bin/env node
// A scriptable stand-in for the `claude` CLI.
//
// WHY: the invoker's real delivery path — spawnStreaming → finalText → extractJson
// (src/claude_invoker.ts:324-325) — has zero coverage, because every existing invoker
// test injects `opts.run`, which short-circuits at :319 before the streaming path ever
// runs (issue #222). Injecting `run` therefore cannot test the bug; only a real spawn
// can. This fixture is that spawn: it ignores argv entirely (so it tolerates the cage
// flags buildInvokerArgs appends) and emits exactly the bytes the test scripts.
//
// Contract (env, because makeClaudeInvoker spawns with the inherited environment and
// exposes no seam for child env):
//   FAKE_CLAUDE_STDOUT_B64  base64 of the exact stdout to emit (byte-exact: the
//                           presence or absence of a trailing newline is meaningful —
//                           see issue #224)
//   FAKE_CLAUDE_STDERR_B64  base64 of stderr to emit (optional)
//   FAKE_CLAUDE_EXIT        process exit code (default 0)
//   FAKE_CLAUDE_SLEEP_MS    delay before emitting anything (default 0) — used to prove
//                           the absence of a spawn timeout in issue #225
//   FAKE_CLAUDE_TRAP_SIGTERM  when "1", swallow SIGTERM. A spawn bound that kills with
//                           SIGTERM cannot reap this child; only SIGKILL can. This is what
//                           makes the #225 elapsed-time assertion discriminating —
//                           measured: execFileSync{timeout:300} against a trapping child
//                           throws ETIMEDOUT only after the child's full 2063ms lifetime,
//                           versus 305ms with killSignal "SIGKILL".
//
// CONCURRENCY WARNING: scripting is process-level env. Safe under the current vitest pool
// (forked, isolated, sequential tests within a file); would SILENTLY RACE if anyone adds
// `.concurrent` to a describe/it in a file using this fixture.
//
// No cost, no network, no `claude` binary required.

const decode = (name) => Buffer.from(process.env[name] ?? "", "base64").toString("utf8");

const stdout = decode("FAKE_CLAUDE_STDOUT_B64");
const stderr = decode("FAKE_CLAUDE_STDERR_B64");
const exitCode = Number(process.env["FAKE_CLAUDE_EXIT"] ?? "0");
const sleepMs = Number(process.env["FAKE_CLAUDE_SLEEP_MS"] ?? "0");

// A signal-trapping child: SIGTERM is swallowed, so only SIGKILL can reap it.
if (process.env["FAKE_CLAUDE_TRAP_SIGTERM"] === "1") process.on("SIGTERM", () => {});

function emit() {
  if (stderr) process.stderr.write(stderr);
  // Exit from the write callback so the pipe is flushed first — process.exit() can
  // truncate a pending stdout write.
  process.stdout.write(stdout, () => process.exit(exitCode));
}

if (sleepMs > 0) setTimeout(emit, sleepMs);
else emit();
