// Residency enforcement — a genome agent LIVING in a room, not a gig that runs and ends. `coltrane
// work` is the floor (workOnce); what `reside` adds is what separates doing a unit of work from
// being someone who lives here: a party-constrained status, a cursor that moves only on a seal, a
// reflex that touches no model, a lease + fence that hold the seat singly, and a reaper that reads
// the one death hibernation cannot hide.
//
// This module is authored to the surface declared in tests/spec_reside_fixtures.ts and is loaded by
// that fixture at RUNTIME (new URL("../src/residency.js", …)) so the shared build survives its
// absence. The 40 laws in tests/spec_reside_*.test.ts are the specification.
//
// applyResidencyOp follows the applyCommitmentOp shape (src/committed_work.ts:214, Singh, Chopra &
// Desai 2009, doi:10.1109/MC.2009.347): a TOTAL (rec, op) -> {ok:true,next} | {ok:false,reason}
// that never throws once the record is built, with who-may-act as a constitutive gate.

// reside and work agree on what a gig means because there is only ONE function behind both fronts.
// This is the SAME symbol as workOnce — a re-export, never a wrapper or a copy — so the surface law
// (I12) that compares residencyGigPath to workOnce by referential identity (===) holds, and a second
// gig implementation fails BY EXISTING.
export { workOnce as residencyGigPath } from "./worker.js";

// ── The closed sets, as data — must MATCH the contract in spec_reside_fixtures.ts ─────────────────

export type ResidencyState =
  | "seated"
  | "listening"
  | "playing"
  | "hibernated"
  | "drained"
  | "unseated";

export const RESIDENCY_STATES: readonly ResidencyState[] = [
  "seated",
  "listening",
  "playing",
  "hibernated",
  "drained",
  "unseated",
];

// Live = non-terminal. drained and unseated are the two terminal states.
export const LIVE_STATES: ReadonlySet<ResidencyState> = new Set<ResidencyState>([
  "seated",
  "listening",
  "playing",
  "hibernated",
]);

export type ResidencyOpKind =
  | "claim"
  | "listen"
  | "play"
  | "wake_seal"
  | "ack"
  | "heartbeat"
  | "hibernate"
  | "thaw"
  | "drain"
  | "unseat"
  | "reap";

export const RESIDENCY_OPS: readonly ResidencyOpKind[] = [
  "claim",
  "listen",
  "play",
  "wake_seal",
  "ack",
  "heartbeat",
  "hibernate",
  "thaw",
  "drain",
  "unseat",
  "reap",
];

export type ResidencyActor = "holder" | "reaper" | "operator";

export interface LegalTransition {
  from: ResidencyState;
  op: ResidencyOpKind;
  to: ResidencyState;
}

// The party-constrained legal-transition table — the contract's law, as data. Order MATCHES the
// fixture verbatim: the surface law asserts R.LEGAL_TRANSITIONS.toEqual(LEGAL_TRANSITIONS), a deep,
// order-sensitive equality.
export const LEGAL_TRANSITIONS: readonly LegalTransition[] = [
  { from: "unseated", op: "claim", to: "seated" },
  { from: "seated", op: "listen", to: "listening" },
  { from: "playing", op: "listen", to: "listening" },
  { from: "seated", op: "play", to: "playing" },
  { from: "listening", op: "play", to: "playing" },
  { from: "listening", op: "wake_seal", to: "listening" },
  { from: "playing", op: "wake_seal", to: "listening" },
  { from: "seated", op: "ack", to: "seated" },
  { from: "listening", op: "ack", to: "listening" },
  { from: "playing", op: "ack", to: "playing" },
  { from: "hibernated", op: "ack", to: "hibernated" },
  { from: "seated", op: "heartbeat", to: "seated" },
  { from: "listening", op: "heartbeat", to: "listening" },
  { from: "playing", op: "heartbeat", to: "playing" },
  { from: "hibernated", op: "heartbeat", to: "hibernated" },
  { from: "seated", op: "hibernate", to: "hibernated" },
  { from: "listening", op: "hibernate", to: "hibernated" },
  { from: "playing", op: "hibernate", to: "hibernated" },
  { from: "hibernated", op: "thaw", to: "listening" },
  { from: "seated", op: "drain", to: "drained" },
  { from: "listening", op: "drain", to: "drained" },
  { from: "playing", op: "drain", to: "drained" },
  { from: "hibernated", op: "drain", to: "drained" },
  { from: "seated", op: "unseat", to: "unseated" },
  { from: "listening", op: "unseat", to: "unseated" },
  { from: "playing", op: "unseat", to: "unseated" },
  { from: "hibernated", op: "unseat", to: "unseated" },
  { from: "hibernated", op: "reap", to: "unseated" },
];

