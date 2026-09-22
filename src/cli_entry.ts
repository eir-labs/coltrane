#!/usr/bin/env node
/**
 * `coltrane` — the bin shim. Keeps process concerns (argv slicing, streams, exit codes,
 * the stdio-server branch) out of `cli.ts`, which stays a pure function over an IO record
 * so the whole command surface is testable without spawning anything.
 */
import { runCli } from "./cli.js";

import { entryArgv } from "./bus_terminal.js";

// Bare `coltrane` in an interactive terminal opens the chat with the repo's chair; to a script or a pipe
// it stays bare (usage, exit 2) — see src/bus_terminal.ts entryArgv.
const argv = entryArgv(process.argv.slice(2), process.stdin.isTTY === true);

// `serve` is the MCP stdio server. It owns stdin/stdout for the life of the process, so it
// cannot share the request/response shape the other commands use — it branches before them,
// and before any deps are built, so the genome is loaded exactly once.
if (argv[0] === "chat") {
  // `chat` owns stdin for the life of the session, like `serve` — it branches before the request/response commands.
  const { runChatTerminal } = await import("./bus_terminal.js");
  process.exitCode = await runChatTerminal(argv.slice(1));
} else if (argv[0] === "serve") {
  const { runStdioServer } = await import("./server.js");
  await runStdioServer();
} else {
  const code = await runCli(argv, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}
