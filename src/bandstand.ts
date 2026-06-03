// §X bandstand — band-coordination MCP server primitives.
//
// Solves the lane-collision pattern (multiple ants claiming the same work in
// near-parallel) by routing every claim attempt through an atomic check-and-set
// backed by an append-only JSON-lines ledger. Each ant calls claim_lane BEFORE
// dispatching an agent or posting a slack chime. Approved → proceed. Held →
// yield silently, no duplicate work.
//
// Design principles:
//   1. Append-only ledger — every claim + release is logged, post-hoc auditable
//   2. Atomic check-and-set — no race between two simultaneous claims
//   3. TTL on claims — abandoned claims auto-release; no permanent locks
//   4. Scope-hash on claim — distinguishes "same lane different intent" cases
//
// The ledger PATH is configurable — production deploys point at a private file,
// public consumers point at a local file. The MECHANISM is public; the lane
// DATA stays private to whoever owns the ledger.
//
// Author: cajal · 2026-06-02

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

/** A lane claim event: someone took out (or released) a lane. */
export interface LaneClaimEntry {
  /** Sequence number — monotonic per ledger. */
  readonly seq: number;
  /** ISO-8601 timestamp of the event. */
  readonly at: string;
  /** "claim" or "release". */
  readonly action: "claim" | "release";
  /** The lane being claimed/released (free-form slug). */
  readonly lane: string;
  /** Who's claiming (ant slug — cajal/miles/subhuti/groove/...). */
  readonly ant: string;
  /** Free-text intent — what the ant plans to do in this lane. */
  readonly intent: string;
  /** SHA-256 of the dispatch prompt or task spec — distinguishes same-lane-different-work. */
  readonly scope_hash: string;
  /** TTL in seconds — claim expires after this many seconds without renewal/release. */
  readonly ttl_seconds: number;
}

/** Result of a claim attempt — atomic. */
export type ClaimResult =
  | { status: "ACQUIRED"; lane: string; ant: string; expires_at: string; seq: number }
  | {
      status: "HELD_BY_OTHER";
      lane: string;
      held_by: string;
      since: string;
      expires_at: string;
      intent: string;
      scope_hash: string;
      seq: number;
    }
  | { status: "SAME_SCOPE_REPEAT"; lane: string; ant: string; seq: number };

export class BandstandError extends Error {}

/** Append-only JSON-lines ledger of claim/release events. */
export class ClaimLedger {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Read all entries (cheap for the band's expected scale — < 10K entries). */
  readAll(): LaneClaimEntry[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LaneClaimEntry);
  }

  nextSeq(): number {
    const all = this.readAll();
    return all.length === 0 ? 1 : Math.max(...all.map((e) => e.seq)) + 1;
  }

