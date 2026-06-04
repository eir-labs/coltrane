// audit_chain_replay.test.ts — U7 bug-bash: sha-replay vs tamper distinguishability.
//
// Does verifyAuditChain distinguish a REPLAY (B's body re-inserted later with a
// fresh prev_sha) from byte-level TAMPER? Loud receipt below.

import { describe, it, expect } from "vitest";
import {
  AuditEvent,
  chainEvent,
  computeSealForEvent,
  verifyAuditChain,
  GENESIS_PREV_SHA,
} from "../src/audit_chain.js";

function body(session: string, n: number, payload: Record<string, unknown>) {
  return {
    session_uuid: session,
    ts: `2026-06-04T10:${String(10 + n).padStart(2, "0")}:00Z`,
    surface: "hands" as const,
    kind: "react" as const,
    primitive: "SENSE" as const,
    payload,
  };
}

function buildABCD(session: string): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev: AuditEvent | null = null;
  for (let i = 0; i < 4; i++) {
    const e = chainEvent(prev, body(session, i, { letter: "ABCD"[i], i }));
    out.push(e);
    prev = e;
  }
  return out;
}

describe("U7 sha-replay vs tamper distinguishability", () => {
  it("distinguishes byte-tamper from chain-valid replay", () => {
    // ── TAMPER: mutate B's payload + re-seal. C's prev_sha now mismatches. ──
    const tChain = buildABCD("u7-tamper");
    const Bt = tChain[1]!;
    const Bmut: AuditEvent = {
      ...Bt,
      payload: { ...(Bt.payload as Record<string, unknown>), letter: "EVIL" },
      sha_seal: "",
    };
    Bmut.sha_seal = computeSealForEvent(Bmut);
    const tRes = verifyAuditChain([tChain[0]!, Bmut, tChain[2]!, tChain[3]!]);
    const tamperCaught = !tRes.ok;
    if (!tRes.ok) {
      expect(tRes.broken_at).toBe(2);
      expect(tRes.reason).toBe("prev_sha_mismatch");
    }

    // ── REPLAY: append a copy of B's body as E, prev_sha = D.sha_seal. ──
    const rChain = buildABCD("u7-replay");
    const B = rChain[1]!;
    const D = rChain[3]!;
    const Ebody: Omit<AuditEvent, "prev_sha" | "sha_seal"> = {
      session_uuid: B.session_uuid,
      ts: B.ts,
      surface: B.surface,
      kind: B.kind,
      primitive: B.primitive ?? null,
      payload: B.payload ?? {},
    };
    const E = chainEvent(D, Ebody);
    const replayed = [...rChain, E];
    const rRes = verifyAuditChain(replayed);
    const replayCaught = !rRes.ok;

    // Independent witness: duplicate body in stream.
    const seen = new Set<string>();
    let dupBodies = 0;
    for (const e of replayed) {
      const key = JSON.stringify({ ts: e.ts, kind: e.kind, primitive: e.primitive, payload: e.payload });
      if (seen.has(key)) dupBodies++;
      else seen.add(key);
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n─── sha_replay receipt ─── tamper_caught=${tamperCaught} replay_caught=${replayCaught} dup_bodies=${dupBodies}\n`,
    );

    // Receipts:
    expect(tamperCaught).toBe(true);  // byte tamper IS caught
    expect(replayCaught).toBe(false); // FINDING: replay is NOT caught
    expect(dupBodies).toBe(1);        // but a duplicate body exists in the stream
    expect(rChain[0]!.prev_sha).toBe(GENESIS_PREV_SHA);
  });
});
