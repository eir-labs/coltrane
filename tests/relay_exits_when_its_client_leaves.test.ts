// RED — the stdio relay exits when its client leaves, and takes its server child with it.
//
// FOUND LIVE on 2026-09-17: a law-drafting gig was killed by the OS for low memory. The machine
// held 3,412 node processes using 11GB, and ~2,200 of them were `tests/_support/relay_host.ts`
// hosts, 1,976 of them more than a day old, orphaned to pid 1. Two faults compound:
//
//   · src/server_relay.ts listens for `line` on process.stdin and nothing else. When the client
//     closes the pipe, the relay keeps running, and its live server child keeps it running.
//     A client that exits without signalling the process tree leaves a relay and a server behind.
//   · the relay suites spawn `npx tsx relay_host.ts` and SIGKILL `npx` alone, so the tsx loader
//     and the relay under it survive every run, and every suite run adds to the pile.
//
// The law is the first fault: EOF on the client pipe ends the relay and its child. It spawns the
// host in its own process group and kills the whole group in teardown, so while it is RED it
// does not leak the very processes it is about.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable, Readable } from "node:stream";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_HOST = join(REPO_ROOT, "tests", "_support", "relay_host.ts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

/** A server child that answers requests and records its pid, so the law can ask whether it outlived the relay. */
function childFixture(dir: string): { entry: string; pidFile: string } {
  const entry = join(dir, "entry.mjs");
  const pidFile = join(dir, "child.pid");
  writeFileSync(entry, [
    'import { writeFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "const rl = createInterface({ input: process.stdin });",
    'rl.on("line", (line) => {',
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.id === undefined || m.method === undefined) return;",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true } }) + "\\n");',
    "});",
    // Keep the server alive on its own, the way a real server with open handles is.
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n"));
  return { entry, pidFile };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const exitedWithin = (child: Child, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });

describe("the relay does not outlive its client", () => {
  let host: Child | undefined;
  let dir: string | undefined;
  let childPid: number | undefined;

  afterEach(() => {
    // The whole group: tsx's loader, the relay, and anything the relay spawned into it.
    if (host?.pid) { try { process.kill(-host.pid, "SIGKILL"); } catch { /* already gone */ } }
    if (childPid && alive(childPid)) { try { process.kill(childPid, "SIGKILL"); } catch { /* gone */ } }
    host = undefined;
    childPid = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("closing the client pipe ends the relay and its server child", async () => {
    dir = mkdtempSync(join(tmpdir(), "coltrane-relay-eof-"));
    const { entry, pidFile } = childFixture(dir);

    host = spawn(TSX, [RELAY_HOST, entry], { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], detached: true }) as Child;
    host.stderr.resume();

    // Prove the relay is serving through a live child before the client leaves.
    const answered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 60_000); // pays the tsx cold start
      createInterface({ input: host!.stdout }).on("line", (line) => {
        try { if ((JSON.parse(line) as { id?: number }).id === 1) { clearTimeout(timer); resolve(true); } } catch { /* non-json */ }
      });
      host!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "relay-eof-test", version: "0" },
      } }) + "\n");
    });
    expect(answered, "the relay never answered initialize — fixture problem, not the law under test").toBe(true);
    expect(existsSync(pidFile), "the server child never booted").toBe(true);
    childPid = Number(readFileSync(pidFile, "utf8"));

    // The client leaves.
    host.stdin.end();

    expect(
      await exitedWithin(host, 15_000),
      "the relay kept running after its client closed the pipe. It listens for `line` on stdin and " +
        "never for its end, so every client that leaves without killing the tree leaves a relay behind",
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(childPid), "the relay exited but left its server child running").toBe(false);
  }, 90_000);
});