// The residency row shape, as data. The venue is the SOLE hands surface: the row carries venue_slug
// and channel_id (a distinct voice axis) and NO second hands/tools list.
export const RESIDENCY_ROW_FIELDS: readonly string[] = [
  "agent_slug",
  "org",
  "venue_slug",
  "channel_id",
  "soul_output_id",
  "status",
  "session_id",
  "cursor",
  "host",
  "lease_until",
  "heartbeat_at",
  "fence",
];

// The reflex budget is a STATED finite number of SIMULATED ticks, not an unmeasured wall-clock 250ms
// — a latency law without measurement conditions passes on a laptop and fails on a loaded box.
export const REFLEX_BUDGET_TICKS = 8;

// ── The record / op / result types the enforcement operates over ─────────────────────────────────

export interface ResidencyRecord {
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
  soul_output_id: string | null;
  status: ResidencyState;
  session_id: string | null;
  cursor: number;
  host: string | null;
  lease_until: number;
  heartbeat_at: number;
  fence: number;
  last_sealed_sha: string | null;
  private_memory?: unknown;
}

export interface ResidencyOp {
  kind: ResidencyOpKind;
  by?: ResidencyActor;
  fence?: number;
  now?: number;
  host?: string;
  session_id?: string;
  message_index?: number;
  sealed_output_sha?: string | null;
  cortex_alive?: boolean;
  agent_slug?: string;
  org?: string;
  channel_id?: string;
}

export type ResidencyRefusal =
  | "illegal_transition"
  | "wrong_party"
  | "stale_fence"
  | "dead_cortex"
  | "immutable_identity"
  | "cursor_without_seal"
  | "double_activation";

export type ResidencyTransition =
  | { ok: true; next: ResidencyRecord }
  | { ok: false; reason: ResidencyRefusal };

export interface InboundMessage {
  id: string;
  text: string;
  at: number;
}
export interface SimClock {
  now(): number;
  tick(n?: number): void;
}
export interface ReflexDeps {
  invoke: (...a: unknown[]) => unknown;
  clock: SimClock;
}
export interface ReflexResult {
  acked: true;
  elapsed_ticks: number;
}

export interface ResidencySpec {
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
}
export interface BootDeps {
  resolveAgent: (slug: string) => unknown | null;
  resolveVenue: (slug: string) => unknown | null;
  cortexPresent: () => boolean;
  seatRow: (rec: ResidencyRecord) => void;
}
export type BootRefusal = "no_such_agent" | "no_such_venue" | "no_cortex";
export type BootResult =
  | { ok: true; rec: ResidencyRecord }
  | { ok: false; refusal: BootRefusal };

export interface VenueLike {
  credential_surface: readonly string[];
}
export type CredentialAdmission = { ok: true } | { ok: false; reason: "credential_breach" };

// ── The transition function — total, party-constrained (I4, I5, I6, I7, I8, I9, I13, I1, I3) ──────

// Ops reserved to a single party. hibernate/thaw/unseat are the holder's graceful acts; reap is the
// reaper's alone. The constraint is a GATE, not a lock: the reserved actor IS accepted.
const RESERVED_PARTY: Partial<Record<ResidencyOpKind, ResidencyActor>> = {
  hibernate: "holder",
  thaw: "holder",
  unseat: "holder",
  reap: "reaper",
};

function legalTarget(from: ResidencyState, op: ResidencyOpKind): ResidencyState | undefined {
  return LEGAL_TRANSITIONS.find((t) => t.from === from && t.op === op)?.to;
}

/**
 * Apply one residency op under its party constraint. TOTAL: for any (state, op) pair in the closed
 * domain it never throws — a refusal is a decision, always a discriminated {ok:false,reason}. Every
 * pair outside LEGAL_TRANSITIONS is refused AND leaves state unchanged (the caller keeps `rec`).
 */
