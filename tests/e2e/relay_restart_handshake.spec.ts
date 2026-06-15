// The relay survives a child swap: a tool call issued after server_restart MUST get a
// response, not hang forever.
//
// The bug (observed live, 2026-06-14, filed #170): the relay holds the client's stdio pipe
// and hot-swaps the child on server_restart, but never replayed the MCP `initialize`
// handshake to the new child. The client had initialized once (against the FIRST child) and
// believed the session was live, so its next `tools/call` landed on a fresh, uninitialized
// child that holds the call forever. The fix captures the client's initialize +
// notifications/initialized and replays them to each new child before un-gating it.
//
// This drives the REAL built relay over stdio (node dist/src/server_entry.js): initialize →
// server_restart → tools/call. Pre-fix the final call times out; post-fix it answers.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Writable, Readable } from "node:stream";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const RELAY_ENTRY = join(REPO, "dist", "src", "server_entry.js"); // requires `npm run build`

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

function rpc(child: Child) {
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const m = JSON.parse(line) as Record<string, unknown>;
      const id = m["id"];
      if (typeof id === "number" && pending.has(id)) { pending.get(id)!(m); pending.delete(id); }
    } catch { /* non-json */ }
  });
  return {
    request(id: number, method: string, params: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${method} id=${id} (no response — relay hung)`)), timeoutMs);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method: string, params: unknown): void {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

describe("relay restart replays the handshake (the next tool call does not hang)", () => {
  let child: Child | undefined;
  afterEach(() => { child?.kill("SIGKILL"); child = undefined; });

  it("initialize → server_restart → tools/call answers on the fresh child", async () => {
    child = spawn(process.execPath, [RELAY_ENTRY], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COLTRANE_GENOME: REPO },
    }) as Child;
    const c = rpc(child);

    const init = await c.request(1, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "relay-test", version: "0" },
    });
    expect(init["result"], "child failed to initialize").toBeDefined();
    c.notify("notifications/initialized", {});

    // hot-swap the child in place
    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    expect(JSON.stringify(restart["result"])).toMatch(/restart/i);

    // THE PROOF: a tool call after the swap gets a response. Pre-fix this rejects on timeout
    // because the new child never received `initialize` and holds the call forever.
    const health = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    expect(health["result"], "post-restart tool call hung — handshake was not replayed").toBeDefined();

    // and it still works a second restart later (handshake is replayed every swap)
    await c.request(4, "tools/call", { name: "server_restart", arguments: {} });
    const health2 = await c.request(5, "tools/call", { name: "system_health", arguments: {} });
    expect(health2["result"]).toBeDefined();
  }, 120_000);
});
