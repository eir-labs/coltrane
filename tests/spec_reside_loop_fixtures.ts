// The LOOP contract as data + types, and a runtime loader for the not-yet-authored src/reside.ts.
// Shared by tests/spec_reside_cli.test.ts, spec_reside_loop.test.ts, spec_reside_router.test.ts.
//
// WHY THIS SHAPE — the same reason spec_reside_fixtures.ts has it, and it is worth restating because
// the failure it avoids is the one this work item exists to close. The root tsconfig compiles
// tests/** into the shared build, so a static `import … from "../src/reside.js"` of an absent module
// breaks the build for the ENTIRE suite rather than isolating these files. And a top-level `await
// import()` that REJECTS inside beforeAll fails the FILE, after which vitest reports its laws as
// `skipped` — laws that never ran, in a state that reads as legitimate rather than as red. So the
// loader returns a THROWING PROXY: every law stays individually executable and fails where it
// actually asserts, naming the absent module. When src/reside.ts is authored this branch never runs
// and each law becomes a live check against the real callsite.

import type { InboundMessage, SimClock } from "./spec_reside_fixtures.js";

// ── The refusal set, as the contract's data ──────────────────────────────────────────────────────
//
// TYPED, NEVER BOOLEAN (spec Constraints). `hosted_unsupported` is deliberately NOT reused for a
// missing backend: an unwired seam and an unsupported deployment are different facts, and one name
// for both is how a deployment gap comes to read as a policy decision.

export type ResideRefusal =
  /** A seam the deployment never wired. Names the seam; never thrown. */
  | "no_backend"
  /** An empty roster: not an error, and not a seat. */
  | "nothing_claimable"
  /** A gig-scoped ctk_ presented as the residency's own. Refused ENGINE-SIDE, before the wire. */
  | "gig_scoped_token"
  /** A wake that consumed a message and produced no channel utterance (the always-answer law). */
  | "silent_wake"
  /** A cursor moved without, or ahead of, the seal that earns it. */
  | "cursor_without_seal"
  /** The router met a refusal whose law_ref names the schedule — the one named-demand case. */
  | "needs_amendment"
  /** The store refused; relayed verbatim, never judged by the engine. */
  | "store_refused";

export const RESIDE_REFUSALS: readonly ResideRefusal[] = [
  "no_backend",
  "nothing_claimable",
  "gig_scoped_token",
  "silent_wake",
  "cursor_without_seal",
  "needs_amendment",
  "store_refused",
];

/** The ONE law_ref that turns a store refusal into a question for the cortex. Keyed on the law_ref,
 *  never on the prose: a message is written for a human and may be reworded without notice. */
export const SCHEDULE_LAW_REF = "chancery:dispatch:the-schedule-holds-the-pen";

// ── The seam ─────────────────────────────────────────────────────────────────────────────────────

/** What WI-2's claim door hands back: the record, the lease token, and the hand NAMES. */
export interface ResidencyClaim {
  residency_id: string;
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
  session_id: string | null;
  cursor: number;
  /** The lease credential. A `ctk_`; gig-scoped iff `gig_id` is set or `may_dispatch` is false. */
  lease_token: string;
  gig_id?: string | null;
  may_dispatch?: boolean;
  /** Hand NAMES only — the venue is the sole hands surface (I17); no second tool list travels. */
  hands: readonly string[];
}

export interface Utterance {
  channel_id: string;
  text: string;
}

export interface CortexTurn {
  /** Absent or empty is a SILENT WAKE — a refusal, not a quiet success. */
  utterance?: Utterance | null;
  sealed_output_sha?: string | null;
}

export interface Pin {
  org: string;
  venue: string;
}

/** A due entry as WI-1's `work-order-due` returns it. */
export interface DueEntry {
  work_order_id: string;
  schedule_ordinal: number;
  mode?: "rehearsal" | "studio" | "live";
  input?: Record<string, unknown>;
}

/** The envoy's answer: an act or a refusal. Every refusal carries `message` (WI-4 amendment c). */
export type EnvoyAnswer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: string; message: string; errcode?: string; law_ref?: string };

export type EnvoyCall = (verb: string, args: Record<string, unknown>) => Promise<EnvoyAnswer>;

/**
 * The injected seam — the way `deps.queueGig` injects dispatch (src/server.ts:3436). The engine
 * ships the loop, its refusals and its shape checks; a DEPLOYMENT supplies the backends. Every
 * member is optional for exactly one reason: an unwired member must produce a NAMED refusal, and a
 * required member could only produce a type error at a callsite the deployment does not control.
 */
export interface ResideDeps {
  claim?: (which: string | "any") => Promise<ResidencyClaim | null>;
  heartbeat?: (residencyId: string) => Promise<void>;
  release?: (residencyId: string, status: "hibernated" | "unseated") => Promise<void>;
  cursorAdvance?: (residencyId: string, n: number) => Promise<void>;
  channelListener?: (channelId: string) => AsyncIterable<InboundMessage>;
  cortex?: (session: { session_id: string | null; inbox: readonly InboundMessage[] }) => Promise<CortexTurn>;
  sealOutput?: (args: Record<string, unknown>) => Promise<{ content_sha: string }>;
  /** The hands. Hydrated under the LEASE token; the engine never holds a broader credential. */
  envoy?: EnvoyCall;
  say?: (u: Utterance) => Promise<void>;
  clock?: SimClock;
}

export interface ResideOptions {
  residency: string | "any";
  /** Present only so a law can drive the loop without a wall clock. */
  now?: () => number;
}

export type ResideResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; refusal: ResideRefusal; seam?: string; message: string; law_ref?: string };

