// worker_loop.ts — Steve's consume-inbox -> CC-resume -> post-back loop.
//
// Architecture:
//
//   slack_bridge (inbound socket event)
//        |
//        v
//   InboxSource.next() ----> steveWorkerLoop
//        |                       |
//        |                  ensureSessionId(uuid) (cc_session_binding)
//        |                       |
//        |                  ClaudeInvoker.invoke(session_id, prompt)
//        |                       |
//        |                  PostSink.post(channel, text, thread_ts)
//        |                       |
//        |                  audit.appendJsonl({ inbox_consumed, ..., shas })
//        |                       |
//        v                       v
//   (next event)             (next iteration)
//
// All seams are injectable: tests pass a memory InboxSource + stubInvoker +
// recording PostSink + memory audit sink. Production wires the file-based
// inbox queue (fed by slack_bridge's on_inbox), defaultInvoker, and the real
// slack_bridge as the PostSink.
//
// Budgets:
//   - max_cycles: hard ceiling on iterations (default Infinity); tests pass a
//     small number to bound the loop.
//   - shouldStop(): polled each iteration; the worker installs SIGTERM/SIGINT
//     handlers that flip a bool consulted via this hook.
//   - idle_sleep_ms: how long to wait when the inbox is empty (default 250ms).

import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ClaudeInvoker, InvokeResult } from "./cc_invoker.js";
import {
  ensureSessionId,
  type CcSessionTrigger,
} from "./cc_session_binding.js";

/** One inbox event the loop consumes. Mirrors slack_bridge's InboxEvent shape
 *  but is intentionally re-declared here so worker_loop doesn't depend on
 *  Slack's transport types directly (file-based testing stays clean). */
export interface InboxEnvelope {
  /** Monotonically-increasing-ish event id used for de-dupe. Usually the
   *  Slack ts, but any unique string works for tests. */
  event_id: string;
  text: string;
  channel?: string;
  user?: string;
  thread_ts?: string;
  received_at: string;
}

export interface InboxSource {
  /** Resolve with the next envelope, or null when no event is ready. The
   *  loop polls this; an idle source returns null and the loop sleeps. */
  next(): Promise<InboxEnvelope | null>;
  /** Mark an event consumed so a concurrent poller doesn't re-deliver it.
   *  Memory + file sources both implement this as a permanent mark. */
  markConsumed(event_id: string): Promise<void>;
}

export interface PostSink {
  post(
    channel: string,
    text: string,
    thread_ts?: string,
  ): Promise<{ ok: boolean; ts?: string | undefined }>;
}

export interface SealSink {
  /** Append one JSONL line to audit. Defaults to fs appendFile when not
   *  provided in options. */
  (line: string): Promise<void>;
}

export interface WorkerLoopOptions {
  steve_uuid: string;
  audit_path: string;
  invoker: ClaudeInvoker;
  inbox: InboxSource;
  post: PostSink;
  /** Override audit append (tests inject a memory sink). */
  audit_sink?: SealSink;
  /** Hook to stop the loop early (signal handler flips this). */
  shouldStop?: () => boolean;
  /** Cap iterations — guard against infinite loops in tests. */
  max_cycles?: number;
  /** Sleep duration when the inbox is empty. */
  idle_sleep_ms?: number;
  /** Trigger label sealed onto the cc_session_binding event if a fresh
   *  session needs to be minted. */
  session_trigger?: CcSessionTrigger;
  /** Override clock + uuid for deterministic tests. */
  now?: () => Date;
  rng?: () => string;
  /** Build the prompt fed to claude --resume from the inbox envelope.
   *  Default: a small header + the raw text. Callers can override to
   *  inject identity / channel context / etc. */
  formatPrompt?: (ev: InboxEnvelope, ctx: { steve_uuid: string; session_id: string }) => string;
  /** Optional invoker timeout. */
  invoke_timeout_ms?: number;
}

