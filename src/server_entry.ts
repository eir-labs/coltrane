// Production stdio entry for the Coltrane MCP server.
//
// Two modes, branched on `COLTRANE_SERVER_DIRECT`:
//
//   • **relay mode (default)** — spawn `src/server_relay.ts` which holds the
//     parent stdio pipe to the MCP client forever and runs the actual server
//     as a child it can hot-restart in place. Picks up new bytes after
//     `npm run build` without ending the client conversation. See
//     `docs/mcp_hot_reload.md`.
//
//   • **direct mode** (`COLTRANE_SERVER_DIRECT=1`) — run the server itself,
//     connecting stdin/stdout straight to `StdioServerTransport`. Used by the
//     relay to spawn its child, and by any caller that wants the legacy
//     single-process behavior (e.g. e2e harness, debug scripts).
//
// `src/server.ts` is a library module: it *exports* runStdioServer() but
// never calls it, so `node dist/src/server.js` loads definitions and exits
// without connecting a transport. This file is the executable boot.

import { fileURLToPath } from "node:url";

const DIRECT = process.env.COLTRANE_SERVER_DIRECT === "1";

if (DIRECT) {
  const { runStdioServer } = await import("./server.js");
  runStdioServer().catch((e) => {
    console.error("coltrane MCP server failed to start:", e);
    process.exit(1);
  });
} else {
  const { runRelay } = await import("./server_relay.js");
  // Spawn the same script as the child, with COLTRANE_SERVER_DIRECT=1 so it
  // takes the other branch. Using `import.meta.url` ensures we re-launch the
  // exact same compiled entry path (works from `dist/` after build).
  const entryPath = fileURLToPath(import.meta.url);
  runRelay({ entryPath }).catch((e) => {
    console.error("coltrane MCP relay failed to start:", e);
    process.exit(1);
  });
}
