// Parent-relay process for the Coltrane MCP server.
//
// The problem this solves: when Claude Code spawns the Coltrane server as an
// MCP child via stdio, it holds the pipe to that specific PID. Rebuilding
// `src/` produces new bytes in `dist/`, but the running PID is still executing
// the old bytes. Restarting the PID picks up the new bytes — and severs the
// stdio pipe Claude Code is holding, which ends the MCP connection for that
// conversation.
//
// The fix: a stdio-proxy parent that holds the pipe to Claude Code forever
// and spawns the actual Coltrane server as a *child*. To pick up new bytes,
// the relay kills the child and re-spawns it; the parent-side pipe never
// moves, so Claude Code's connection survives.
//
// Wire shape:
//   Claude Code ──stdio──> relay (this file) ──stdio──> child server
//                                  │
//                                  │  intercepts tools/call server_restart
//                                  │  (handles locally; kills+respawns child)
//                                  │
//                                  └─ augments tools/list responses with
//                                     server_restart entry
//
// The relay is invoked via `src/server_entry.ts` when COLTRANE_SERVER_DIRECT
// is unset. Setting COLTRANE_SERVER_DIRECT=1 runs the server directly (no
// relay) — the relay uses this to spawn its child.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";

type RelayChild = ChildProcessByStdio<Writable, Readable, null>;

const SERVER_RESTART_TOOL = {
  name: "server_restart",
  description:
    "Restart the Coltrane MCP server child process in place. Picks up new bytes after npm run build without ending the Claude Code conversation. Returns when the new child is up.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { name?: string; [k: string]: unknown };
  result?: unknown;
  error?: unknown;
}

/**
 * Spawn the actual Coltrane server as a child of this process, with the
 * direct-mode env flag set so `server_entry.ts` runs the server (not the
 * relay) inside it.
 */
function spawnChild(entryPath: string): RelayChild {
  return spawn(process.execPath, [entryPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, COLTRANE_SERVER_DIRECT: "1" },
  });
}

/**
 * Decide whether a parsed JSON-RPC message is a `tools/call` for
 * `server_restart`. Returns the call's id so the relay can reply with the
 * matching id when the restart completes.
 */
export function matchServerRestart(msg: JsonRpcMessage): string | number | null | undefined {
  if (msg.method !== "tools/call") return undefined;
  if (msg.params?.name !== "server_restart") return undefined;
  return msg.id ?? null;
}

/**
 * Decide whether a parsed JSON-RPC message is a *response* to a `tools/list`
 * request. The relay augments this response by appending `server_restart` to
 * the list so MCP clients can discover the relay-handled tool.
 */
export function isToolsListResponse(msg: JsonRpcMessage): boolean {
  if (msg.method !== undefined) return false; // responses have no method
  const result = msg.result as { tools?: unknown[] } | undefined;
  return Array.isArray(result?.tools);
}

/**
 * In-place augment a `tools/list` response so it carries an extra entry for
 * `server_restart`. Returns the mutated message for convenience.
 */
export function augmentToolsList(msg: JsonRpcMessage): JsonRpcMessage {
  const result = msg.result as { tools: unknown[] };
  // Don't double-insert if the child already advertises it.
  const existing = (result.tools as { name?: string }[]).some(
    (t) => t.name === SERVER_RESTART_TOOL.name,
  );
  if (!existing) result.tools.push(SERVER_RESTART_TOOL);
  return msg;
}

/**
 * Build the JSON-RPC response the relay returns when it has finished
 * restarting the child.
 */
export function buildRestartResponse(id: string | number | null): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: "Coltrane MCP server restarted. New child process is up and serving.",
        },
      ],
    },
  };
}

/** Parse the `initialize` request's id from a captured raw line (null if unparseable). */
export function initRequestId(line: string | null): string | number | null | undefined {
  if (!line) return undefined;
  try { return (JSON.parse(line) as JsonRpcMessage).id ?? null; } catch { return undefined; }
}

