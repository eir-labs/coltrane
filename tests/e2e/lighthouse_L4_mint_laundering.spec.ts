// Lighthouse L4 — mint-laundering / cross-voice transfer detection.
//
// Pre-registered in `/eir/coltrane/docs/e2e_test_status_full.json`:
//   "L4_g4_mint_laundering_cross_voice_transfer": {
//     shape: "voice A's credit cannot be transferred to voice B.
//             validator must reject cross-voice ledger writes.",
//     status: "MISSING", owner: "lighthouse"
//   }
//
// Attack captured:
//   1. Voice A legitimately mints a value (event e1 in A's audit stream).
//   2. Voice B forges a follow-on event e2 that:
//      - sets prev_sha = sha(e1)  — claiming causal-mint provenance from A
//      - mints a derived value Y attributed to B
//      - but B never received authorization to derive from A's mint
//   3. The audit-chain / ledger validator MUST reject this. The mint primitive
//      should require that a derived event's voice_id either matches the
//      predecessor's voice_id, or carries an explicit cross-voice grant.
//
// THIS TEST IS APOHA-DECLARED. It is NOT testing:
//   - byte-tamper of a single event (covered: audit_chain.test.ts — sha_seal_mismatch)
//   - prev_sha rewrite to a stale predecessor (covered: tamper_in_flight.py)
//   - replay attacks (covered: PR #82 / audit_chain_replay.test.ts — known RED, U7)
//   - within-voice happy-path chain verification (covered: audit_chain.test.ts)
//   - settlement self-grading (that is L1's apoha space)
// L4 is specifically: a structurally-valid chain link that nevertheless transfers
// credit ACROSS voice identities without a declared cross-voice authorization.
//
// RED-honest expected. The current audit_chain.ts + ledger.ts have NO voice_id
// field and NO cross-voice validator surface. The test surfaces that gap by:
//   (a) asserting the validator entry-point exists (will FAIL — unwired),
//   (b) if/when wired, asserting it rejects the laundered event.

import { describe, it, expect } from "vitest";
import {
  type AuditEvent,
  chainEvent,
  verifyAuditChain,
} from "../../src/audit_chain.js";
import { MemoryLedger, type LedgerEntry } from "../../src/ledger.js";

// ---------- helpers ----------

// "voice_id" is the band-architecture identifier for a single agent-voice in
// the audit chain. The current AuditEvent shape does NOT carry voice_id as a
// first-class field; we stash it inside payload so the test can reason about
// the attack shape today and the validator can be wired tomorrow against the
// same key. session_uuid is per-session, NOT per-voice (one voice can run many
// sessions), so it cannot serve as the voice identity gate.
type VoicedEvent = AuditEvent & { payload: { voice_id: string; minted_value?: string; derived_from?: string } };

function voicedBody(
  session: string,
  ts: string,
  voice_id: string,
  payload: Record<string, unknown>,
): Omit<AuditEvent, "prev_sha" | "sha_seal"> {
  return {
    session_uuid: session,
    ts,
    surface: "hands",
    kind: "primitive_engage",
    primitive: "CREATE",
    payload: { voice_id, ...payload },
  };
}

// Probe: does the chain module expose a cross-voice / mint-derivation validator?
// We deliberately reach for several plausible export names so the test stays
// honest if the wired validator lands under any of them.
async function loadCrossVoiceValidator(): Promise<unknown> {
  const mod = await import("../../src/audit_chain.js");
  const m = mod as Record<string, unknown>;
  return (
    m.verifyMintDerivation ??
    m.verifyCrossVoiceTransfer ??
    m.validateMintDerivation ??
    m.InvalidMintDerivation ??
    null
  );
}

// ---------- the attack scenario ----------

