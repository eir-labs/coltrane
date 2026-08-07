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

/** JSON-RPC implementation-defined server error (the -32000..-32099 reserved band). */
const RELAY_ERROR_CODE = -32001;

/**
 * Build the JSON-RPC ERROR the relay returns when a restart did NOT produce a serving child.
 *
 * The bug this closes (#260): `restartChild` could not fail. Its handshake-replay safety
 * timer resolved the SAME promise the real handshake did, so "the new child never answered"
 * and "the new child is serving" both ended in `buildRestartResponse` — the relay told the
 * client "New child process is up and serving" over a corpse. Every subsequent tools/call was
 * then written into a dead pipe and never answered: an UNBOUNDED hang, surfacing as whatever
 * client-side timeout ran out first. An error response is recoverable; a hang is not.
 */
export function buildRestartError(id: string | number | null, reason: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RELAY_ERROR_CODE,
      message:
        `Coltrane MCP server restart FAILED — ${reason}. The previous child was already ` +
        "stopped, so this server is now serving nothing. Check the relay's stderr, rebuild " +
        "(`npm run build`), and restart the MCP client.",
    },
  };
}

/**
 * Build the JSON-RPC ERROR for a request that arrived when no child is alive to answer it.
 * Without this the relay writes the request into a dead child's stdin, where it is silently
 * discarded and the caller waits forever.
 */
export function buildNoChildError(id: string | number | null, method: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RELAY_ERROR_CODE,
      message:
        `Coltrane MCP relay has no live server child — "${method}" cannot be answered. ` +
        "The child exited (see the relay's stderr for its exit code). Rebuild " +
        "(`npm run build`) and restart the MCP client.",
    },
  };
}

/** How long a fresh child gets to answer the replayed `initialize` before the restart FAILS. */
export const HANDSHAKE_REPLAY_TIMEOUT_MS = 10_000;

/** How long the OUTGOING child gets to honour SIGTERM before the relay escalates to SIGKILL. */
export const GRACEFUL_EXIT_TIMEOUT_MS = 2_000;

