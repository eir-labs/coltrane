#!/usr/bin/env node
/**
 * `coltrane` — the bin shim. Keeps process concerns (argv slicing, streams, exit codes,
 * the stdio-server branch) out of `cli.ts`, which stays a pure function over an IO record
 * so the whole command surface is testable without spawning anything.
 */
import { runCli } from "./cli.js";

const argv = process.argv.slice(2);

// `serve` is the MCP stdio server. It owns stdin/stdout for the life of the process, so it
// cannot share the request/response shape the other commands use — it branches before them,
// and before any deps are built, so the genome is loaded exactly once.
if (argv[0] === "serve") {
  const { runStdioServer } = await import("./server.js");
  await runStdioServer();
} else {
  const code = await runCli(argv, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}
