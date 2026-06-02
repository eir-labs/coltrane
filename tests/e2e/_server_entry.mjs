// e2e MCP server entry — invokes the in-repo runStdioServer.
// Used by the harness to spin up coltrane-oss MCP from a tempdir clone.
import { runStdioServer } from "../../src/server.js";
runStdioServer().catch((e) => {
  console.error("coltrane MCP server failed to start:", e);
  process.exit(1);
});
