// per-steve worker entry point.
//
// The orchestrator spawns one of these per Steve. The worker reads its
// uuid + seed + token pair + audit path from env vars, constructs a
// SlackBridge, and runs an event loop that hands inbox events off to a
// downstream consumer (the Claude Code thread, when wired).
//
// For tonight's ship, the worker's `on_inbox` is a passthrough that
// records to audit.jsonl and prints a structured stderr line. The actual
// CC-thread wiring lands in subhuti's lane (which owns the slack-app
// creation flow + reaction handling) and groove's lane (which owns the
// onboarding UX).
//
// Run via:
//   STEVE_UUID=... STEVE_SEED_PATH=... STEVE_AUDIT_PATH=...
//   SLACK_BOT_TOKEN=... SLACK_APP_TOKEN=... COLTRANE_BOOK_PATH=...
//   node dist/src/live/worker.js

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tune } from "./tuning.js";
import { createSlackBridge, type InboxEvent } from "./slack_bridge.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
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
  // and seal the result to audit.jsonl. The CC-bridge consumes this seal
  // (and the audit stream below it) to color the Claude Code thread.
  // The project root is the dir containing CLAUDE.md.
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

  const bridge = createSlackBridge({
    steve_uuid: steveUuid,
    bot_token: botToken,
    app_token: appToken,
    audit_path: auditPath,
    on_inbox: async (ev: InboxEvent) => {
      // Stub passthrough: subhuti's PR replaces this with the CC-thread
      // dispatch. For now we just emit a structured stderr line so the
      // orchestrator log + audit.jsonl correlate.
      process.stderr.write(
        JSON.stringify({ steve_uuid: steveUuid, inbox: ev.kind, ts: ev.ts }) + "\n",
      );
    },
  });

  await bridge.start();
  process.stderr.write(
    JSON.stringify({ steve_uuid: steveUuid, status: "started" }) + "\n",
  );

  // keep alive
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      void bridge.stop().then(resolve);
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
}

// Run only when invoked directly (not when imported by tests).
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  runWorker().catch((err) => {
    process.stderr.write(JSON.stringify({ error: String(err) }) + "\n");
    process.exit(1);
  });
}
