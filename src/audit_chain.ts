/**
 * audit_chain.ts — forward-sha linking on Steve audit streams.
 *
 * The cajal-substrate (PR #40) defines per-event sha_seal (self-hash). That
 * detects mutation of a single event. What it does NOT detect: silent edits
 * to PAST events while leaving sha_seal recomputed.
 *
 * This module adds the forward link. Each event carries prev_sha = sha_seal
 * of the previous event in the stream. Mutating any past event invalidates
 * every event after it; verifyAuditChain() walks the stream and reports the
 * exact break point.
 *
 * Append-only discipline becomes mechanical: the chain says where it broke,
 * no narrative needed.
 *
 * Authored by subhuti under chain-keeper discipline.
 */

import { sha256Hex, canonJson } from "./canonical_form.js";

/**
 * Shape of one entry in a Steve's audit.jsonl. Matches PR #40's domain_types
 * schema with one additive field: prev_sha.
 *
 * prev_sha = sha_seal of the immediately preceding event in this stream.
 * The genesis event (index 0) has prev_sha = GENESIS_PREV_SHA (a known
 * sentinel) so verification has a defined starting point.
 */
export interface AuditEvent {
  event_id?: string;
  session_uuid: string;
  ts: string;
  surface: "head" | "hands";
  kind:
    | "react"
    | "post"
    | "tool_call"
    | "verdict"
    | "name_event"
    | "primitive_engage";
  primitive?: "SENSE" | "INTERPRET" | "JUDGE" | "PLAN" | "CREATE" | "VERIFY" | null;
  gig_id?: string;
  payload?: Record<string, unknown>;
  prev_sha: string;
  sha_seal: string;
}

/**
 * Sentinel prev_sha for the first event in a stream. Same length as a real
 * sha256 so JSON-schema validators don't choke; the value itself is the
 * sha256 of the literal string "GENESIS" — verifiable by anyone.
 */
export const GENESIS_PREV_SHA = sha256Hex("GENESIS");

/**
 * Compute sha_seal for an event: sha256 of the canonical-JSON of the event
 * with sha_seal set to the empty string. This matches the cajal schema's
 * "sha_seal field empty" rule + lets verifyAuditChain reproduce the seal
 * independently to detect tampering with the event body.
 */
export function computeSealForEvent(event: AuditEvent): string {
  const { sha_seal: _ignored, ...rest } = event;
  const withEmptySeal: AuditEvent = { ...event, sha_seal: "" };
  // Ensure the field is present and empty, then canonicalize.
  void _ignored;
  void rest;
  return sha256Hex(canonJson(withEmptySeal));
}

/**
 * Build the next event in the chain from a partial body + the predecessor
 * event (or null if this is the genesis event). Returns a fully-sealed
 * event with prev_sha and sha_seal populated.
 */
export function chainEvent(
  prev: AuditEvent | null,
  body: Omit<AuditEvent, "prev_sha" | "sha_seal">,
): AuditEvent {
  const prev_sha = prev ? prev.sha_seal : GENESIS_PREV_SHA;
  const draft: AuditEvent = { ...body, prev_sha, sha_seal: "" };
  const sha_seal = computeSealForEvent(draft);
  return { ...draft, sha_seal };
}

export type ChainVerifyOk = { ok: true; length: number };
export type ChainVerifyBroken = {
  ok: false;
  broken_at: number;
  reason:
    | "prev_sha_mismatch"
    | "sha_seal_mismatch"
    | "genesis_prev_sha_mismatch"
    | "empty_session_uuid"
    | "stream_session_uuid_mismatch";
  expected?: string;
  found?: string;
  context?: string;
};
export type ChainVerifyResult = ChainVerifyOk | ChainVerifyBroken;

/**
 * Walk the audit stream and verify the forward-sha chain.
 *
 * Returns ok=true if every event's prev_sha matches the predecessor's
 * sha_seal AND every event's sha_seal is the canonical seal of its own
 * body. Returns ok=false with broken_at = first index that fails.
 *
 * Also asserts every event shares the same session_uuid (a stream
 * belongs to one Steve).
 */
export function verifyAuditChain(events: AuditEvent[]): ChainVerifyResult {
  if (events.length === 0) return { ok: true, length: 0 };

  const sessionUuid = events[0]?.session_uuid;
  if (!sessionUuid) {
    return {
      ok: false,
      broken_at: 0,
      reason: "empty_session_uuid",
      context: "first event has no session_uuid",
    };
  }

  let prev: AuditEvent | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;

    // 1. Session-uuid consistency across the stream.
    if (e.session_uuid !== sessionUuid) {
      return {
        ok: false,
        broken_at: i,
        reason: "stream_session_uuid_mismatch",
        expected: sessionUuid,
        found: e.session_uuid,
      };
    }

    // 2. prev_sha must link to predecessor's sha_seal (or GENESIS for index 0).
    const expectedPrev = prev ? prev.sha_seal : GENESIS_PREV_SHA;
    if (e.prev_sha !== expectedPrev) {
      return {
        ok: false,
        broken_at: i,
        reason:
          i === 0 ? "genesis_prev_sha_mismatch" : "prev_sha_mismatch",
        expected: expectedPrev,
        found: e.prev_sha,
      };
    }

    // 3. sha_seal must be the canonical seal of this event's body.
    const recomputed = computeSealForEvent(e);
    if (e.sha_seal !== recomputed) {
      return {
        ok: false,
        broken_at: i,
        reason: "sha_seal_mismatch",
        expected: recomputed,
        found: e.sha_seal,
      };
    }

    prev = e;
  }

  return { ok: true, length: events.length };
}

/**
 * Convenience for callers that read jsonl files directly: parse one line as
 * an AuditEvent. Returns null on parse error.
 */
export function parseAuditLine(line: string): AuditEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AuditEvent;
  } catch {
    return null;
  }
}
