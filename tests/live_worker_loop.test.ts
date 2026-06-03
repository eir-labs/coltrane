// live_worker_loop.test.ts — Steve consume-inbox -> CC-resume -> post loop.
//
// Tests use in-memory inbox + stubInvoker + recording post sink + memory audit
// sink. The loop never spawns claude and never talks to slack, so the full
// round-trip is exercised deterministically.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  steveWorkerLoop,
  createMemoryInboxSource,
  type InboxEnvelope,
  type PostSink,
  type WorkerLoopOptions,
} from "../src/live/worker_loop.js";
import {
  stubInvoker,
  defaultInvoker,
  type ClaudeInvoker,
  type InvokeOptions,
  type InvokeResult,
} from "../src/live/cc_invoker.js";
import { inboxEventToEnvelope } from "../src/live/worker.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeEnvelope(overrides: Partial<InboxEnvelope> = {}): InboxEnvelope {
  return {
    event_id: "1700000000.000100",
    text: "hello steve",
    channel: "C123",
    user: "U456",
    received_at: "2026-06-03T20:00:00.000Z",
    ...overrides,
  };
}

interface RecordingPost {
  sink: PostSink;
  posts: Array<{ channel: string; text: string; thread_ts?: string }>;
}
function recordingPost(opts?: { fail?: boolean; ts?: string }): RecordingPost {
  const posts: RecordingPost["posts"] = [];
  return {
    posts,
    sink: {
      async post(channel, text, thread_ts) {
        const rec: { channel: string; text: string; thread_ts?: string } = { channel, text };
        if (thread_ts !== undefined) rec.thread_ts = thread_ts;
        posts.push(rec);
        if (opts?.fail) return { ok: false, ts: undefined };
        return { ok: true, ts: opts?.ts ?? "9999.0001" };
      },
    },
  };
}

