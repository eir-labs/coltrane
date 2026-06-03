// cc_session_binding.test.ts — bind a Claude Code session to a Steve.
// Tests: deterministic seal · audit-stream round trip · most-recent wins
// · tamper detection · ensureSessionId fresh-vs-existing.

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBinding,
  computeBindingSealHash,
  bindNewSession,
  appendBinding,
  getActiveSessionBinding,
  ensureSessionId,
  verifyBindingSeal,
  type CcSessionBinding,
} from "../src/live/cc_session_binding.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-session-test-"));
}

describe("buildBinding — deterministic seal", () => {
  it("builds a sealed binding with stable hash", () => {
    const b = buildBinding(
      "steve-uuid-1",
      "session-aaa",
      "first_inbox_event",
      "2026-06-04T01:23:45.000Z",
    );
    expect(b.kind).toBe("cc_session_bound");
    expect(b.steve_uuid).toBe("steve-uuid-1");
    expect(b.session_id).toBe("session-aaa");
    expect(b.context.trigger).toBe("first_inbox_event");
    expect(b.sha_seal).toHaveLength(64);
    expect(verifyBindingSeal(b)).toBe(true);
  });

  it("reproduces the same seal across runs (canonical form is stable)", () => {
    const a = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    const b = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    expect(a.sha_seal).toBe(b.sha_seal);
  });

  it("different sessions yield different seals", () => {
    const a = buildBinding("u", "s1", "manual_resume", "2026-06-04T00:00:00.000Z");
    const b = buildBinding("u", "s2", "manual_resume", "2026-06-04T00:00:00.000Z");
    expect(a.sha_seal).not.toBe(b.sha_seal);
  });

  it("includes optional note in the seal", () => {
    const a = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    const b = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z", "note-text");
    expect(a.sha_seal).not.toBe(b.sha_seal);
    expect(b.context.note).toBe("note-text");
  });
});