/**
 * Run the relay. Spawns the child, wires stdio, intercepts server_restart.
 * Never returns under normal operation.
 *
 * The MCP handshake survives a child swap: the client `initialize`d once (against the FIRST
 * child) and believes the session is live, so after a restart it sends `tools/call` straight
 * to a fresh child that never received `initialize`. An uninitialized MCP server holds the
 * call forever → the client hangs. So the relay CAPTURES the client's `initialize` request +
 * `notifications/initialized`, and REPLAYS them to every new child before un-gating it —
 * swallowing the replay's duplicate `initialize` response so the client never sees it twice.
 */
export async function runRelay(opts: { entryPath: string }): Promise<void> {
  let child = spawnChild(opts.entryPath);

  // Captured client handshake, replayed to each new child after a restart.
  let storedInit: string | null = null;
  let storedInitialized: string | null = null;
  // During a replay, the new child's `initialize` response carries the original request id;
  // the client already got one from the prior child, so the forwarder must swallow this dup.
  let replayInitId: string | number | null | undefined = undefined;
  let onInitReplayed: (() => void) | null = null;

  const forwardChildToParent = (c: RelayChild) => {
    const rl = createInterface({ input: c.stdout });
    rl.on("line", (line) => {
      let msg: JsonRpcMessage | null = null;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        process.stdout.write(line + "\n");
        return;
      }
      // Swallow the replayed-handshake `initialize` response (a response = no method, and its
      // id matches the captured initialize). Then send `notifications/initialized` so the new
      // child reaches serving state, and signal the restart to complete.
      if (msg && replayInitId !== undefined && msg.method === undefined && msg.id === replayInitId) {
        if (storedInitialized) c.stdin.write(storedInitialized + "\n");
        replayInitId = undefined;
        const done = onInitReplayed;
        onInitReplayed = null;
        done?.();
        return; // never forward the duplicate to the client
      }
      if (msg && isToolsListResponse(msg)) {
        augmentToolsList(msg);
        process.stdout.write(JSON.stringify(msg) + "\n");
        return;
      }
      // Pass through verbatim. Re-serializing would lose unknown fields.
      process.stdout.write(line + "\n");
    });
    c.on("exit", (code) => {
      process.stderr.write(`[coltrane-relay] child server exited code=${code ?? "null"}\n`);
    });
  };

  forwardChildToParent(child);

  const restartChild = async (): Promise<void> => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      // Give it 2s to exit cleanly; otherwise SIGKILL.
      await Promise.race([
        new Promise<void>((res) => child.once("exit", () => res())),
        new Promise<void>((res) =>
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            res();
          }, 2000),
        ),
      ]);
    }
    child = spawnChild(opts.entryPath);
    forwardChildToParent(child);
    // Replay the captured handshake so the new child reaches serving state BEFORE the relay
    // tells the client the restart is done. Without this the next tools/call hangs forever.
    if (storedInit) {
      await new Promise<void>((resolve) => {
        onInitReplayed = resolve;
        replayInitId = initRequestId(storedInit);
        child.stdin.write(storedInit + "\n");
        // Safety: if the new child never answers the handshake, don't wedge the relay forever.
        setTimeout(() => {
          if (onInitReplayed) {
            replayInitId = undefined;
            onInitReplayed = null;
            resolve();
          }
        }, 10_000);
      });
    }
  };

  const parentIn = createInterface({ input: process.stdin });
  parentIn.on("line", (line) => {
    let msg: JsonRpcMessage | null = null;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      child.stdin.write(line + "\n");
      return;
    }
    if (msg) {
      // Capture the handshake as it passes through (still forwarded to the first child).
      if (msg.method === "initialize") storedInit = line;
      else if (msg.method === "notifications/initialized") storedInitialized = line;

      const restartId = matchServerRestart(msg);
      if (restartId !== undefined) {
        // Handle locally. Reply only after the new child is up AND re-initialized, so the
        // client's next tool call lands on a serving child rather than hanging.
        void restartChild().then(() => {
          process.stdout.write(JSON.stringify(buildRestartResponse(restartId)) + "\n");
        });
        return;
      }
    }
    child.stdin.write(line + "\n");
  });

  // Keep the process alive while the child is up.
  await new Promise<void>(() => {
    /* never resolves; the relay runs forever */
  });
}