export interface LoopStats {
  cycles: number;
  consumed: number;
  skipped_malformed: number;
  invoke_failures: number;
  post_failures: number;
  stopped_reason: "max_cycles" | "shutdown" | "source_drained";
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function defaultFormatPrompt(
  ev: InboxEnvelope,
  ctx: { steve_uuid: string; session_id: string },
): string {
  // Plain, code-neutral prompt — no methodology vocabulary in shipped code.
  const channel = ev.channel ?? "(dm)";
  const user = ev.user ?? "(unknown)";
  return [
    `Inbox event for steve ${ctx.steve_uuid} (session ${ctx.session_id}).`,
    `From user ${user} in channel ${channel}.`,
    ``,
    ev.text,
  ].join("\n");
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((r) => setTimeout(r, ms));
}

function isValidEnvelope(ev: unknown): ev is InboxEnvelope {
  if (!ev || typeof ev !== "object") return false;
  const o = ev as Record<string, unknown>;
  return (
    typeof o["event_id"] === "string" &&
    typeof o["text"] === "string" &&
    typeof o["received_at"] === "string"
  );
}

/**
 * The main consume-loop. Drains the inbox source, dispatches each event to
 * the bound Claude Code session via the invoker, posts the response, seals
 * an inbox_consumed event onto audit.jsonl.
 *
 * Returns LoopStats once the loop exits (budget hit, shutdown, or — if
 * the source supports it — drained). Never throws on per-event failure;
 * malformed envelopes are logged via the seal stream + counted.
 */
export async function steveWorkerLoop(
  uuid: string,
  options: WorkerLoopOptions,
): Promise<LoopStats> {
  const idle = options.idle_sleep_ms ?? 250;
  const maxCycles = options.max_cycles ?? Number.POSITIVE_INFINITY;
  const trigger: CcSessionTrigger = options.session_trigger ?? "worker_boot";
  const formatPrompt = options.formatPrompt ?? defaultFormatPrompt;
  const shouldStop = options.shouldStop ?? (() => false);
  const auditSink: SealSink =
    options.audit_sink ?? ((line: string) => appendFile(options.audit_path, line, "utf8"));
  const now = options.now ?? (() => new Date());

  const stats: LoopStats = {
    cycles: 0,
    consumed: 0,
    skipped_malformed: 0,
    invoke_failures: 0,
    post_failures: 0,
    stopped_reason: "max_cycles",
  };

  while (stats.cycles < maxCycles) {
    if (shouldStop()) {
      stats.stopped_reason = "shutdown";
      return stats;
    }
    stats.cycles += 1;

    let envelope: InboxEnvelope | null;
    try {
      envelope = await options.inbox.next();
    } catch (err) {
      await sealLine(auditSink, {
        kind: "inbox_read_error",
        steve_uuid: uuid,
        at: now().toISOString(),
        message: err instanceof Error ? err.message : String(err),
      });
      await sleep(idle);
      continue;
    }

    if (envelope === null) {
      await sleep(idle);
      continue;
    }

    if (!isValidEnvelope(envelope)) {
      stats.skipped_malformed += 1;
      await sealLine(auditSink, {
        kind: "inbox_skipped_malformed",
        steve_uuid: uuid,
        at: now().toISOString(),
      });
      // Best-effort mark so we don't see it again.
      const maybeId = (envelope as { event_id?: unknown }).event_id;
      if (typeof maybeId === "string") {
        try {
          await options.inbox.markConsumed(maybeId);
        } catch {
          /* swallow — already counted */
        }
      }
      continue;
    }

    // Ensure session before we mark consumed — if the binding write fails,
    // we want the envelope to remain claimable.
    const { session_id } = await ensureSessionId(uuid, options.audit_path, trigger, {
      ...(options.audit_sink ? { sink: options.audit_sink } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.rng ? { rng: options.rng } : {}),
    });

    const prompt = formatPrompt(envelope, { steve_uuid: uuid, session_id });
    const invokeOpts: { timeout_ms?: number } = {};
    if (options.invoke_timeout_ms !== undefined) {
      invokeOpts.timeout_ms = options.invoke_timeout_ms;
    }
    const result: InvokeResult = await options.invoker.invoke(
      session_id,
      prompt,
      invokeOpts,
    );

    if (!result.ok) {
      stats.invoke_failures += 1;
      await sealLine(auditSink, {
        kind: "inbox_invoke_failed",
        steve_uuid: uuid,
        at: now().toISOString(),
        event_id: envelope.event_id,
        error_kind: result.error_kind,
        message: result.message,
      });
      await options.inbox.markConsumed(envelope.event_id);
      continue;
    }

    let postedTs: string | undefined;
    let postOk = true;
    if (envelope.channel) {
      try {
        const r = await options.post.post(
          envelope.channel,
          result.text,
          envelope.thread_ts,
        );
        postOk = r.ok;
        postedTs = r.ts;
      } catch (err) {
        postOk = false;
        await sealLine(auditSink, {
          kind: "inbox_post_failed",
          steve_uuid: uuid,
          at: now().toISOString(),
          event_id: envelope.event_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!postOk) {
        stats.post_failures += 1;
      }
    }

    await sealLine(auditSink, {
      kind: "inbox_consumed",
      steve_uuid: uuid,
      at: now().toISOString(),
      event_id: envelope.event_id,
      session_id,
      inbox_event_sha: sha256Hex(JSON.stringify(envelope)),
      response_sha: sha256Hex(result.text),
      posted_ts: postedTs,
      post_ok: postOk,
    });

    stats.consumed += 1;
    await options.inbox.markConsumed(envelope.event_id);
  }

  return stats;
}

async function sealLine(sink: SealSink, obj: Record<string, unknown>): Promise<void> {
  await sink(JSON.stringify(obj) + "\n");
}

// ---------------------------------------------------------------------------
// In-memory inbox source: production wires slack_bridge's on_inbox to enqueue
// into this; tests construct one directly with a seed array.
// ---------------------------------------------------------------------------

export interface MemoryInboxSource extends InboxSource {
  enqueue(ev: InboxEnvelope): void;
  size(): number;
}

export function createMemoryInboxSource(seed?: InboxEnvelope[]): MemoryInboxSource {
  const queue: InboxEnvelope[] = seed ? [...seed] : [];
  const consumed = new Set<string>();
  return {
    async next() {
      while (queue.length > 0) {
        const head = queue.shift();
        if (!head) continue;
        if (consumed.has(head.event_id)) continue;
        return head;
      }
      return null;
    },
    async markConsumed(event_id) {
      consumed.add(event_id);
    },
    enqueue(ev) {
      if (consumed.has(ev.event_id)) return;
      queue.push(ev);
    },
    size() {
      return queue.length;
    },
  };
}
