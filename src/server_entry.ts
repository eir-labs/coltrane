// Production stdio entry for the coltrane MCP server.
//
// `src/server.ts` is a library module: it *exports* runStdioServer() but never
// calls it, so `node dist/src/server.js` loads definitions and exits without
// connecting a transport. This file is the executable boot — an MCP client
// (Claude Code, Cursor) spawns it and speaks JSON-RPC over stdio.
//
// Mirrors tests/e2e/_server_entry.mjs (the e2e harness boot), but compiled so a
// real client runs `node dist/src/server_entry.js` with no tsx dependency.
import { runStdioServer } from "./server.js";

runStdioServer().catch((e) => {
  console.error("coltrane MCP server failed to start:", e);
  process.exit(1);
});
