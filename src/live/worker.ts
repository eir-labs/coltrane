// per-steve worker entry point.
//
// The orchestrator spawns one of these per Steve. The worker reads its
// uuid + seed + token pair + audit path from env vars, constructs a
// SlackBridge, binds a CC session, and runs the consume-inbox -> CC-resume
// -> post-back loop until SIGTERM/SIGINT.
//
// Wiring diagram:
//
//   tune() -> seal tuning onto audit.jsonl
//   bindNewSession() -> seal cc_session_bound onto audit.jsonl
//   createSlackBridge({ on_inbox: enqueue-to-memory-queue }) -> start socket
//   steveWorkerLoop() -> drain queue -> invoker -> bridge.post -> seal
//
// Run via:
//   STEVE_UUID=... STEVE_SEED_PATH=... STEVE_AUDIT_PATH=...
//   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... COLTRANE_BOOK_PATH=...
//   node dist/src/live/worker.js

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tune } from "./tuning.js";
import { createSlackBridge, type InboxEvent } from "./slack_bridge.js";
import { bindNewSession } from "./cc_session_binding.js";
import { defaultInvoker } from "./cc_invoker.js";
import {
  steveWorkerLoop,
  createMemoryInboxSource,
  type InboxEnvelope,
} from "./worker_loop.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

/** Convert slack_bridge's InboxEvent into the loop's InboxEnvelope shape.
 *  Returns null if the event lacks the minimum text/id needed to drive a
 *  Claude response (e.g. reactions without a textual prompt). */
export function inboxEventToEnvelope(ev: InboxEvent): InboxEnvelope | null {
  if (!ev.text || !ev.ts) return null;
  const env: InboxEnvelope = {
    event_id: ev.ts,
    text: ev.text,
    received_at: ev.received_at,
  };
  if (ev.channel !== undefined) env.channel = ev.channel;
  if (ev.user !== undefined) env.user = ev.user;
  if (ev.thread_ts !== undefined) env.thread_ts = ev.thread_ts;
  return env;
}

export async function runWorker(): Promise<void> {
  const steveUuid = requireEnv("STEVE_UUID");
  const seedPath = requireEnv("STEVE_SEED_PATH");
  const auditPath = requireEnv("STEVE_AUDIT_PATH");
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");
  const bookPath = requireEnv("COLTRANE_BOOK_PATH");

  // The book read primes the worker — even before CC-thread wiring, we
  // surface a parse error if the book is missing rather than discovering
  // it at first-inbox.
  await readFile(bookPath, "utf8");
  await readFile(seedPath, "utf8");

  // Tuning: scan the project, pair its shape with this Steve's seed,
  // and seal the result to audit.jsonl.
  const rootPath = dirname(bookPath);
  const seal = await tune(steveUuid, seedPath, rootPath, auditPath);
  process.stderr.write(
    JSON.stringify({
      steve_uuid: steveUuid,
      event: "tuning",
      seal_hash: seal.seal_hash,
      project_shape_hash: seal.project_shape_hash,
      seed_hash: seal.seed_hash,
      pairings: seal.pairings.map((p) => p.task_type),
      unavailable_signals: seal.unavailable_signals,
    }) + "\n",
  );

  // Bind a fresh CC session for this worker boot. The binding event is
  // sealed onto audit.jsonl; ensureSessionId inside the loop reads it back
  // (and mints a replacement only if it's missing for some reason).
  const binding = await bindNewSession(steveUuid, auditPath, "worker_boot");
  process.stderr.write(
    JSON.stringify({
      steve_uuid: steveUuid,
      event: "cc_session_bound",
      session_id: binding.session_id,
    }) + "\n",
  );

  // Inbox queue: slack_bridge writes via on_inbox; worker_loop drains.
  const inbox = createMemoryInboxSource();

  const bridge = createSlackBridge({
    steve_uuid: steveUuid,
    bot_token: botToken,
    app_token: appToken,
    audit_path: auditPath,
    on_inbox: async (ev: InboxEvent) => {
      const env = inboxEventToEnvelope(ev);
      if (env) inbox.enqueue(env);
      process.stderr.write(
        JSON.stringify({
          steve_uuid: steveUuid,
          inbox: ev.kind,
          ts: ev.ts,
          enqueued: env !== null,
        }) + "\n",
      );
    },
  });

  await bridge.start();
  process.stderr.write(
    JSON.stringify({ steve_uuid: steveUuid, status: "started" }) + "\n",
  );

  // Shutdown bookkeeping: SIGTERM/SIGINT flips a flag the loop polls each
  // iteration; once the in-flight cycle exits, we stop the bridge + return.
  let shutdownRequested = false;
  const onSignal = () => {
    shutdownRequested = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const invoker = defaultInvoker();
  const stats = await steveWorkerLoop(steveUuid, {
    steve_uuid: steveUuid,
    audit_path: auditPath,
    invoker,
    inbox,
    post: {
      post: (channel, text, thread_ts) => bridge.post(channel, text, thread_ts),
    },
    shouldStop: () => shutdownRequested,
    idle_sleep_ms: 500,
    session_trigger: "worker_boot",
  });

  await bridge.stop();
  process.stderr.write(
    JSON.stringify({
      steve_uuid: steveUuid,
      status: "stopped",
      ...stats,
    }) + "\n",
  );
}

// Run only when invoked directly (not when imported by tests).
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  runWorker().catch((err) => {
    process.stderr.write(JSON.stringify({ error: String(err) }) + "\n");
    process.exit(1);
  });
}