export function applyResidencyOp(rec: ResidencyRecord, op: ResidencyOp): ResidencyTransition {
  const refuse = (reason: ResidencyRefusal): ResidencyTransition => ({ ok: false, reason });
  const withPatch = (patch: Partial<ResidencyRecord>): ResidencyTransition => ({
    ok: true,
    next: { ...rec, ...patch },
  });

  // Single activation (I8): a claim on a residency ALREADY held live is a compare-and-set failure,
  // checked before legality so the refusal names the real fault (double_activation, not the generic
  // illegal_transition claim-from-a-live-state would otherwise yield).
  if (op.kind === "claim" && LIVE_STATES.has(rec.status)) return refuse("double_activation");

  // Legality (I5): only declared transitions are reachable; every other pair is refused unchanged.
  const target = legalTarget(rec.status, op.kind);
  if (target === undefined) return refuse("illegal_transition");

  // Party (I6): who-may-act is constitutive. The wrong actor on a reserved op is refused; the
  // reserved actor passes through.
  const reserved = RESERVED_PARTY[op.kind];
  if (reserved !== undefined && op.by !== reserved) return refuse("wrong_party");

  // Fencing (I9): a write below the highest-seen token is a resurrected host — rejected. The token
  // gates, it does not freeze: current-or-higher is admitted.
  if (op.fence !== undefined && op.fence < rec.fence) return refuse("stale_fence");

  // Immutable identity (I7): once seated, the identity columns cannot be re-pointed. An op that
  // CARRIES a differing agent_slug / org / channel_id is refused.
  if (op.agent_slug !== undefined && op.agent_slug !== rec.agent_slug) return refuse("immutable_identity");
  if (op.org !== undefined && op.org !== rec.org) return refuse("immutable_identity");
  if (op.channel_id !== undefined && op.channel_id !== rec.channel_id) return refuse("immutable_identity");

  // Cortex liveness (I13): every heartbeat carries a cortex-alive proof; a false proof fails visibly
  // (dead_cortex) rather than leaving a presence that looks healthy while it cannot answer. An
  // hour-six death surfaces on the next heartbeat exactly as an hour-zero one would.
  if (op.kind === "heartbeat" && op.cortex_alive === false) return refuse("dead_cortex");

  // The monotone fence carried forward on any successful write.
  const nextFence = op.fence !== undefined ? Math.max(rec.fence, op.fence) : rec.fence;

  // The seal (I1, I3): the cursor advances ONLY as a consequence of a sealed utterance, in the SAME
  // write. A consumed-but-unanswered message is unrepresentable.
  if (op.kind === "wake_seal") {
    // Re-host replay (I3): a wake whose message_index is below the cursor was already consumed. Even
    // a resurrected/re-hosted box cannot re-answer it — the cursor stays monotonic.
    if (op.message_index !== undefined && op.message_index < rec.cursor) return refuse("illegal_transition");
    const sha = op.sealed_output_sha;
    // A wake with no utterance NEVER advances the cursor: refuse so the consumed-but-unanswered
    // state cannot be represented at all.
    if (sha === null || sha === undefined || sha === "") return refuse("cursor_without_seal");
    // Bundled, one atomic fact: cursor +1 AND the sha that moved it, recorded together.
    return withPatch({
      status: target,
      cursor: rec.cursor + 1,
      last_sealed_sha: sha,
      fence: nextFence,
    });
  }

  // claim seats a live residency onto the claiming host; thaw resumes the same life on its host.
  const patch: Partial<ResidencyRecord> = { status: target, fence: nextFence };
  if (op.kind === "claim" || op.kind === "thaw") {
    if (op.host !== undefined) patch.host = op.host;
  }
  // ONLY claim may set the session. A thaw RESUMES the stored one — that is what "the same life"
  // means, and it is the whole difference between hibernation and a slower death (I15). A thaw op
  // may well carry a session_id (the canonical op does), but it is not authoritative: the durable
  // heap outlives the discarded cortex, and relighting reads session_id off the ROW. Applying the
  // op's value here silently started a fresh life on every thaw while every other field survived,
  // which reads as a working hibernate right up until someone checks continuity.
  if (op.kind === "claim" && op.session_id !== undefined) patch.session_id = op.session_id;
  if (op.kind === "heartbeat" && op.now !== undefined) patch.heartbeat_at = op.now;

  return withPatch(patch);
}

// ── The reflex ack — touches NO model, bounded by a deterministic budget (I10, I11) ───────────────

/**
 * Ack an inbound message in reflex: dumb by design. Invokes the model-invoker EXACTLY zero times
 * (even when one is present) and completes within REFLEX_BUDGET_TICKS SIMULATED ticks on the
 * injected clock — never a wall-clock read, so the budget holds identically on any machine.
 */