describe("Lighthouse L4 — mint-laundering / cross-voice transfer", () => {
  it("constructs the attack: e2 (voice B) claims prev_sha=sha(e1) from voice A and mints derived value", () => {
    // Genesis: voice A's session opens.
    const e0 = chainEvent(
      null,
      voicedBody("session-A", "2026-06-04T10:00:00Z", "voice-A", {
        note: "genesis",
      }),
    ) as VoicedEvent;

    // e1: voice A legitimately mints value X.
    const e1 = chainEvent(
      e0,
      voicedBody("session-A", "2026-06-04T10:01:00Z", "voice-A", {
        minted_value: "X",
      }),
    ) as VoicedEvent;

    // e2: voice B forges a derivation. It links prev_sha=sha(e1) so the
    // forward-sha chain validates clean. But voice_id flips A→B, AND e2 mints
    // value Y claiming derived_from=X — without any cross-voice grant event
    // from A authorizing B to derive.
    //
    // Note: We keep session_uuid="session-A" so the existing
    // stream_session_uuid_mismatch guard does NOT fire (the attacker is sharp
    // enough to reuse the session header). This is what makes laundering
    // distinct from a naive forgery.
    const e2 = chainEvent(
      e1,
      voicedBody("session-A", "2026-06-04T10:02:00Z", "voice-B", {
        minted_value: "Y",
        derived_from: "X",
      }),
    ) as VoicedEvent;

    // The forward-sha chain is structurally valid: e2's prev_sha == e1.sha_seal.
    expect(e2.prev_sha).toBe(e1.sha_seal);

    // And voice_id genuinely flipped between e1 and e2.
    expect(e1.payload.voice_id).toBe("voice-A");
    expect(e2.payload.voice_id).toBe("voice-B");
  });

  it("RED-honest: chain validator MUST reject the laundered stream (currently fails — no voice-id gate)", () => {
    const e0 = chainEvent(
      null,
      voicedBody("session-A", "2026-06-04T10:00:00Z", "voice-A", { note: "genesis" }),
    );
    const e1 = chainEvent(
      e0,
      voicedBody("session-A", "2026-06-04T10:01:00Z", "voice-A", { minted_value: "X" }),
    );
    const e2 = chainEvent(
      e1,
      voicedBody("session-A", "2026-06-04T10:02:00Z", "voice-B", {
        minted_value: "Y",
        derived_from: "X",
      }),
    );

    const result = verifyAuditChain([e0, e1, e2]);

    // The expected GREEN state when the cross-voice gate lands:
    //   result.ok === false, broken_at === 2, reason ~ /cross_voice/.
    // Currently this assertion FAILS RED because verifyAuditChain only checks
    // session_uuid + sha linkage; voice_id is invisible to it. That failure
    // is the L4 finding.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.broken_at).toBe(2);
      expect(result.reason).toMatch(/cross_voice|mint_derivation|unauthorized/);
    }
  });

  it("RED-honest: cross-voice / mint-derivation validator export MUST exist on audit_chain.ts (currently fails — unwired)", async () => {
    const validator = await loadCrossVoiceValidator();
    // Will FAIL RED today — none of the probed names are exported. When the
    // validator lands under any of: verifyMintDerivation, verifyCrossVoiceTransfer,
    // validateMintDerivation, or InvalidMintDerivation, this test goes GREEN.
    expect(validator).not.toBeNull();
  });

  it("RED-honest: ledger MUST reject a cross-voice-attributed entry (currently fails — no voice gate)", () => {
    // LedgerEntry has no voice_id field at all — the credit-attribution layer
    // is voice-blind. A laundered mint sails straight in.
    const ledger = new MemoryLedger();
    const laundered: LedgerEntry = {
      gig_id: "gig-A-laundered",
      standard_slug: "test_std",
      genome_hash: "deadbeef",
      run_fingerprint: "fp_cross_voice",
      output_hashes: ["sha256:Y"],
      started_at: "2026-06-04T10:02:00Z",
      finished_at: "2026-06-04T10:02:30Z",
    };

    // Expected GREEN: a cross-voice append throws or the LedgerEntry shape
    // carries a voice_id that the validator pins. Currently FAILS RED — the
    // ledger has no concept of voice ownership, so it silently accepts.
    expect(() => ledger.append(laundered)).toThrow(/voice|cross|mint|unauthorized/i);
  });

  it("the GREEN-shape the validator should enforce — pinned for the next PR", () => {
    // Documenting the target behavior so the L4-fix PR has an executable spec.
    //
    // When validateMintDerivation lands, the laundered stream above MUST be
    // rejected with reason="cross_voice_mint_without_grant" (or equivalent),
    // and broken_at=2 (the index of the forged e2).
    //
    // Until that lands, this scaffold-assertion is a TODO marker.
    const targetReason = "cross_voice_mint_without_grant";
    expect(targetReason).toMatch(/cross_voice/);
    // Apoha: this test does NOT prescribe the exact error-class name, only
    // that a reason mentioning cross-voice attribution surfaces at broken_at=2.
  });
});
