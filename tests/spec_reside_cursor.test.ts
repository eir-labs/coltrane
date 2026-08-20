// RED — the cursor advances ONLY as a consequence of a sealed utterance, in the same write.
// Closes defect (1): the Kafka commit-before-process bug AND the live output_write ok-without-seal
// bug (output_write returned {ok:true,validated:true} while nothing sealed). The atomicity is fixed
// between the SEAL and the cursor, never between the ACK and the cursor.
//
// Covers I1 (cursor advances iff an utterance seals, bundled), I2 (the reflex ack never commits),
// I3 (a re-hosted box never re-answers a sealed message). Model-based (fast-check drives random op
// sequences), because these invariants must hold over the whole wake SPACE, not one path.
//
// RED because applyResidencyOp lives in the not-yet-authored src/residency.ts (loadResidency rejects).
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  loadResidency,
  resIn,
  canonicalOp,
  type ResidencyModule,
  type ResidencyOp,
  type ResidencyOpKind,
  type ResidencyRecord,
} from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

// A wake_seal op that either carries a real utterance sha or carries NONE (a consumed-but-unanswered
// attempt). message_index is threaded to the record's live cursor so ordering is honoured.
function wakeSeal(rec: ResidencyRecord, sha: string | null): ResidencyOp {
  return { ...canonicalOp("wake_seal", rec), message_index: rec.cursor, sealed_output_sha: sha };
}

describe("cursor advance is a consequence of the seal, one atomic fact (I1)", () => {
  it("I1 a wake with NO utterance (sealed_output_sha null/empty) NEVER advances the cursor", () => {
    fc.assert(
      fc.property(fc.constantFrom<string | null>(null, ""), (empty) => {
        const rec = resIn("listening");
        const r = R.applyResidencyOp(rec, wakeSeal(rec, empty));
        // A consumed-but-unanswered message is unrepresentable: the op is refused (the message stays
        // unconsumed, F7), or at the very least the cursor does not move.
        if (r.ok) {
          expect(r.next.cursor, "cursor advanced without a sealed utterance").toBe(rec.cursor);
        } else {
          expect(r.reason).toBe("cursor_without_seal");
        }
      }),
    );
  });

  it("I1 a wake WITH an utterance advances the cursor and records the seal in the SAME write", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (sha) => {
        const rec = resIn("listening");
        const r = R.applyResidencyOp(rec, wakeSeal(rec, sha));
        expect(r.ok, "a well-formed sealed wake was refused").toBe(true);
        if (r.ok) {
          // Bundled: cursor moved by exactly one AND the sealed sha is the one that moved it.
          expect(r.next.cursor).toBe(rec.cursor + 1);
          expect(r.next.last_sealed_sha).toBe(sha);
        }
      }),
    );
  });

  it("I1 NO op other than a sealed wake ever advances the cursor", () => {
    const nonSeal = ["claim", "listen", "play", "ack", "heartbeat", "hibernate", "thaw", "drain", "unseat", "reap"] as const;
    fc.assert(
      fc.property(fc.constantFrom<ResidencyOpKind>(...nonSeal), (kind) => {
        const rec = resIn("listening");
        const r = R.applyResidencyOp(rec, canonicalOp(kind, rec));
        if (r.ok) {
          expect(r.next.cursor, `${kind} advanced the cursor with no seal`).toBe(rec.cursor);
        }
      }),
    );
  });

  it("I1 MODEL: across any op sequence, cursor equals the count of sealed utterances", () => {
    const opArb = fc.oneof(
      fc.record({
        kind: fc.constant<ResidencyOpKind>("wake_seal"),
        sha: fc.option(fc.string({ minLength: 1 }), { nil: null }),
      }),
      fc.constantFrom<ResidencyOpKind>("ack", "heartbeat", "hibernate", "thaw", "play", "listen").map(
        (k) => ({ kind: k, sha: null as string | null }),
      ),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 20 }), (cmds) => {
        let rec = resIn("listening");
        let seals = 0;
        for (const c of cmds) {
          const op = c.kind === "wake_seal" ? wakeSeal(rec, c.sha) : canonicalOp(c.kind, rec);
          const r = R.applyResidencyOp(rec, op);
          if (r.ok) {
            if (c.kind === "wake_seal" && c.sha) seals += 1;
            rec = r.next;
          }
          // The load-bearing invariant: at no reachable point is the cursor ahead of the seals.
          expect(rec.cursor, "cursor ran ahead of the sealed utterances").toBe(seals);
        }
      }),
    );
  });
});

describe("the reflex ack does not commit (I2)", () => {
  it("I2 [receive, ack] with no seal leaves the cursor byte-identical", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (cursor) => {
        const rec = resIn("listening", { cursor });
        const r = R.applyResidencyOp(rec, canonicalOp("ack", rec));
        if (r.ok) expect(r.next.cursor).toBe(cursor);
      }),
    );
  });
});

describe("a re-hosted box never re-answers a sealed message (I3)", () => {
  it("I3 seal under host A, hand the row to host B, replay the same message → no new utterance", () => {
    const a = resIn("listening", { host: "box.A" });
    const sealed = R.applyResidencyOp(a, wakeSeal(a, "sha-M0"));
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // Host B picks up the SAME durable row — cursor has advanced past M0, fence carried forward.
    const b: ResidencyRecord = { ...sealed.next, host: "box.B" };
    // Replaying message index 0 (already consumed) must be refused; the cursor cannot move again.
    const replay = R.applyResidencyOp(b, { ...wakeSeal(b, "sha-M0-again"), message_index: 0 });
    expect(replay.ok, "a re-hosted box re-answered an already-sealed message").toBe(false);
  });

  it("I3 MODEL: across any host-swap sequence, cursor is monotonic and never re-answers", () => {
    const cmdArb = fc.oneof(
      fc.constant<{ t: "seal" }>({ t: "seal" }),
      fc.record({ t: fc.constant<"rehost">("rehost"), host: fc.constantFrom("box.A", "box.B", "box.C") }),
    );
    fc.assert(
      fc.property(fc.array(cmdArb, { maxLength: 20 }), (cmds) => {
        let rec = resIn("listening", { host: "box.A" });
        let prevCursor = rec.cursor;
        const answered = new Set<number>();
        for (const c of cmds) {
          if (c.t === "rehost") {
            rec = { ...rec, host: c.host };
            continue;
          }
          const idx = rec.cursor;
          const r = R.applyResidencyOp(rec, { ...wakeSeal(rec, `sha-${idx}`), message_index: idx });
          if (r.ok) {
            expect(answered.has(idx), `message ${idx} was answered twice across a host swap`).toBe(false);
            answered.add(idx);
            expect(r.next.cursor, "cursor moved backwards").toBeGreaterThanOrEqual(prevCursor);
            prevCursor = r.next.cursor;
            rec = r.next;
          }
        }
      }),
    );
  });
});
