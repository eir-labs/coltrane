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
    "Restart the Coltrane MCP server child process in place. Picks up new bytes after npm run build without ending the Claude Code conversation. Refuses if a gig is still in flight (naming it) unless force=true, in which case each running gig is aborted and recorded in the ledger before the swap. Returns when the new child is up.",
  inputSchema: {
    type: "object",
    properties: {
      // The explicit override. Absent/false = deny-by-default: a restart with gigs in flight is
      // REFUSED, naming them, so nothing is killed silently. `force: true` aborts + ledgers each
      // running gig, then swaps — a killed gig is a recorded fact, never an absence.
      force: { type: "boolean" },
    },
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
 * In-place augment a `tools/list` response so it carries the relay's `server_restart` entry.
 * Returns the mutated message for convenience.
 *
 * The relay is the TRUE owner of this tool — it intercepts `tools/call server_restart` and never
 * lets it reach the child. So the schema the client discovers must be the relay's, which advertises
 * the `force` restart-guard override (venue/8) the relay itself reads. The child's registry entry
 * (src/mcp.ts) is an argument-free introspection stub that exists only so tool_inspect/system_audit
 * see the tool; if it slipped into the client's list it would hide `force`. So we REPLACE any child
 * entry with the relay's authoritative one, rather than defer to a stub that advertises less than
 * the relay honours. The result carries exactly one `server_restart`, and it is the relay's.
 */
export function augmentToolsList(msg: JsonRpcMessage): JsonRpcMessage {
  const result = msg.result as { tools: unknown[] };
  result.tools = (result.tools as { name?: string }[]).filter(
    (t) => t.name !== SERVER_RESTART_TOOL.name,
  );
  result.tools.push(SERVER_RESTART_TOOL);
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

// ────────────────────────────────────────────────────────────────────────────
// Restart guard (venue/8) — a restart must never SILENTLY kill a running gig.
//
// THE DEFECT: `server_restart` used to SIGTERM its child with no preflight. Gigs run inside
// that child and chairs are spawned as its children, so the kill was total — every in-flight
// gig and seated chair died mid-phase, sealed outputs banked, and NO record saying they were
// killed. Two publish seats died exactly this way (gigs 8146142e and 18726459): a passing
// verdict, and no `result` event, because a killed gig leaves no trace. It was fail-OPEN on a
// destructive path — the same class as `void venue;`: the destructive action was the quiet one.
//
// THE WRINKLE: the relay holds NO gig state (grep this file — zero references to gigs, outputs
// or the runtime). It cannot know what a restart would destroy without ASKING the child. These
// two reserved JSON-RPC methods carry that conversation; the child answers them (src/server.ts).
// They are deliberately NOT MCP tools — they never appear in tools/list, so Claude Code cannot
// call them and the relay's blindness stays structural: it asks, then acts on the answer.

/** Reserved relay→child method: "which gigs are running right now?" → { running: string[] }. */
export const RUNNING_GIGS_METHOD = "coltrane/relay/running_gigs";
/** Reserved relay→child method (force path only): abort each running gig and LEDGER the abort,
 *  BEFORE the child is killed, so a killed gig is a recorded fact rather than an absence. */
export const ABORT_FOR_RESTART_METHOD = "coltrane/relay/abort_for_restart";

/** How long the child gets to answer the pre-restart gig check before the relay refuses. A child
 *  that does not answer is treated as UNHEALTHY — never assumed idle — because an unresponsive
 *  child is exactly when a silent kill would destroy the most work and when a restart is most
 *  likely to be issued (acceptance criterion 4). */
export const PREFLIGHT_TIMEOUT_MS = 3_000;

/** Read the operator's explicit override off a server_restart tools/call. Deny-by-default: absent,
 *  non-boolean, or false all mean "no override" — only a literal `force: true` unlocks the kill. */
export function parseForceFlag(msg: JsonRpcMessage): boolean {
  const args = msg.params?.["arguments"] as { force?: unknown } | undefined;
  return args?.force === true;
}

/** Pull the running-gig ids out of the child's preflight answer, defensively. A child that answers
 *  a wrong-shaped result is read as "reported nothing running" and is NEVER trusted into a kill. */
export function extractRunningGigs(msg: JsonRpcMessage | null): string[] {
  const running = (msg?.result as { running?: unknown } | undefined)?.running;
  if (!Array.isArray(running)) return [];
  return running.filter((g): g is string => typeof g === "string" && g.length > 0);
}

/**
 * Build the JSON-RPC ERROR the relay returns when a restart is issued while gigs are in flight and
 * no override was given. It NAMES each running gig — the whole point of the guard is that a killed
 * gig stops being an absence, so the refusal that PREVENTS the kill must itself name what it saved.
 */
export function buildRestartRefusalError(id: string | number | null, gigIds: string[]): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RELAY_ERROR_CODE,
      message:
        `Coltrane MCP server restart REFUSED — ${gigIds.length} gig(s) still in flight: ` +
        `${gigIds.join(", ")}. Restarting now kills the server child, and every running gig and ` +
        "seated chair is a child of it, so they would die mid-phase with their sealed outputs " +
        "banked and NO record that they were killed. Re-issue with `force: true` to abort the " +
        "running gig(s) first — each abort is written to the ledger — then restart.",
    },
  };
}

/**
 * Build the JSON-RPC ERROR the relay returns when the child did not answer the pre-restart gig
 * check in time. The relay holds no gig state, so a silent child means it cannot tell whether a
 * restart would kill work — and it REFUSES rather than assume-healthy-and-kill, because an
 * unresponsive child (hung, crashed mid-request, mid-swap) is precisely when a silent kill destroys
 * the most and when a restart is most likely to be reached for (acceptance criterion 4). No SIGTERM.
 */
