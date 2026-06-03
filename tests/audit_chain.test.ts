// audit_chain.test.ts — forward-sha chain on Steve audit streams.
// Tamper anywhere in the past → verifyAuditChain reports the exact break point.

import { describe, it, expect } from "vitest";
import {
  AuditEvent,
  chainEvent,
  computeSealForEvent,
  verifyAuditChain,
  parseAuditLine,
  GENESIS_PREV_SHA,
} from "../src/audit_chain.js";

function makeBody(
  session: string,
  ts: string,
  kind: AuditEvent["kind"] = "react",
  primitive: AuditEvent["primitive"] = "SENSE",
  payload: Record<string, unknown> = { name: "seedling" },
): Omit<AuditEvent, "prev_sha" | "sha_seal"> {
  return {
    session_uuid: session,
    ts,
    surface: "hands",
    kind,
    primitive,
    payload,
  };
}

function buildStream(session: string, count: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev: AuditEvent | null = null;
  for (let i = 0; i < count; i++) {
    const body = makeBody(session, `2026-06-03T14:${String(40 + i).padStart(2, "0")}:00Z`);
    const next = chainEvent(prev, body);
    out.push(next);
    prev = next;
  }
  return out;
}

describe("GENESIS_PREV_SHA — deterministic sentinel", () => {
  it("is the sha256 of literal 'GENESIS'", () => {
    // pinned value so anyone can verify by hand: sha256('GENESIS') in any language.
    expect(GENESIS_PREV_SHA).toBe(
      "901131d838b17aac0f7885b81e03cbdc9f5157a00343d30ab22083685ed1416a",
    );
  });
});

describe("chainEvent + verifyAuditChain — happy path", () => {
  it("genesis event has prev_sha = GENESIS_PREV_SHA and a valid sha_seal", () => {
    const body = makeBody("s1", "2026-06-03T14:40:00Z");
    const e = chainEvent(null, body);
    expect(e.prev_sha).toBe(GENESIS_PREV_SHA);
    expect(e.sha_seal).toHaveLength(64);
    // sha_seal is reproducible
    expect(computeSealForEvent(e)).toBe(e.sha_seal);
  });

  it("each event's prev_sha matches the predecessor's sha_seal", () => {
    const stream = buildStream("s1", 5);
    for (let i = 1; i < stream.length; i++) {
      expect(stream[i]!.prev_sha).toBe(stream[i - 1]!.sha_seal);
    }
  });

  it("verifies a clean 100-event stream", () => {
    const stream = buildStream("s1", 100);
    const r = verifyAuditChain(stream);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.length).toBe(100);
  });

  it("empty stream is ok", () => {
    const r = verifyAuditChain([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.length).toBe(0);
  });
});

describe("verifyAuditChain — tamper detection", () => {
  it("catches a payload edit on a past event at the EXACT index", () => {
    const stream = buildStream("s1", 50);
    // silently mutate event 17's payload but leave sha_seal alone
    const tampered = stream.map((e, i) =>
      i === 17 ? { ...e, payload: { name: "tampered" } } : e,
    );
    const r = verifyAuditChain(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(17);
      expect(r.reason).toBe("sha_seal_mismatch");
    }
  });

  it("catches a sha_seal recompute on a past event — chain breaks at next index", () => {
    // attacker edits past event payload AND recomputes its sha_seal honestly.
    // the forward-sha link still breaks: the NEXT event's prev_sha references
    // the OLD sha_seal, so verification fails at index 18 (not 17).
    const stream = buildStream("s1", 50);
    const tampered = stream.map((e, i) => {
      if (i === 17) {
        const edited: AuditEvent = { ...e, payload: { name: "tampered" }, sha_seal: "" };
        return { ...edited, sha_seal: computeSealForEvent(edited) };
      }
      return e;
    });
    const r = verifyAuditChain(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(18);
      expect(r.reason).toBe("prev_sha_mismatch");
    }
  });

  it("catches a deleted event — chain breaks at the deletion seam", () => {
    const stream = buildStream("s1", 50);
    // drop event 25
    const truncated = [...stream.slice(0, 25), ...stream.slice(26)];
    const r = verifyAuditChain(truncated);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(25);
      expect(r.reason).toBe("prev_sha_mismatch");
    }
  });

  it("catches an inserted-from-another-stream event", () => {
    const a = buildStream("s1", 30);
    const b = buildStream("s2", 30);
    const mixed = [...a.slice(0, 15), b[15]!, ...a.slice(15)];
    const r = verifyAuditChain(mixed);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(15);
      expect(r.reason).toBe("stream_session_uuid_mismatch");
    }
  });

  it("catches an event whose prev_sha is forged but doesn't match predecessor", () => {
    const stream = buildStream("s1", 10);
    const forged = stream.map((e, i) =>
      i === 5 ? { ...e, prev_sha: "0".repeat(64) } : e,
    );
    const r = verifyAuditChain(forged);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(5);
      expect(r.reason).toBe("prev_sha_mismatch");
      expect(r.expected).toBe(stream[4]!.sha_seal);
    }
  });

  it("catches a tampered genesis prev_sha", () => {
    const stream = buildStream("s1", 5);
    const tampered = [{ ...stream[0]!, prev_sha: "f".repeat(64) }, ...stream.slice(1)];
    const r = verifyAuditChain(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(0);
      expect(r.reason).toBe("genesis_prev_sha_mismatch");
    }
  });

  it("catches an event with empty session_uuid", () => {
    const stream = buildStream("", 1);
    const r = verifyAuditChain(stream);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.broken_at).toBe(0);
      expect(r.reason).toBe("empty_session_uuid");
    }
  });
});

describe("parseAuditLine — jsonl reader", () => {
  it("round-trips an event through JSON.stringify + parseAuditLine", () => {
    const body = makeBody("s1", "2026-06-03T14:40:00Z");
    const e = chainEvent(null, body);
    const line = JSON.stringify(e);
    const parsed = parseAuditLine(line);
    expect(parsed).toEqual(e);
  });

  it("returns null on parse error", () => {
    expect(parseAuditLine("not json")).toBeNull();
    expect(parseAuditLine("")).toBeNull();
    expect(parseAuditLine("  ")).toBeNull();
  });
});

describe("verifyAuditChain — large stream", () => {
  it("verifies a 1000-event stream in reasonable time", () => {
    const stream = buildStream("s1", 1000);
    const start = Date.now();
    const r = verifyAuditChain(stream);
    const ms = Date.now() - start;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.length).toBe(1000);
    // sanity: should be well under 500ms on any reasonable hardware
    expect(ms).toBeLessThan(2000);
  });
});
