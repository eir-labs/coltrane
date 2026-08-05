// Test-only host for the relay: runs `runRelay` in THIS process (so process.stdin/stdout are
// the client pipe, exactly as in production) against an injected child entry path.
//
// Launched as `npx tsx tests/_support/relay_host.ts <entryPath>` — the same tsx-subprocess
// pattern tests/honest_broker and tests/failure_modes already use. Injecting the entry path
// is what lets a test point the relay at a child fixture that FAILS to boot without touching
// dist/ or spawning the real server.
import { runRelay } from "../../src/server_relay.js";

const entryPath = process.argv[2];
if (!entryPath) {
  process.stderr.write("relay_host: missing <entryPath> argv\n");
  process.exit(2);
}
await runRelay({ entryPath });