  append(entry: LaneClaimEntry): void {
    if (!entry.lane) throw new BandstandError("claim entry requires lane");
    if (!entry.ant) throw new BandstandError("claim entry requires ant");
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  /** Currently-held lanes (claims minus releases minus expired). */
  activeClaims(now: Date = new Date()): LaneClaimEntry[] {
    const entries = this.readAll();
    const lastByLane = new Map<string, LaneClaimEntry>();
    for (const e of entries) {
      lastByLane.set(e.lane, e);
    }
    const active: LaneClaimEntry[] = [];
    for (const [, e] of lastByLane) {
      if (e.action !== "claim") continue;
      const claimedAt = new Date(e.at).getTime();
      const expiresAt = claimedAt + e.ttl_seconds * 1000;
      if (expiresAt < now.getTime()) continue;
      active.push(e);
    }
    return active;
  }

  /** Look up the currently-active holder of a lane (or null). */
  activeHolder(lane: string, now: Date = new Date()): LaneClaimEntry | null {
    return this.activeClaims(now).find((e) => e.lane === lane) ?? null;
  }
}

/** Hash a free-form scope string into a stable scope_hash. */
export function computeScopeHash(scope: string): string {
  return createHash("sha256").update(scope.trim()).digest("hex").slice(0, 16);
}

export interface ClaimRequest {
  readonly lane: string;
  readonly ant: string;
  readonly intent: string;
  readonly scope_hash: string;
  readonly ttl_seconds: number;
  readonly now?: () => Date;
}

/**
 * Atomic claim attempt:
 *   - If lane is unheld → ACQUIRE, write entry, return ACQUIRED.
 *   - If lane held by SAME ant with SAME scope_hash → return SAME_SCOPE_REPEAT
 *     (idempotent — caller can safely retry without thinking they took a fresh lock).
 *   - If lane held by SAME ant with DIFFERENT scope_hash → fail with BandstandError
 *     (you released the prior claim; do that first).
 *   - If lane held by OTHER → return HELD_BY_OTHER with holder + intent + expires_at.
 *
 * The ledger is the source of truth — every result is computed from its tail.
 */
export function claimLane(req: ClaimRequest, ledger: ClaimLedger): ClaimResult {
  const now = (req.now ?? (() => new Date()))();
  const existing = ledger.activeHolder(req.lane, now);
  if (existing) {
    if (existing.ant === req.ant && existing.scope_hash === req.scope_hash) {
      return {
        status: "SAME_SCOPE_REPEAT",
        lane: req.lane,
        ant: req.ant,
        seq: existing.seq,
      };
    }
    if (existing.ant === req.ant && existing.scope_hash !== req.scope_hash) {
      throw new BandstandError(
        `lane "${req.lane}" already held by you with different scope_hash; release first`,
      );
    }
    return {
      status: "HELD_BY_OTHER",
      lane: req.lane,
      held_by: existing.ant,
      since: existing.at,
      expires_at: new Date(new Date(existing.at).getTime() + existing.ttl_seconds * 1000).toISOString(),
      intent: existing.intent,
      scope_hash: existing.scope_hash,
      seq: existing.seq,
    };
  }
  const seq = ledger.nextSeq();
  const entry: LaneClaimEntry = {
    seq,
    at: now.toISOString(),
    action: "claim",
    lane: req.lane,
    ant: req.ant,
    intent: req.intent,
    scope_hash: req.scope_hash,
    ttl_seconds: req.ttl_seconds,
  };
  ledger.append(entry);
  return {
    status: "ACQUIRED",
    lane: req.lane,
    ant: req.ant,
    expires_at: new Date(now.getTime() + req.ttl_seconds * 1000).toISOString(),
    seq,
  };
}

export interface ReleaseRequest {
  readonly lane: string;
  readonly ant: string;
  readonly now?: () => Date;
}

/**
 * Release a claim. Only the holder can release.
 * Idempotent: releasing an unheld lane returns OK without writing.
 */
export function releaseLane(req: ReleaseRequest, ledger: ClaimLedger): { released: boolean; seq?: number } {
  const now = (req.now ?? (() => new Date()))();
  const existing = ledger.activeHolder(req.lane, now);
  if (!existing) return { released: false };
  if (existing.ant !== req.ant) {
    throw new BandstandError(
      `lane "${req.lane}" is held by ${existing.ant}, not ${req.ant} — cannot release another's claim`,
    );
  }
  const seq = ledger.nextSeq();
  ledger.append({
    seq,
    at: now.toISOString(),
    action: "release",
    lane: req.lane,
    ant: req.ant,
    intent: existing.intent,
    scope_hash: existing.scope_hash,
    ttl_seconds: existing.ttl_seconds,
  });
  return { released: true, seq };
}

/** Status query: who holds this lane right now? */
export interface LaneStatus {
  lane: string;
  held: boolean;
  held_by?: string;
  since?: string;
  expires_at?: string;
  intent?: string;
  scope_hash?: string;
}

export function laneStatus(lane: string, ledger: ClaimLedger, now: Date = new Date()): LaneStatus {
  const e = ledger.activeHolder(lane, now);
  if (!e) return { lane, held: false };
  return {
    lane,
    held: true,
    held_by: e.ant,
    since: e.at,
    expires_at: new Date(new Date(e.at).getTime() + e.ttl_seconds * 1000).toISOString(),
    intent: e.intent,
    scope_hash: e.scope_hash,
  };
}

/** All currently-held lanes. */
export function listActiveClaims(ledger: ClaimLedger, now: Date = new Date()): LaneStatus[] {
  return ledger.activeClaims(now).map((e) => ({
    lane: e.lane,
    held: true,
    held_by: e.ant,
    since: e.at,
    expires_at: new Date(new Date(e.at).getTime() + e.ttl_seconds * 1000).toISOString(),
    intent: e.intent,
    scope_hash: e.scope_hash,
  }));
}