interface MemoryAudit {
  sink: (line: string) => Promise<void>;
  lines: string[];
  parsed: () => Array<Record<string, unknown>>;
}
function memoryAudit(): MemoryAudit {
  const lines: string[] = [];
  return {
    lines,
    sink: async (line: string) => {
      lines.push(line);
    },
    parsed: () =>
      lines
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function baseOptions(overrides: Partial<WorkerLoopOptions> = {}): WorkerLoopOptions {
  const inbox = createMemoryInboxSource();
  const post = recordingPost();
  const audit = memoryAudit();
  return {
    steve_uuid: "steve-uuid-test",
    audit_path: "/tmp/unused-audit.jsonl",
    invoker: stubInvoker({}, { fallback: "default-stub-reply" }),
    inbox,
    post: post.sink,
    audit_sink: audit.sink,
    max_cycles: 5,
    idle_sleep_ms: 0,
    now: () => new Date("2026-06-03T20:00:00.000Z"),
    rng: () => "session-fixed-uuid",
    ...overrides,
  };
}

describe("steveWorkerLoop — happy path", () => {
  it("reads inbox events in order and dispatches each", async () => {
    const inbox = createMemoryInboxSource([
      makeEnvelope({ event_id: "evt-1", text: "first" }),
      makeEnvelope({ event_id: "evt-2", text: "second" }),
      makeEnvelope({ event_id: "evt-3", text: "third" }),
    ]);
    const post = recordingPost();
    const audit = memoryAudit();
    const seen: string[] = [];
    const invoker: ClaudeInvoker = {
      async invoke(sid: string, prompt: string): Promise<InvokeResult> {
        seen.push(prompt);
        return { ok: true, session_id: sid, text: `reply:${prompt.slice(-5)}` };
      },
    };
    const stats = await steveWorkerLoop("steve-1", {
      ...baseOptions(),
      inbox,
      post: post.sink,
      audit_sink: audit.sink,
      invoker,
      max_cycles: 10,
    });
    expect(stats.consumed).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain("first");
    expect(seen[1]).toContain("second");
    expect(seen[2]).toContain("third");
    expect(post.posts.map((p) => p.text)).toEqual([
      "reply:first",
      "reply:econd",
      "reply:third",
    ]);
  });

  it("calls stubInvoker with formatted prompt + correct session_id", async () => {
    const inbox = createMemoryInboxSource([makeEnvelope({ event_id: "evt-X", text: "ping" })]);
    const calls: Array<{ sid: string; prompt: string }> = [];
    const invoker: ClaudeInvoker = {
      async invoke(sid: string, prompt: string): Promise<InvokeResult> {
        calls.push({ sid, prompt });
        return { ok: true, session_id: sid, text: "pong" };
      },
    };
    await steveWorkerLoop("steve-2", {
      ...baseOptions(),
      inbox,
      invoker,
      max_cycles: 3,
    });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (!c) throw new Error("no invoker call recorded");
    expect(c.sid).toBe("session-fixed-uuid");
    expect(c.prompt).toContain("steve-2");
    expect(c.prompt).toContain("session-fixed-uuid");
    expect(c.prompt).toContain("ping");
  });

  it("posts invoker response to slack via the post sink", async () => {
    const inbox = createMemoryInboxSource([
      makeEnvelope({ event_id: "evt-P", text: "say hi", channel: "C-OUT", thread_ts: "T-PARENT" }),
    ]);
    const post = recordingPost({ ts: "9999.123" });
    const invoker = stubInvoker({ "say hi": "HELLO BACK" });
    await steveWorkerLoop("steve-3", {
      ...baseOptions(),
      inbox,
      post: post.sink,
      invoker,
      max_cycles: 3,
    });
    expect(post.posts).toEqual([
      { channel: "C-OUT", text: "HELLO BACK", thread_ts: "T-PARENT" },
    ]);
  });

  it("appends inbox_consumed seal-event with correct shas", async () => {
    const envelope = makeEnvelope({ event_id: "evt-SHA", text: "compute me" });
    const inbox = createMemoryInboxSource([envelope]);
    const audit = memoryAudit();
    const invoker = stubInvoker({ "compute me": "ANSWER-42" });
    await steveWorkerLoop("steve-4", {
      ...baseOptions(),
      inbox,
      invoker,
      audit_sink: audit.sink,
      max_cycles: 3,
    });
    const events = audit.parsed();
    const consumed = events.find((e) => e["kind"] === "inbox_consumed");
    expect(consumed).toBeDefined();
    if (!consumed) return;
    expect(consumed["steve_uuid"]).toBe("steve-4");
    expect(consumed["event_id"]).toBe("evt-SHA");
    expect(consumed["session_id"]).toBe("session-fixed-uuid");
    expect(consumed["inbox_event_sha"]).toBe(sha256(JSON.stringify(envelope)));
    expect(consumed["response_sha"]).toBe(sha256("ANSWER-42"));
    expect(consumed["post_ok"]).toBe(true);
  });
});

describe("steveWorkerLoop — budgets + shutdown", () => {
  it("stops cleanly when max-cycle budget is reached", async () => {
    const inbox = createMemoryInboxSource();  // empty, will idle each cycle
    const stats = await steveWorkerLoop("steve-5", {
      ...baseOptions(),
      inbox,
      max_cycles: 4,
      idle_sleep_ms: 0,
    });
    expect(stats.cycles).toBe(4);
    expect(stats.consumed).toBe(0);
    expect(stats.stopped_reason).toBe("max_cycles");
  });

  it("stops cleanly when shouldStop() flips true", async () => {
    let stop = false;
    const inbox = createMemoryInboxSource();
    setTimeout(() => {
      stop = true;
    }, 5);
    const stats = await steveWorkerLoop("steve-6", {
      ...baseOptions(),
      inbox,
      shouldStop: () => stop,
      idle_sleep_ms: 1,
      max_cycles: 10_000,
    });
    expect(stats.stopped_reason).toBe("shutdown");
    expect(stats.cycles).toBeLessThan(10_000);
  });

  it("empty inbox idles without errors", async () => {
    const inbox = createMemoryInboxSource();
    const audit = memoryAudit();
    const stats = await steveWorkerLoop("steve-7", {
      ...baseOptions(),
      inbox,
      audit_sink: audit.sink,
      max_cycles: 3,
      idle_sleep_ms: 0,
    });
    expect(stats.consumed).toBe(0);
    expect(stats.invoke_failures).toBe(0);
    // No spurious seals on empty cycles.
    expect(audit.parsed().filter((e) => e["kind"] === "inbox_consumed")).toHaveLength(0);
  });
});

describe("steveWorkerLoop — robustness", () => {
  it("logs + skips malformed inbox entries without crashing", async () => {
    // The source itself yields a malformed shape; the loop counts it as
    // skipped_malformed and continues.
    const malformed = { not_an_envelope: true } as unknown as InboxEnvelope;
    const good = makeEnvelope({ event_id: "evt-OK" });
    let returned = 0;
    const inbox = {
      async next() {
        returned += 1;
        if (returned === 1) return malformed;
        if (returned === 2) return good;
        return null;
      },
      async markConsumed() {
        /* no-op for this test */
      },
    };
    const audit = memoryAudit();
    const stats = await steveWorkerLoop("steve-8", {
      ...baseOptions(),
      inbox,
      audit_sink: audit.sink,
      max_cycles: 6,
    });
    expect(stats.skipped_malformed).toBe(1);
    expect(stats.consumed).toBe(1);
    const kinds = audit.parsed().map((e) => e["kind"]);
    expect(kinds).toContain("inbox_skipped_malformed");
    expect(kinds).toContain("inbox_consumed");
  });

  it("does not double-consume the same event_id", async () => {
    const inbox = createMemoryInboxSource();
    const dup = makeEnvelope({ event_id: "evt-DUP", text: "once" });
    inbox.enqueue(dup);
    inbox.enqueue(dup);  // same event_id enqueued twice
    const post = recordingPost();
    const stats = await steveWorkerLoop("steve-9", {
      ...baseOptions(),
      inbox,
      post: post.sink,
      max_cycles: 8,
    });
    // Only one post, even though enqueued twice.
    expect(stats.consumed).toBe(1);
    expect(post.posts).toHaveLength(1);
  });

  it("seals an invoke_failed event when the invoker errors", async () => {
    const inbox = createMemoryInboxSource([makeEnvelope({ event_id: "evt-FAIL" })]);
    const audit = memoryAudit();
    const failing: ClaudeInvoker = {
      async invoke(sid: string): Promise<InvokeResult> {
        return {
          ok: false,
          session_id: sid,
          error_kind: "binary_missing",
          message: "claude not on PATH",
        };
      },
    };
    const stats = await steveWorkerLoop("steve-10", {
      ...baseOptions(),
      inbox,
      invoker: failing,
      audit_sink: audit.sink,
      max_cycles: 4,
    });
    expect(stats.invoke_failures).toBe(1);
    expect(stats.consumed).toBe(0);
    const kinds = audit.parsed().map((e) => e["kind"]);
    expect(kinds).toContain("inbox_invoke_failed");
    const fail = audit.parsed().find((e) => e["kind"] === "inbox_invoke_failed");
    expect(fail?.["error_kind"]).toBe("binary_missing");
  });
});

describe("steveWorkerLoop — full round-trip circuit", () => {
  it("post -> inbox -> consume -> response -> audit closes the loop", async () => {
    // Simulate slack_bridge fan-out: a memory queue receives an inbox event,
    // the loop drains it, posts the response back through the bridge sink,
    // and seals the consumed event.
    const inbox = createMemoryInboxSource();
    const post = recordingPost({ ts: "9999.RT" });
    const audit = memoryAudit();
    const invoker = stubInvoker({ "knock knock": "who's there" });

    // External actor "posts" the inbound event into the queue (this is what
    // slack_bridge.on_inbox does via inboxEventToEnvelope in production).
    const incoming = inboxEventToEnvelope({
      kind: "app_mention",
      channel: "C-RT",
      user: "U-RT",
      text: "knock knock",
      ts: "1700000000.000999",
      received_at: "2026-06-03T20:00:00.000Z",
      raw: {},
    });
    expect(incoming).not.toBeNull();
    if (!incoming) return;
    inbox.enqueue(incoming);

    const stats = await steveWorkerLoop("steve-RT", {
      ...baseOptions(),
      inbox,
      post: post.sink,
      audit_sink: audit.sink,
      invoker,
      max_cycles: 4,
    });

    expect(stats.consumed).toBe(1);
    expect(post.posts).toEqual([
      { channel: "C-RT", text: "who's there" },
    ]);
    const consumed = audit.parsed().find((e) => e["kind"] === "inbox_consumed");
    expect(consumed?.["event_id"]).toBe("1700000000.000999");
    expect(consumed?.["posted_ts"]).toBe("9999.RT");
    expect(consumed?.["post_ok"]).toBe(true);
    // The session_bound event must precede the consumed event (binding came first).
    const order = audit.parsed().map((e) => e["kind"]);
    const sessionIdx = order.indexOf("cc_session_bound");
    const consumedIdx = order.indexOf("inbox_consumed");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(consumedIdx).toBeGreaterThan(sessionIdx);
  });
});

describe("cc_invoker.defaultInvoker — clean-error contract", () => {
  it("returns binary_missing (not a stack trace) when claude is not on PATH", async () => {
    const inv = defaultInvoker();
    const opts: InvokeOptions = { binary: "definitely-not-a-real-binary-x9q2", timeout_ms: 2000 };
    const result = await inv.invoke("sid-x", "hi", opts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["binary_missing", "spawn_error"]).toContain(result.error_kind);
    expect(result.message).toMatch(/not (a |)found|spawn|ENOENT|definitely-not-a-real-binary/i);
  });
});