export interface RouterResult {
  dispatched: readonly { work_order_id: string; schedule_ordinal: number; gig_id: string }[];
  monitored: readonly string[];
  /** Refusals relayed verbatim into the channel — a refusal is information. */
  relayed: readonly { refusal: string; message: string }[];
  /** The named-demand cases the cortex was actually consulted on. Empty on a clean pass. */
  escalated: readonly { work_order_id: string; schedule_ordinal: number; law_ref: string }[];
}

/** The driveable loop. A `while(true)` is not a testable unit; these are its steps, and `run()`
 *  composes exactly them — so a law drives the same code the daemon does. */
export interface Residency {
  boot(): Promise<ResideResult<{ residency_id: string }>>;
  /** THE REFLEX. Synchronous by construction: a path that cannot await cannot reach a model. */
  onInbound(msg: InboundMessage): { acked: true; elapsed_ticks: number };
  wake(): Promise<ResideResult<{ utterance: Utterance; cursor: number }>>;
  tick(): Promise<ResideResult<RouterResult>>;
  beat(): Promise<ResideResult>;
  shutdown(signal: "SIGTERM" | "SIGINT"): Promise<ResideResult>;
  readonly inbox: readonly InboundMessage[];
}

export interface ResideModule {
  RESIDE_REFUSALS: readonly ResideRefusal[];
  SCHEDULE_LAW_REF: string;
  createResidency(opts: ResideOptions, deps: ResideDeps): Residency;
  /** The SAME symbol as workOnce — reside does not fork the gig path (I12, one level out). */
  resideGigPath: unknown;
}

// ── The loader ───────────────────────────────────────────────────────────────────────────────────

export async function loadReside(): Promise<ResideModule> {
  const href = new URL("../src/reside.js", import.meta.url).href;
  try {
    return (await import(href)) as unknown as ResideModule;
  } catch (cause) {
    const why =
      `src/reside.ts does not exist yet — this law is RED until the loop is authored to the ` +
      `surface declared in spec_reside_loop_fixtures.ts ` +
      `[${String((cause as Error)?.message ?? cause).slice(0, 100)}]`;
    return new Proxy({} as ResideModule, {
      get(_t, prop) {
        // `then` and symbol probes must stay quiet or `await` treats this as a thenable and hangs.
        if (prop === "then" || typeof prop === "symbol") return undefined;
        throw new Error(`${String(prop)}: ${why}`);
      },
    });
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────────────────────────

export function simClock(): SimClock {
  let t = 0;
  return { now: () => t, tick: (n = 1) => { t += n; } };
}

/** A claim whose token is a proper LEASE: no gig_id, may_dispatch true (WI-2's shape). */
export function leaseClaim(over: Partial<ResidencyClaim> = {}): ResidencyClaim {
  return {
    residency_id: "res-viola-1",
    agent_slug: "agent.viola",
    org: "org.house",
    venue_slug: "venue.studio",
    channel_id: "chan.parlor",
    session_id: "sess-viola-1",
    cursor: 0,
    lease_token: "ctk_lease_viola",
    gig_id: null,
    may_dispatch: true,
    hands: ["Read", "Bash", "gig_dispatch", "gig_monitor", "output_write"],
    ...over,
  };
}

/** The same claim carrying a GIG-scoped token — narrow may not mint broad (plan law L28). */
export function gigScopedClaim(over: Partial<ResidencyClaim> = {}): ResidencyClaim {
  return leaseClaim({ lease_token: "ctk_gig_abc", gig_id: "gig-abc", may_dispatch: false, ...over });
}

export function msg(id: string, at = 0, text = "hello"): InboundMessage {
  return { id, text, at };
}

/** A recording deps bag: every seam wired, every call ordered on one tape so a law can assert
 *  SEQUENCE (cursor after seal) and not merely occurrence. */
export function recordingDeps(over: Partial<ResideDeps> = {}): {
  deps: ResideDeps;
  tape: string[];
  calls: { claim: number; heartbeat: number; release: unknown[][]; cursorAdvance: unknown[][]; cortex: number; envoy: unknown[][]; say: Utterance[] };
} {
  const tape: string[] = [];
  const calls = {
    claim: 0,
    heartbeat: 0,
    release: [] as unknown[][],
    cursorAdvance: [] as unknown[][],
    cortex: 0,
    envoy: [] as unknown[][],
    say: [] as Utterance[],
  };
  const deps: ResideDeps = {
    claim: async (which) => { calls.claim += 1; tape.push("claim"); return leaseClaim({ residency_id: String(which === "any" ? "res-viola-1" : which) }); },
    heartbeat: async () => { calls.heartbeat += 1; tape.push("heartbeat"); },
    release: async (...a) => { calls.release.push(a); tape.push(`release:${String(a[1])}`); },
    cursorAdvance: async (...a) => { calls.cursorAdvance.push(a); tape.push(`cursorAdvance:${String(a[1])}`); },
    // eslint-disable-next-line require-yield
    channelListener: async function* () { /* a listener that yields nothing is still a listener */ },
    cortex: async () => { calls.cortex += 1; tape.push("cortex"); return { utterance: { channel_id: "chan.parlor", text: "answered" } }; },
    sealOutput: async () => { tape.push("sealOutput"); return { content_sha: "sha-utterance-0" }; },
    envoy: async (verb, args) => { calls.envoy.push([verb, args]); tape.push(`envoy:${verb}`); return { ok: true, data: {} }; },
    say: async (u) => { calls.say.push(u); tape.push("say"); },
    clock: simClock(),
    ...over,
  };
  return { deps, tape, calls };
}