export function buildUnresponsiveChildError(id: string | number | null): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RELAY_ERROR_CODE,
      message:
        "Coltrane MCP server restart REFUSED — the server child did not answer the pre-restart " +
        `gig check within ${PREFLIGHT_TIMEOUT_MS}ms (it may be hung, crashed mid-request, or ` +
        "mid-swap). The relay holds no gig state, so it cannot know whether a restart would kill " +
        "work in flight; assuming the child is idle and killing it anyway is the silent kill this " +
        "guard exists to prevent. No SIGTERM was sent — check the relay's stderr and the child's " +
        "health, or restart the MCP client.",
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

  // Reserved relay↔child requests (the pre-restart gig check + the force-path abort). Each is sent
  // under a reserved STRING id the client never issues, so the forwarder can recognise the child's
  // reply, resolve the waiting relay call, and NEVER forward it — these introspection messages stay
  // invisible to Claude Code. Mirrors the `replayInitId` convention (one reserved id withheld from
  // the forward loop), generalised to many concurrent reserved ids.
  const pendingRelayRequests = new Map<string | number, (m: JsonRpcMessage) => void>();
  let relayReqSeq = 0;

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
      // A reply to a reserved relay↔child request (pre-restart gig check / abort-for-restart). A
      // response has no method, and its id is one the relay minted and the client never issued.
      // Resolve the waiting relay call and NEVER forward it — the relay holds no gig state; it only
      // asks and acts on the answer, and these messages must stay invisible to Claude Code.
      if (msg && msg.method === undefined && msg.id != null && pendingRelayRequests.has(msg.id)) {
        const resolveRelay = pendingRelayRequests.get(msg.id)!;
        pendingRelayRequests.delete(msg.id);
        resolveRelay(msg);
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

  /**
   * Send one reserved relay→child request and await its reply, or `null` if the child does not
   * answer within `timeoutMs` (or there is no live child to ask). The reserved string id is
   * withheld from the forward loop by the `pendingRelayRequests` branch above, so the client never
   * sees this traffic. `null` is the load-bearing return: it is how "the child is unhealthy" reaches
   * the caller, which is exactly the case a restart guard must not mistake for "nothing running".
   */
  const relayRequest = (method: string, timeoutMs: number): Promise<JsonRpcMessage | null> => {
    if (!childAlive()) return Promise.resolve(null);
    const target = child;
    const id = `__coltrane_relay:${++relayReqSeq}`;
    return new Promise<JsonRpcMessage | null>((resolve) => {
      let done = false;
      const finish = (m: JsonRpcMessage | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingRelayRequests.delete(id);
        resolve(m);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      pendingRelayRequests.set(id, (m) => finish(m));
      target.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method }) + "\n");
    });
  };

  /**
   * The restart guard. The relay holds no gig state, so it asks the child what a restart would
   * destroy BEFORE any SIGTERM, and branches on the answer:
   *   • child does not answer  → REFUSE (unresponsive), no SIGTERM — never assume an idle child.
   *   • nothing running        → restart as today; the client's connection survives the swap.
   *   • running, no force       → REFUSE, naming the running gig(s); the child is left untouched.
   *   • running, force=true     → instruct the child to abort + LEDGER each running gig, THEN swap,
   *                               so a killed gig is a recorded fact rather than an absence.
   */
  const handleRestart = async (restartId: string | number | null, force: boolean): Promise<void> => {
    const answer = (reply: JsonRpcMessage): void => { process.stdout.write(JSON.stringify(reply) + "\n"); };

    const pre = await relayRequest(RUNNING_GIGS_METHOD, PREFLIGHT_TIMEOUT_MS);
    if (pre === null) {
      process.stderr.write("[coltrane-relay] restart refused: child did not answer the pre-restart gig check\n");
      answer(buildUnresponsiveChildError(restartId));
      return;
    }
    const running = extractRunningGigs(pre);
    if (running.length > 0) {
      if (!force) {
        process.stderr.write(`[coltrane-relay] restart refused: ${running.length} gig(s) in flight: ${running.join(", ")}\n`);
        answer(buildRestartRefusalError(restartId, running));
        return;
      }
      // Force: the child records the abort of every running gig BEFORE it dies. Await the child's
      // confirmation; if it does not answer, treat it as unresponsive and send NO SIGTERM.
      const ack = await relayRequest(ABORT_FOR_RESTART_METHOD, PREFLIGHT_TIMEOUT_MS);
      if (ack === null) {
        process.stderr.write("[coltrane-relay] restart refused: child did not confirm the abort-for-restart\n");
        answer(buildUnresponsiveChildError(restartId));
        return;
      }
      process.stderr.write(`[coltrane-relay] force restart: aborted + ledgered ${running.length} gig(s): ${running.join(", ")}\n`);
    }
    // Reply only after the new child is up AND re-initialized, so the client's next tool call lands
    // on a serving child rather than hanging — and reply with an ERROR when it did not (#260).
    const outcome = await restartChild();
    if (!outcome.ok) process.stderr.write(`[coltrane-relay] restart failed: ${outcome.reason}\n`);
    answer(outcome.ok ? buildRestartResponse(restartId) : buildRestartError(restartId, outcome.reason));
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
        // Handle locally, through the guard — a silent kill must no longer be possible.
        void handleRestart(restartId, parseForceFlag(msg));
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