/** The outcome of one child swap. `ok: false` must reach the client — see buildRestartError. */
export type RestartOutcome = { ok: true } | { ok: false; reason: string };

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
 *
 * And a swap CAN fail — the new child is spawned from `dist/`, which the relay exists to let
 * you rewrite underneath it, so "the fresh bytes don't boot" is a first-class outcome, not an
 * impossibility. Every path out of this function answers the client: a failed swap returns a
 * JSON-RPC error, and any later request that arrives with no live child is answered with one
 * too. The relay never leaves a caller waiting on a process that is gone (#260).
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
    // A write into a child that has already exited raises EPIPE as an 'error' event; unhandled,
    // that takes the whole relay down and severs the client pipe the relay exists to protect.
    c.stdin.on("error", (e: Error) => {
      process.stderr.write(`[coltrane-relay] child stdin error: ${e.message}\n`);
    });
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

  const restartChild = async (): Promise<RestartOutcome> => {
    // `dying` is captured deliberately. `child` is reassigned a few lines below, and the
    // escalation timer must be able to reach exactly ONE process: the one it was armed for.
    //
    // It used to close over `child` instead, and `Promise.race` discards the loser's value but
    // does not cancel it — so on the ordinary path (old child exits promptly, the exit branch
    // wins) the timer stayed armed, fired 2s later, read the CURRENT `child`, found the
    // healthy replacement, and SIGKILLed it. Every restart killed the process it had just
    // reported as serving. The relay answered "New child process is up and serving", and about
    // two seconds later there was no server at all.
    //
    // Downstream that surfaced two ways, depending on where the next call landed: after the
    // exit was observed, `buildNoChildError` — a visible error telling you to restart a client
    // that had just restarted successfully; before it, a write into a dying pipe, silently
    // discarded, and an unbounded hang. #260 made a FAILED swap reportable; this made a
    // SUCCESSFUL one fatal, which is why it hid behind it.
    const dying = child;
    if (dying.exitCode === null && dying.signalCode === null) {
      dying.kill("SIGTERM");
      // Give it 2s to exit cleanly; otherwise SIGKILL.
      let escalate: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((res) => dying.once("exit", () => res())),
        new Promise<void>((res) => {
          escalate = setTimeout(() => {
            if (dying.exitCode === null && dying.signalCode === null) dying.kill("SIGKILL");
            res();
          }, GRACEFUL_EXIT_TIMEOUT_MS);
        }),
      ]);
      // Belt to the `dying` brace: nothing should be left armed once the swap moves on.
      clearTimeout(escalate);
    }
    child = spawnChild(opts.entryPath);
    forwardChildToParent(child);
    // The client never initialized, so there is no handshake to replay and nothing to wait on.
    if (!storedInit) return { ok: true };
    // Replay the captured handshake so the new child reaches serving state BEFORE the relay
    // tells the client the restart is done. Without this the next tools/call hangs forever.
    //
    // #260 — and the three ways this can END are three DIFFERENT answers, not one. Previously
    // the safety timer called the same `resolve()` the real handshake did, so a child that
    // died on boot (stale/half-written `dist/`, a missing module, a bad genome) produced
    // "restarted, up and serving" 10s later and then hung every call after it. Failure has to
    // be reportable or it is indistinguishable from success.
    const fresh = child;
    return await new Promise<RestartOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: RestartOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fresh.off("exit", onFreshExit);
        replayInitId = undefined;
        onInitReplayed = null;
        resolve(outcome);
      };
      // Fail FAST on a dead child — waiting out the full safety timeout for a process we
      // already know is gone only delays the diagnosis.
      const onFreshExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish({
          ok: false,
          reason:
            `the new child exited (code=${code ?? "null"}, signal=${signal ?? "null"}) ` +
            "before completing the MCP handshake",
        });
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: `the new child did not answer the replayed MCP initialize within ${HANDSHAKE_REPLAY_TIMEOUT_MS}ms`,
        });
      }, HANDSHAKE_REPLAY_TIMEOUT_MS);
      onInitReplayed = (): void => { finish({ ok: true }); };
      replayInitId = initRequestId(storedInit);
      fresh.once("exit", onFreshExit);
      fresh.stdin.write(storedInit + "\n");
    });
  };

  /** Is there a child that can actually receive a message right now? */
  const childAlive = (): boolean =>
    child.exitCode === null && child.signalCode === null && child.stdin.writable;

  /**
   * Forward one client line to the child — or, when no child is alive to receive it, ANSWER
   * it. A request written into a dead pipe is silently discarded and the caller waits forever;
   * that unbounded wait is the failure mode this converts into a visible JSON-RPC error.
   */
  const forwardToChild = (line: string, msg: JsonRpcMessage | null): void => {
    if (childAlive()) {
      child.stdin.write(line + "\n");
      return;
    }
    // A request carries an id (a notification does not) — only a request has a caller waiting.
    if (msg?.method !== undefined && msg.id !== undefined) {
      process.stdout.write(JSON.stringify(buildNoChildError(msg.id, msg.method)) + "\n");
      return;
    }
    process.stderr.write("[coltrane-relay] dropped a message: no live server child\n");
  };

  const parentIn = createInterface({ input: process.stdin });
  parentIn.on("line", (line) => {
    let msg: JsonRpcMessage | null = null;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      forwardToChild(line, null);
      return;
    }
    if (msg) {
      // Capture the handshake as it passes through (still forwarded to the first child).
      if (msg.method === "initialize") storedInit = line;
      else if (msg.method === "notifications/initialized") storedInitialized = line;

      const restartId = matchServerRestart(msg);
      if (restartId !== undefined) {
        // Handle locally. Reply only after the new child is up AND re-initialized, so the
        // client's next tool call lands on a serving child rather than hanging — and reply
        // with an ERROR when it did not, so a failed swap is diagnosable instead of silent.
        void restartChild().then((outcome) => {
          const reply = outcome.ok
            ? buildRestartResponse(restartId)
            : buildRestartError(restartId, outcome.reason);
          if (!outcome.ok) process.stderr.write(`[coltrane-relay] restart failed: ${outcome.reason}\n`);
          process.stdout.write(JSON.stringify(reply) + "\n");
        });
        return;
      }
    }
    forwardToChild(line, msg);
  });

  // Keep the process alive while the child is up.
  await new Promise<void>(() => {
    /* never resolves; the relay runs forever */
  });
}