describe("bindNewSession + appendBinding — audit-stream write", () => {
  it("appends a JSONL line to the audit path", async () => {
    const dir = tmpDir();
    const auditPath = join(dir, "audit.jsonl");
    try {
      const b = await bindNewSession("u", auditPath, "worker_boot", {
        now: () => new Date("2026-06-04T00:00:00.000Z"),
        rng: () => "deterministic-session",
      });
      expect(existsSync(auditPath)).toBe(true);
      const content = readFileSync(auditPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(content.trim()) as CcSessionBinding;
      expect(parsed.session_id).toBe("deterministic-session");
      expect(parsed.sha_seal).toBe(b.sha_seal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works with an injected sink (no fs writes)", async () => {
    const captured: string[] = [];
    const b = await bindNewSession("u", "/nonexistent", "manual_resume", {
      now: () => new Date("2026-06-04T00:00:00.000Z"),
      rng: () => "in-memory-session",
      sink: async (line) => {
        captured.push(line);
      },
    });
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0]!)).toMatchObject({
      kind: "cc_session_bound",
      session_id: "in-memory-session",
      sha_seal: b.sha_seal,
    });
  });

  it("appendBinding writes one line for a pre-built binding", async () => {
    const captured: string[] = [];
    const b = buildBinding("u", "s", "bridge_restart", "2026-06-04T00:00:00.000Z");
    await appendBinding(b, "/nonexistent", async (line) => {
      captured.push(line);
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!).toBe(JSON.stringify(b) + "\n");
  });
});

describe("getActiveSessionBinding — most-recent wins", () => {
  it("returns null on empty audit stream", async () => {
    const r = await getActiveSessionBinding("u", "/nonexistent", {
      reader: async () => "",
    });
    expect(r).toBeNull();
  });

  it("returns null when path does not exist (read failure)", async () => {
    const r = await getActiveSessionBinding("u", "/definitely/not/here.jsonl");
    expect(r).toBeNull();
  });

  it("ignores non-binding events on the stream", async () => {
    const mixed =
      JSON.stringify({ kind: "tuning", steve_uuid: "u", seal_hash: "x" }) + "\n" +
      JSON.stringify({ kind: "react", steve_uuid: "u" }) + "\n" +
      JSON.stringify(
        buildBinding("u", "s1", "first_inbox_event", "2026-06-04T01:00:00.000Z"),
      ) + "\n";
    const r = await getActiveSessionBinding("u", "/nonexistent", {
      reader: async () => mixed,
    });
    expect(r?.session_id).toBe("s1");
  });

  it("returns the binding with the latest `at`, not the last-on-disk", async () => {
    const lines = [
      buildBinding("u", "s-old", "worker_boot", "2026-06-04T00:00:00.000Z"),
      buildBinding("u", "s-newest", "manual_resume", "2026-06-04T02:00:00.000Z"),
      buildBinding("u", "s-middle", "bridge_restart", "2026-06-04T01:00:00.000Z"),
    ]
      .map((b) => JSON.stringify(b))
      .join("\n");
    const r = await getActiveSessionBinding("u", "/nonexistent", {
      reader: async () => lines,
    });
    expect(r?.session_id).toBe("s-newest");
  });

  it("filters by steve_uuid (multi-Steve audit-stream is filtered correctly)", async () => {
    const lines = [
      buildBinding("steve-A", "sA", "worker_boot", "2026-06-04T01:00:00.000Z"),
      buildBinding("steve-B", "sB", "worker_boot", "2026-06-04T02:00:00.000Z"),
    ]
      .map((b) => JSON.stringify(b))
      .join("\n");
    const ra = await getActiveSessionBinding("steve-A", "/x", { reader: async () => lines });
    const rb = await getActiveSessionBinding("steve-B", "/x", { reader: async () => lines });
    expect(ra?.session_id).toBe("sA");
    expect(rb?.session_id).toBe("sB");
  });

  it("skips lines that don't parse", async () => {
    const garbage =
      "not json at all\n" +
      JSON.stringify(buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z")) +
      "\n" +
      "{ broken json\n";
    const r = await getActiveSessionBinding("u", "/x", { reader: async () => garbage });
    expect(r?.session_id).toBe("s");
  });
});

describe("ensureSessionId — fresh-vs-existing", () => {
  it("mints a fresh session id when no binding exists", async () => {
    const captured: string[] = [];
    const r = await ensureSessionId("u", "/x", "first_inbox_event", {
      now: () => new Date("2026-06-04T00:00:00.000Z"),
      rng: () => "fresh-sid",
      reader: async () => "",
      sink: async (line) => {
        captured.push(line);
      },
    });
    expect(r.fresh).toBe(true);
    expect(r.session_id).toBe("fresh-sid");
    expect(captured).toHaveLength(1);
  });

  it("reuses the existing session id and does NOT write a new binding", async () => {
    const existing = buildBinding(
      "u", "carried-sid", "worker_boot", "2026-06-04T00:00:00.000Z",
    );
    const captured: string[] = [];
    const r = await ensureSessionId("u", "/x", "first_inbox_event", {
      now: () => new Date("2026-06-04T02:00:00.000Z"),
      rng: () => "should-not-be-used",
      reader: async () => JSON.stringify(existing),
      sink: async (line) => {
        captured.push(line);
      },
    });
    expect(r.fresh).toBe(false);
    expect(r.session_id).toBe("carried-sid");
    expect(captured).toHaveLength(0);
  });
});

describe("verifyBindingSeal — tamper detection", () => {
  it("returns true for a clean binding", () => {
    const b = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    expect(verifyBindingSeal(b)).toBe(true);
  });

  it("returns false if session_id is silently changed", () => {
    const b = buildBinding("u", "s-original", "manual_resume", "2026-06-04T00:00:00.000Z");
    const tampered: CcSessionBinding = { ...b, session_id: "s-tampered" };
    expect(verifyBindingSeal(tampered)).toBe(false);
  });

  it("returns false if the trigger is silently changed", () => {
    const b = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    const tampered: CcSessionBinding = {
      ...b,
      context: { ...b.context, trigger: "worker_boot" },
    };
    expect(verifyBindingSeal(tampered)).toBe(false);
  });

  it("returns false if the at timestamp is silently changed", () => {
    const b = buildBinding("u", "s", "manual_resume", "2026-06-04T00:00:00.000Z");
    const tampered: CcSessionBinding = { ...b, at: "2099-01-01T00:00:00.000Z" };
    expect(verifyBindingSeal(tampered)).toBe(false);
  });
});

describe("computeBindingSealHash — canonical form is order-independent", () => {
  it("produces the same hash regardless of key insertion order in context", () => {
    const a = computeBindingSealHash({
      kind: "cc_session_bound",
      at: "2026-06-04T00:00:00.000Z",
      steve_uuid: "u",
      session_id: "s",
      context: { trigger: "manual_resume", note: "n" },
    });
    const b = computeBindingSealHash({
      kind: "cc_session_bound",
      at: "2026-06-04T00:00:00.000Z",
      steve_uuid: "u",
      session_id: "s",
      // same fields, different insertion order
      context: { note: "n", trigger: "manual_resume" },
    });
    expect(a).toBe(b);
  });
});
