// #260 — the release-blocking hang: `server_restart` whose new child never comes up.
//
// tests/e2e/relay_restart_handshake.spec.ts pins the HAPPY path (the handshake is replayed, so
// the next tools/call answers). It cannot see the failure path, and the failure path is where
// the 30-second hang lived:
//
//   restartChild()'s handshake-replay safety timer called the SAME resolve() the real
//   handshake did. So "the new child answered initialize" and "the new child is a corpse"
//   both ended in buildRestartResponse — the relay told the client "New child process is up
//   and serving" over a process that had already exited. Every request after that was written
//   into a dead pipe, silently discarded, and never answered: an UNBOUNDED wait that surfaced
//   as whatever client timeout ran out first (30s, in the e2e harness).
//
// This is not a hypothetical child. The relay re-spawns from dist/, which is exactly the
// directory it exists to let you rewrite underneath it — `npm run build` mid-session, a
// half-written dist, `npm pack` firing the `prepare` script. "The fresh bytes don't boot" is
// a first-class outcome of a hot restart.
//
// No model, no cost, no dist: the child is a node fixture that answers JSON-RPC on its first
// boot and refuses to start on its second, and the relay runs under tsx from src/.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable, Readable } from "node:stream";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_HOST = join(REPO_ROOT, "tests", "_support", "relay_host.ts");

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * A stand-in for the coltrane server child. Boot 1 speaks just enough JSON-RPC to complete an
 * MCP handshake and answer a tools/call. Boot 2+ dies immediately — the stale/broken-dist case.
 * The boot number is counted through a file because each boot is a separate process.
 */
function childFixture(dir: string): string {
  const entry = join(dir, "entry.mjs");
  const counter = join(dir, "boots");
  writeFileSync(entry, [
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `const counter = ${JSON.stringify(counter)};`,
    'const boots = existsSync(counter) ? Number(readFileSync(counter, "utf-8")) : 0;',
    "writeFileSync(counter, String(boots + 1));",
    "if (boots >= 1) {",
    '  process.stderr.write("fixture: this boot cannot start (stale dist)\\n");',
    "  process.exit(1);",
    "}",
    "const rl = createInterface({ input: process.stdin });",
    'rl.on("line", (line) => {',
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.id === undefined || m.method === undefined) return; // notification",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true, method: m.method } }) + "\\n");',
    "});",
    "",
  ].join("\n"));
  return entry;
}

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
    request(id: number, method: string, params: unknown, timeoutMs = 20_000): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout: ${method} id=${id} — the relay never answered (HANG)`)),
          timeoutMs,
        );
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method: string, params: unknown): void {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
  };
}

describe("#260 — a restart whose new child cannot boot ANSWERS, it does not hang", () => {
  let host: Child | undefined;
  let dir: string | undefined;
  afterEach(() => {
    host?.kill("SIGKILL");
    host = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("server_restart returns a JSON-RPC error, and the next call is answered too", async () => {
    dir = mkdtempSync(join(tmpdir(), "coltrane-relay-fail-"));
    const entry = childFixture(dir);

    host = spawn("npx", ["tsx", RELAY_HOST, entry], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    }) as Child;
    // Drain stderr — an unread stderr pipe is its own deadlock, and the relay logs on it.
    host.stderr.resume();
    const c = rpc(host);

    // Boot 1 serves normally.
    const init = await c.request(1, "initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "relay-fail-test", version: "0" },
    }, 60_000); // first request pays the tsx cold start
    expect(init["result"], "the first child failed to initialize — fixture problem, not the assertion under test").toBeDefined();
    c.notify("notifications/initialized", {});

    // The swap: boot 2 exits 1 instead of serving.
    const restart = await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    expect(
      restart["result"],
      "the relay answered a FAILED swap with a success result. buildRestartResponse says " +
        "'New child process is up and serving' — over a child that exited before it ever " +
        "answered initialize. That claim is what made the next call hang.",
    ).toBeUndefined();
    expect(restart["error"], "a failed restart must come back as a JSON-RPC error").toBeDefined();
    expect(String((restart["error"] as { message: string }).message)).toMatch(/restart FAILED/i);

    // THE PROOF: the call after a failed swap is ANSWERED. Pre-fix it was written into the
    // dead child's stdin, discarded, and never replied to — the client waited forever.
    const after = await c.request(3, "tools/call", { name: "system_health", arguments: {} });
    expect(
      after["error"],
      "a request with no live child behind it must be answered with an error, not dropped " +
        "into a dead pipe. A dropped request is an unbounded hang for the caller.",
    ).toBeDefined();
    expect(after["result"]).toBeUndefined();
  }, 120_000);

  it("fails fast on a dead child instead of waiting out the handshake timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "coltrane-relay-fail-fast-"));
    const entry = childFixture(dir);

    host = spawn("npx", ["tsx", RELAY_HOST, entry], {
      cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"],
    }) as Child;
    host.stderr.resume();
    const c = rpc(host);

    await c.request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 60_000);
    c.notify("notifications/initialized", {});

    const started = Date.now();
    await c.request(2, "tools/call", { name: "server_restart", arguments: {} });
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      `the swap took ${elapsed}ms. HANDSHAKE_REPLAY_TIMEOUT_MS is 10s; a child that has ` +
        "already EXITED is known-dead the moment its exit event fires, so sitting out the " +
        "full safety timeout only delays the diagnosis by 10 seconds.",
    ).toBeLessThan(9_000);
  }, 120_000);
});
