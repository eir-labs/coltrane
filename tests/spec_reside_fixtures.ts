// The residency contract AS DATA + TYPES, and a runtime loader for the (not-yet-authored)
// enforcement module. Shared by tests/spec_reside_*.test.ts.
//
// WHY THIS SHAPE. The in-tree RED technique (committed_work, change_set) authors a THROWING seam in
// src/ so the suite compiles and fails on absent enforcement. This gig may NOT write to src/ (it
// produces the CONTRACT + RED suite only), and the root tsconfig compiles tests/** into the shared
// build — so a static `import ... from "../src/residency.js"` of an absent module would break the
// build for the ENTIRE suite, not just isolate the reside files. Instead:
//   • the closed state set, the op set, the legal-transition table and the row shape are declared
//     HERE, as the contract's data — the src module must expose sets that MATCH these (asserted);
//   • the enforcement (applyResidencyOp, reflexAck, reapResidency, bootResidency, …) is loaded at
//     RUNTIME via loadResidency(), whose specifier is dynamic so tsc does not resolve it. The build
//     stays green; every reside suite is RED at runtime because src/residency.ts does not exist yet.
// When src/residency.ts is authored to this surface, loadResidency() resolves and each assertion
// becomes a live check against the real callsite. This is not a tautology: the assertions pin the
// module's real behaviour, they do not assert against a stub defined in the test tree.

// ── The closed sets, as the contract's data ──────────────────────────────────────────────────────

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
export const RESIDENCY_ACTORS: readonly ResidencyActor[] = ["holder", "reaper", "operator"];

// The party-constrained legal-transition table — the contract's law, as data. applyResidencyOp must
// obey exactly this set (I5), and the src module must export a LEGAL_TRANSITIONS that matches it.
export interface LegalTransition {
  from: ResidencyState;
  op: ResidencyOpKind;
  to: ResidencyState;
}
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

// The residency row shape, as data — for the "venue is the SOLE hands surface" structural laws.
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

// The full surface src/residency.ts must export — what loadResidency() returns.
export interface ResidencyModule {
  RESIDENCY_STATES: readonly ResidencyState[];
  RESIDENCY_OPS: readonly ResidencyOpKind[];
  LIVE_STATES: ReadonlySet<ResidencyState>;
  LEGAL_TRANSITIONS: readonly LegalTransition[];
  RESIDENCY_ROW_FIELDS: readonly string[];
  REFLEX_BUDGET_TICKS: number;
  applyResidencyOp(rec: ResidencyRecord, op: ResidencyOp): ResidencyTransition;
  reflexAck(msg: InboundMessage, deps: ReflexDeps): ReflexResult;
  reapResidency(rec: ResidencyRecord, now: number): ResidencyTransition;
  readOwnImpressions(rec: ResidencyRecord): { content: null; scoped_out: true } | { content: unknown };
  admitVenueCredential(venue: VenueLike, credentialClass: string): CredentialAdmission;
  bootResidency(spec: ResidencySpec, deps: BootDeps): BootResult;
  runReside(argv: readonly string[], io: unknown): Promise<number>;
  // The SAME symbol as workOnce (src/worker.ts). Typed unknown here so this fixture stays free of a
  // worker.ts import; the surface suite compares it to the real workOnce by referential identity.
  residencyGigPath: unknown;
}

// Load the real enforcement module. The specifier is a runtime URL, NOT a string literal, so tsc
// does not attempt to resolve it (no TS2307) and the shared build stays green — while at runtime the
// import REJECTS until src/residency.ts is authored, which is the RED signal.
export async function loadResidency(): Promise<ResidencyModule> {
  const href = new URL("../src/residency.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as ResidencyModule;
  } catch (cause) {
    // RED AT THE ASSERTION, NOT AT COLLECTION. Every reside suite loads this from a top-level
    // `beforeAll`. A REJECTING loader there fails the FILE, and vitest then reports its laws as
    // `skipped` — 40 laws that never ran, in a state that reads as legitimate rather than as red.
    // That is the precise failure this contract exists to forbid elsewhere (a wake that consumes a
    // message without answering; a grade that claims a fetch nothing checked), so the suite must not
    // commit it about itself. Returning a throwing proxy keeps every law individually EXECUTABLE:
    // each one fails where it actually asserts, naming the absent module. `then` must stay absent or
    // `await` would treat this as a thenable and hang; symbol probes stay quiet for the same reason.
    // When src/residency.ts is authored this branch never runs and each law becomes a live check.
    const why =
      `src/residency.ts does not exist yet — this law is RED until the enforcement module is ` +
      `authored to the surface declared in spec_reside_fixtures.ts ` +
      `[${String((cause as Error)?.message ?? cause).slice(0, 100)}]`;
    return new Proxy({} as ResidencyModule, {
      get(_target, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        throw new Error(`${String(prop)}: ${why}`);
      },
    });
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────────

/** A canonical residency in `state`: box.A holds the live ones, fence 0, cursor at the inbox head. */
export function resIn(state: ResidencyState, over: Partial<ResidencyRecord> = {}): ResidencyRecord {
  const live = LIVE_STATES.has(state);
  return {
    agent_slug: "agent.viola",
    org: "org.house",
    venue_slug: "venue.studio",
    channel_id: "chan.parlor",
    soul_output_id: null,
    status: state,
    session_id: live ? "sess-viola-1" : null,
    cursor: 0,
    host: live ? "box.A" : null,
    lease_until: 1_000,
    heartbeat_at: 500,
    fence: 0,
    last_sealed_sha: null,
    private_memory: { impression_of_steve: "warm but exacting" },
    ...over,
  };
}

/** A valid op for `kind`, performed by its LEGITIMATE party, fence/clock high enough not to be the
 *  thing under test, seal sha present. I5 uses this to prove state-legality without tripping the
 *  party (I6) or fence (I9) gates; wrong-party / stale-fence / no-seal cases override one field. */
export function canonicalOp(kind: ResidencyOpKind, rec: ResidencyRecord): ResidencyOp {
  const reserved: Partial<Record<ResidencyOpKind, ResidencyActor>> = {
    hibernate: "holder",
    thaw: "holder",
    unseat: "holder",
    reap: "reaper",
  };
  const by = reserved[kind];
  return {
    kind,
    ...(by ? { by } : {}),
    fence: 1_000_000,
    now: 2_000_000,
    host: "box.A",
    session_id: "sess-viola-1",
    message_index: rec.cursor,
    sealed_output_sha: "sha-utterance-0",
    cortex_alive: true,
  };
}
