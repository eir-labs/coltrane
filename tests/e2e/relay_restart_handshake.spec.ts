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
import { GRACEFUL_EXIT_TIMEOUT_MS } from "../../src/server_relay.js";

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

  // ── the replacement has to still be there ────────────────────────────────
  // The test above passed roughly 9 runs in 10. The tenth hung on that last call, and the
  // cause was not the harness — it was the relay SIGKILLing the very child it had just
  // reported as serving.
  //
  // `restartChild` raced the outgoing child's `exit` against a 2s escalation timer.
  // `Promise.race` discards the loser's value but does not cancel it, and the timer closed
  // over the mutable `child` binding rather than the process it was armed for. On the ordinary
  // path — old child exits promptly, exit branch wins — the timer stayed armed, fired 2s
  // later, read `child` (by then the healthy REPLACEMENT), found it alive, and killed it.
  //
  // So every restart destroyed its own successor about two seconds after answering "New child
  // process is up and serving". Which symptom you got depended only on where the next call
  // landed relative to the exit being reaped: `buildNoChildError`, telling you to restart a
  // client that had just restarted successfully — or a write into a dying pipe, silently
  // discarded, hanging forever. #260 made a FAILED swap reportable; this made a SUCCESSFUL
  // one fatal, which is exactly why it hid behind it.
  //
  // The test above could only catch it by accident, because it finishes inside the 2s window
  // on any reasonably quick machine. This one waits the window out on purpose.
  it("the child a restart reports as serving is still alive after the kill window", async () => {
    child = spawn(process.execPath, [RELAY_ENTRY], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COLTRANE_GENOME: REPO },
    }) as Child;
    const c = rpc(child);

    await c.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "relay-test", version: "0" },
    });
    c.notify("notifications/initialized", {});

    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    expect(restart["error"], "the restart must succeed for this test to mean anything").toBeUndefined();

    // Sit idle across the escalation window — a stale timer from the swap fires in here.
    await new Promise((r) => setTimeout(r, GRACEFUL_EXIT_TIMEOUT_MS + 1_500));

    const health = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    // Both failure shapes are caught. An `error` means the relay found no live child — it had
    // killed it. A timeout means the write went into a dying pipe. Only a real result proves
    // the replacement survived its own restart.
    expect(
      health["error"],
      `the relay killed the child it had just reported as serving: ${JSON.stringify(health["error"])}`,
    ).toBeUndefined();
    expect(health["result"], "no result and no error — the call vanished into a dead pipe").toBeDefined();
  }, 120_000);
});