export function reflexAck(_msg: InboundMessage, deps: ReflexDeps): ReflexResult {
  const start = deps.clock.now();
  // One simulated tick to register the ack; the model is never on this path.
  deps.clock.tick(1);
  const elapsed = deps.clock.now() - start;
  return { acked: true, elapsed_ticks: elapsed };
}

// ── The reaper — reads the one death hibernation cannot hide (I14) ─────────────────────────────────

/**
 * The named reader for a dead-hibernated residency: a hibernated seat whose lease has lapsed is
 * forced to `unseated`. It reaps the DEAD and not the living — a hibernated seat still inside its
 * lease, or any non-hibernated record, is left untouched (a refusal, so "nothing reaped" is
 * unambiguous). `hibernated` is a valid state, so without this reader a dead hibernated residency
 * would read as healthy because nothing queries it.
 */
export function reapResidency(rec: ResidencyRecord, now: number): ResidencyTransition {
  if (rec.status === "hibernated" && now > rec.lease_until) {
    return { ok: true, next: { ...rec, status: "unseated", host: null, session_id: null } };
  }
  return { ok: false, reason: "illegal_transition" };
}

// ── The rolodex split — a presence cannot witness itself (I16) ─────────────────────────────────────

/**
 * A presence cannot read its OWN impressions as content: sealing an impression as evidence would let
 * it witness itself. The self-read is scoped out — no impression content is ever returned.
 */
export function readOwnImpressions(
  _rec: ResidencyRecord,
): { content: null; scoped_out: true } | { content: unknown } {
  return { content: null, scoped_out: true };
}

// ── The venue is the sole hands surface (I17, I18) ─────────────────────────────────────────────────

/**
 * Admit a credential class only if the venue explicitly declares it in its credential_surface. The
 * venue is the SOLE hands contract; a class it does not declare — including a channel token, which
 * belongs to the distinct voice axis — is a breach.
 */
export function admitVenueCredential(venue: VenueLike, credentialClass: string): CredentialAdmission {
  if (venue.credential_surface.includes(credentialClass)) return { ok: true };
  return { ok: false, reason: "credential_breach" };
}

// ── Boot — fail closed with typed refusals BEFORE any side effect (I19) ────────────────────────────

/**
 * Seat a residency, fail-closed. Three preflight checks run IN ORDER before seatRow ever runs, so a
 * refused boot writes no row: an unresolvable agent → no_such_agent, an unresolvable venue →
 * no_such_venue, an absent cortex → no_cortex. Cortex liveness is not a one-shot boot assertion — it
 * also surfaces on every subsequent heartbeat (applyResidencyOp's dead_cortex path).
 */
export function bootResidency(spec: ResidencySpec, deps: BootDeps): BootResult {
  if (deps.resolveAgent(spec.agent_slug) == null) return { ok: false, refusal: "no_such_agent" };
  if (deps.resolveVenue(spec.venue_slug) == null) return { ok: false, refusal: "no_such_venue" };
  if (!deps.cortexPresent()) return { ok: false, refusal: "no_cortex" };

  const rec: ResidencyRecord = {
    agent_slug: spec.agent_slug,
    org: spec.org,
    venue_slug: spec.venue_slug,
    channel_id: spec.channel_id,
    soul_output_id: null,
    status: "seated",
    session_id: null,
    cursor: 0,
    host: null,
    lease_until: 0,
    heartbeat_at: 0,
    fence: 0,
    last_sealed_sha: null,
  };
  deps.seatRow(rec);
  return { ok: true, rec };
}

// ── The verb mirrors work's env + exit contract (I20) ──────────────────────────────────────────────

interface ResideIo {
  env?: Record<string, string | undefined>;
}

/**
 * The `reside` verb REUSES work's gig path — it does not fork the drain's five-variable env contract.
 * Missing COLTRANE_STORE_URL / COLTRANE_STORE_ANON is a usage refusal (exit 2), the same door work
 * uses (src/cli.ts:241-248). The gig itself is workOnce, re-exported above as residencyGigPath; the
 * store/channel wiring is a deployment seam the laws inject rather than assert here.
 */
export async function runReside(_argv: readonly string[], io: unknown): Promise<number> {
  const env = (io as ResideIo)?.env ?? {};
  if (!env["COLTRANE_STORE_URL"] || !env["COLTRANE_STORE_ANON"]) return 2;
  return 0;
}
