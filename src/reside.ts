/**
 * `coltrane reside` — the standing loop.
 *
 * The state machine this drives already exists (src/residency.ts, 43 laws): states, ops, the
 * party-constrained transition table, the reflex, the reaper, the boot preflight. What did NOT exist
 * was a CALLER. `runReside` was exported, tested and pinned as law I20 while `src/cli.ts`'s KNOWN
 * table had no "reside" in it, so `coltrane reside` answered `unknown command` on a green suite —
 * a mechanism proven to work that nothing could reach. This module is the loop, and the mount in
 * cli.ts is the half that makes it reachable.
 *
 * THREE PROPERTIES THE SHAPE ENFORCES RATHER THAN REQUESTS:
 *
 *   1. NO MODEL ON THE REFLEX PATH. `onInbound` is SYNCHRONOUS. Not "does not call the cortex" as a
 *      matter of discipline — it cannot await, so it cannot reach one. An inbound message is acked
 *      and appended whether the cortex is busy, dead, or absent; an unacked message means the
 *      listener is down, which is a pager fact and must stay one.
 *
 *   2. EVERY SEAM IS INJECTED, AND AN UNWIRED SEAM IS A NAMED REFUSAL. The way `deps.queueGig`
 *      injects dispatch (src/server.ts:3436): the engine ships the loop, its refusals and its shape
 *      checks; a deployment supplies the backends. Absent must mean DECLINE — `{ok:false,
 *      refusal:"no_backend", seam}` in the gig_dispatch shape, naming which seam — never a throw and
 *      never a plausible default. `hosted_unsupported` is deliberately not reused: an unwired seam
 *      and an unsupported deployment are different facts.
 *
 *   3. THE ROUTER IS CODE. Determinism in the engine, inference in the prompt, no overlap. A clean
 *      pass dispatches every due (order, ordinal) and consults the cortex ZERO times. The cortex is
 *      reached on NAMED DEMAND only — a store refusal whose `law_ref` the deployment listed — and that
 *      is keyed on the law_ref, never on the refusal's prose, because prose is written for humans
 *      and gets reworded without notice.
 *
 * A NOTE ON THE IMPORT CYCLE. src/residency.ts re-exports `runReside` from here, and this module
 * imports the state machine from there. The cycle is safe and deliberate: every binding crossing it
 * is either a hoisted function declaration or read inside a function body at call time, never during
 * module evaluation. The alternative was duplicating the transition table, which is the one thing
 * the surface's identity laws exist to forbid.
 */
import { selectResidencyBacking, resolveSeatBacking } from "./reside_backing.js";
import {
  applyResidencyOp,
  bootResidency,
  reflexAck,
  type InboundMessage,
  type ResidencyRecord,
  type SimClock,
} from "./residency.js";

export {
  selectResidencyBacking,
  resolveSeatBacking,
  fileSeatBacking,
  fileSeatSeed,
  SEAT_MEMBERS,
  RESIDENCY_DIR_VAR,
  RESIDENCY_MODULE_VAR,
  type ResidencyBackingChoice,
  type SeatBacking,
  type SeatResolution,
  type SeatSeed,
} from "./reside_backing.js";

/** The gig path is WORK's gig path. A second implementation fails by existing (I12, one level out). */
export { workOnce as resideGigPath } from "./worker.js";

// ── The refusal set ──────────────────────────────────────────────────────────────────────────────

export type ResideRefusal =
  | "no_backend"
  | "backing_conflict"
  | "nothing_claimable"
  | "gig_scoped_token"
  | "silent_wake"
  | "cursor_without_seal"
  | "needs_amendment"
  | "store_refused";

export const RESIDE_REFUSALS: readonly ResideRefusal[] = [
  "no_backend",
  "backing_conflict",
  "nothing_claimable",
  "gig_scoped_token",
  "silent_wake",
  "cursor_without_seal",
  "needs_amendment",
  "store_refused",
];

/**
 * The exit code each refusal earns, TOTAL over the refusal set — `Record<ResideRefusal, number>`, so
 * adding a refusal without deciding what it means to a supervisor is a type error rather than a
 * silent 1. The set is read at runtime (not merely declared) so an undeclared refusal reaching here
 * exits 1 rather than `undefined`.
 *
 *   2 misconfigured — including a seam no deployment wired · 3 nothing claimable ·
 *   1 the loop ran and something failed · 0 is reserved for a clean release.
 */
const EXIT_FOR_REFUSAL: Record<ResideRefusal, number> = {
  no_backend: 2,
  backing_conflict: 2,
  nothing_claimable: 3,
  gig_scoped_token: 2,
  silent_wake: 1,
  cursor_without_seal: 1,
  needs_amendment: 1,
  store_refused: 1,
};

/** The supervisor-facing exit code for a refusal. An unknown name is a failure, never a success. */
export function resideExitCode(refusal: string): number {
  return RESIDE_REFUSALS.includes(refusal as ResideRefusal) ? EXIT_FOR_REFUSAL[refusal as ResideRefusal] : 1;
}

/**
 * WHICH refusals constitute NAMED DEMAND is configuration, not an engine constant. The engine ships
 * the mechanism — branch on a refusal's `law_ref`, never on its prose, because prose is written for
 * humans and gets reworded — and the deployment supplies the refs that mean "a human must rule".
 * Hard-coding one institution's law reference here named someone else's governance inside the
 * engine, which is the coupling the backing seam exists to prevent, one layer over.
 */
const NO_NAMED_DEMAND: readonly string[] = [];

// ── The seam ─────────────────────────────────────────────────────────────────────────────────────

export interface ResidencyClaim {
  residency_id: string;
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
  session_id: string | null;
  cursor: number;
  lease_token: string;
  gig_id?: string | null;
  /**
   * THE FENCE — minted by claim, carried unread to the three doors that move the seat. OPAQUE on
   * purpose: a grip identifies the GRANT, not the grantee, and WHICH token closes that (a monotonic
   * fence or a random secret) is the store's decision. The engine carries it and never parses,
   * orders, or prints it — so a secret token cannot leak and a public one costs nothing.
   */
  fence?: string;
  /** An EXACT allow-list of standard slugs; its wildcard is "*". Never a boolean — a lease token
   *  carries ["*"], and dispatch authority still sits on the chair, so this widens nothing. */
  may_dispatch?: readonly string[];
  hands: readonly string[];
}

export interface Utterance {
  channel_id: string;
  text: string;
}
export interface CortexTurn {
  utterance?: Utterance | null;
  sealed_output_sha?: string | null;
}
export interface Pin {
  org: string;
  venue: string;
}
export interface DueEntry {
  work_order_id: string;
  schedule_ordinal: number;
  mode?: "rehearsal" | "studio" | "live";
  input?: Record<string, unknown>;
}
export type VerbAnswer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: string; message: string; errcode?: string; law_ref?: string };
export type VerbCall = (verb: string, args: Record<string, unknown>) => Promise<VerbAnswer>;

export interface ResideDeps {
  claim?: (which: string | "any") => Promise<ResidencyClaim | null>;
  heartbeat?: (residencyId: string, fence: string) => Promise<void>;
  release?: (residencyId: string, fence: string, status: "hibernated" | "unseated") => Promise<void>;
  /** A backing may answer the new cursor, or answer nothing. Both are accepted — the engine reads
   *  its own record rather than the reply, so no backing's return shape is load-bearing here. */
  cursorAdvance?: (residencyId: string, fence: string, n: number) => Promise<number | void>;
  channelListener?: (channelId: string) => AsyncIterable<InboundMessage>;
  cortex?: (session: { session_id: string | null; inbox: readonly InboundMessage[] }) => Promise<CortexTurn>;
  sealOutput?: (args: Record<string, unknown>) => Promise<{ content_sha: string }>;
  callVerb?: VerbCall;
  say?: (u: Utterance) => Promise<void>;
  clock?: SimClock;
}

export interface ResideOptions {
  residency: string | "any";
  /** Refusal `law_ref`s that mean "a human must rule" — supplied by the deployment, never by the
   *  engine. Absent means no refusal escalates: the router relays and the cortex stays unconsulted. */
  escalateOn?: readonly string[];
  now?: () => number;
}

export type ResideResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; refusal: ResideRefusal; seam?: string; message: string; law_ref?: string };

export interface RouterResult {
  dispatched: readonly { work_order_id: string; schedule_ordinal: number; gig_id: string }[];
  monitored: readonly string[];
  relayed: readonly { refusal: string; message: string }[];
  escalated: readonly { work_order_id: string; schedule_ordinal: number; law_ref: string }[];
}

export interface Residency {
  boot(): Promise<ResideResult<{ residency_id: string }>>;
  onInbound(msg: InboundMessage): { acked: true; elapsed_ticks: number };
  wake(): Promise<ResideResult<{ utterance: Utterance; cursor: number }>>;
  tick(): Promise<ResideResult<RouterResult>>;
  beat(): Promise<ResideResult>;
  shutdown(signal: "SIGTERM" | "SIGINT"): Promise<ResideResult>;
  readonly inbox: readonly InboundMessage[];
}

/** The seams boot cannot proceed without, in the order they are reported. `callVerb` is absent from
 *  this list on purpose: a residency that only listens and answers is a legitimate residency, and
 *  the router names its own seam when it is the thing that is unwired. */
const BOOT_SEAMS = ["claim", "channelListener", "cortex", "say", "sealOutput", "cursorAdvance", "release"] as const;

const refuse = (refusal: ResideRefusal, message: string, extra: Record<string, unknown> = {}) =>
  ({ ok: false as const, refusal, message, ...extra });

/**
 * A lease token that is narrow. Narrow may not mint broad (L28): a token bound to one gig cannot
 * hold a residency.
 *
 * THE SIGNAL IS gig_id, AND ONLY gig_id — corrected against the store twice, and the second
 * correction is the interesting one. An earlier draft read `may_dispatch === false`, a shape the
 * column (text[]) cannot hold. The fix to "an EMPTY allow-list is narrow" was then ALSO wrong, and
 * would have been worse: the list stopped being the wildcard and became the exact standards a
 * presence may reach, so `{}` is now a perfectly legitimate seating — a residency that dispatches
 * (chair-gated) but reaches no gig it did not dispatch. Treating empty as narrowness would have
 * refused valid seats, and refused them in the one direction nobody tests: the quiet one.
 *
 * The dispatch allow-list is an authorization gate in the STORE, in exactly one place. It is not
 * the engine's business to re-derive it, and a residency's authority sits on its chair regardless.
 *
 * This is a second line either way. The claim door refuses a gig token itself with a message whose
 * machine-readable prefix is `gig_scoped_token:` (see storeRefusalName); the engine still checks,
 * because a local or hand-built backing has no such door in front of it.
 */
function isGigScoped(claim: ResidencyClaim): boolean {
  return claim.gig_id != null;
}

/**
 * The machine-readable name a store refusal begins with (`gig_scoped_token: …`, `not_holder: …`,
 * `cursor_regression: …`). Branching on the PREFIX rather than the prose is the same discipline the
 * router applies to law_ref: the human half of the message is written to be reworded.
 */
export function storeRefusalName(message: string): string | null {
  const m = /^([a-z][a-z0-9_]*):/.exec(message.trim());
  return m ? m[1]! : null;
}

/** A monotonic tick source so the reflex budget is measured on a simulated clock on every machine,
 *  never on a wall clock (the property REFLEX_BUDGET_TICKS exists to make machine-independent). */
function clockOf(deps: ResideDeps): SimClock {
  if (deps.clock) return deps.clock;
  let t = 0;
  return { now: () => t, tick: (n = 1) => { t += n; } };
}

export function createResidency(opts: ResideOptions, deps: ResideDeps): Residency {
  const clock = clockOf(deps);
  const escalateOn = opts.escalateOn ?? NO_NAMED_DEMAND;
  const inbox: InboundMessage[] = [];

  let rec: ResidencyRecord | null = null;
  let residencyId: string | null = null;
  /**
   * THE FENCE on this grant, held for the life of the seat and PRESENTED ON EVERY OP.
   *
   * Presenting it is the whole point, and it was missing: applyResidencyOp gates on
   * `op.fence !== undefined && op.fence < rec.fence`, so an op that omits the field is not gated at
   * all. All six call sites below omitted it, which left law I9 — the fencing law, with a case named
   * for a GC-paused host resuming post-lease — unable to fire anywhere on the live path. The store
   * had the mirror of this defect: no `fence` column at all. A declared invariant enforced by
   * neither side is the shape this repo keeps finding, and it survived two green suites.
   */
  let fence = "";
  let fenceNum = 0;
  let claimed = false;
  let released = false;
  /** The boot refusal, held so a later step answers with the reason it never seated rather than a
   *  second, less specific one. */
  let standing: ReturnType<typeof refuse> | null = null;

  async function boot(): Promise<ResideResult<{ residency_id: string }>> {
    // HOLD THE SEAT. Two boxes reading the same orders both dispatch (plan, seam 3), so the claim
    // door is entered exactly once per instance — a second boot returns the seat already held.
    if (claimed && rec && residencyId) return { ok: true, residency_id: residencyId };
    if (standing) return standing;

    for (const seam of BOOT_SEAMS) {
      if (typeof deps[seam] !== "function") {
        standing = refuse("no_backend", `reside has no ${seam} backend wired — a deployment supplies it (parallel to deps.queueGig); the engine ships the loop, its refusals and its shape checks.`, { seam });
        return standing;
      }
    }

    claimed = true;
    const claim = await deps.claim!(opts.residency);
    if (claim == null) {
      // Not an error and not a seat: an empty roster is the ordinary answer to "is anything free".
      standing = refuse("nothing_claimable", "no residency was claimable — nothing queued for this instance.");
      return standing;
    }

    if (isGigScoped(claim)) {
      // ENGINE-SIDE, BEFORE THE WIRE. The store would refuse this too (42501 at the dispatch door),
      // but a token that cannot possibly dispatch should never travel to find that out.
      standing = refuse(
        "gig_scoped_token",
        `the claimed credential is scoped to a single gig${claim.gig_id ? ` (${claim.gig_id})` : ""} and cannot hold a residency — narrow may not mint broad.`,
      );
      return standing;
    }

    const booted = bootResidency(
      { agent_slug: claim.agent_slug, org: claim.org, venue_slug: claim.venue_slug, channel_id: claim.channel_id },
      {
        resolveAgent: (s) => (s === claim.agent_slug ? { slug: s } : null),
        resolveVenue: (s) => (s === claim.venue_slug ? { slug: s, credential_surface: [] } : null),
        cortexPresent: () => typeof deps.cortex === "function",
        seatRow: (r) => { rec = r; },
      },
    );
    if (!booted.ok) {
      standing = refuse("no_backend", `boot refused: ${booted.refusal}`, { seam: booted.refusal });
      return standing;
    }

    // The fence is taken from the claim FIRST — the record is built from it, so an ordering slip
    // here would seat every residency at fence 0 and quietly hand the store a stale token on the
    // first heartbeat.
    fence = claim.fence ?? "";
    fenceNum = Number(fence) || 0;

    // The store's session and cursor are the durable ones — a thaw resumes the same life.
    rec = { ...booted.rec, session_id: claim.session_id, cursor: claim.cursor, fence: fenceNum, lease_until: Number.MAX_SAFE_INTEGER };
    residencyId = claim.residency_id;

    const listening = applyResidencyOp(rec, { kind: "listen", fence: fenceNum });
    // A refusal ends the STEP, never the process: an un-listened seat is still a seat.
    if (listening.ok) rec = listening.next;
    return { ok: true, residency_id: residencyId };
  }

  /** THE REFLEX. Synchronous by construction — a path that cannot await cannot reach a model. */
  function onInbound(msg: InboundMessage): { acked: true; elapsed_ticks: number } {
    inbox.push(msg);
    if (rec) {
      const acked = applyResidencyOp(rec, { kind: "ack", fence: fenceNum });
      if (acked.ok) rec = acked.next;
    }
    // reflexAck is the existing, law-covered primitive (I10/I11) — not a second ack path.
    return reflexAck(msg, { invoke: () => undefined, clock });
  }

  async function wake(): Promise<ResideResult<{ utterance: Utterance; cursor: number }>> {
    if (!rec || !residencyId) return standing ?? refuse("no_backend", "not seated", { seam: "claim" });
    const playing = applyResidencyOp(rec, { kind: "play", fence: fenceNum });
    if (playing.ok) rec = playing.next;

    const turn = await deps.cortex!({ session_id: rec.session_id, inbox: [...inbox] });
    const utterance = turn.utterance;
    if (!utterance || !utterance.text) {
      // THE ALWAYS-ANSWER LAW. A wake that consumed a message and answered nobody is a refusal, not
      // a quiet success — and it seals nothing and moves no cursor, so the unanswered message is not
      // silently dropped.
      return refuse("silent_wake", "the wake produced no channel utterance — a wake that consumes a message must answer it.");
    }

    await deps.say!(utterance);
    const sealed = await deps.sealOutput!({ residency_id: residencyId, channel_id: utterance.channel_id, text: utterance.text });
    const sha = turn.sealed_output_sha ?? sealed.content_sha;

    // The cursor advances ONLY as a consequence of the seal, in the same write (I1/I3) — the state
    // machine owns that arithmetic, not this loop.
    const advanced = applyResidencyOp(rec, { kind: "wake_seal", fence: fenceNum, message_index: rec.cursor, sealed_output_sha: sha });
    if (!advanced.ok) {
      return refuse(advanced.reason === "cursor_without_seal" ? "cursor_without_seal" : "silent_wake", `the seal did not earn a cursor: ${advanced.reason}`);
    }
    rec = advanced.next;
    await deps.cursorAdvance!(residencyId, fence, rec.cursor);
    return { ok: true, utterance, cursor: rec.cursor };
  }

  async function tick(): Promise<ResideResult<RouterResult>> {
    if (!rec || !residencyId) return standing ?? refuse("no_backend", "not seated", { seam: "claim" });
    if (typeof deps.callVerb !== "function") {
      return refuse("no_backend", "reside has no callVerb backend wired — the router's hands are the governed verb surface, hydrated under the lease token.", { seam: "callVerb" });
    }

    const pin: Pin = { org: rec.org, venue: rec.venue_slug };
    const dispatched: { work_order_id: string; schedule_ordinal: number; gig_id: string }[] = [];
    const relayed: { refusal: string; message: string }[] = [];
    const escalated: { work_order_id: string; schedule_ordinal: number; law_ref: string }[] = [];
    const monitored: string[] = [];

    // A row-routed READ forwards its args verbatim and reads the credential from the header, so it
    // carries no pin. The dispatch is an ACT and names its org and venue in the act itself.
    const due = await deps.callVerb("work-order-due", {});
    if (!due.ok) {
      await deps.say!({ channel_id: rec.channel_id, text: due.message });
      return { ok: true, dispatched, monitored, relayed: [{ refusal: due.refusal, message: due.message }], escalated };
    }

    const entries = (Array.isArray((due.data as { due?: unknown }).due) ? (due.data as { due: DueEntry[] }).due : []);
    for (const entry of entries) {
      const answer = await deps.callVerb("work-order-dispatch", {
        work_order_id: entry.work_order_id,
        schedule_ordinal: entry.schedule_ordinal,
        mode: entry.mode ?? "live",
        ...(entry.input ? { input: entry.input } : {}),
        pin,
      });

      if (answer.ok) {
        // Re-dispatching a (work_order_id, schedule_ordinal) with a standing non-terminal gig
        // returns that gig's id rather than refusing — so "once per wake" is safe, not merely tidy.
        dispatched.push({ work_order_id: entry.work_order_id, schedule_ordinal: entry.schedule_ordinal, gig_id: String(answer.data["gig_id"] ?? "") });
        continue;
      }

      if (answer.law_ref !== undefined && escalateOn.includes(answer.law_ref)) {
        // THE ONE NAMED DEMAND. Keyed on the law_ref — the identical prose without it is governance
        // and must not reach a model.
        escalated.push({ work_order_id: entry.work_order_id, schedule_ordinal: entry.schedule_ordinal, law_ref: answer.law_ref });
        const turn = await deps.cortex!({ session_id: rec.session_id, inbox: [...inbox] });
        if (turn.utterance?.text) await deps.say!(turn.utterance);
        continue;
      }

      // A refusal is information, and the residency's voice is where it is shown — VERBATIM. The
      // engine does not judge a governance refusal; it raises it.
      //
      // The store names its refusals in a machine-readable PREFIX, so the relayed record carries
      // that name when there is one. This is also the second place a gig-scoped token can surface:
      // the seat check catches one that arrives in a claim, and this catches one the wire reports.
      const named = storeRefusalName(answer.message);
      relayed.push({ refusal: named ?? answer.refusal, message: answer.message });
      await deps.say!({ channel_id: rec.channel_id, text: answer.message });
    }

    for (const d of dispatched) {
      const seen = await deps.callVerb("gig_monitor", { gig_id: d.gig_id });
      if (seen.ok) monitored.push(d.gig_id);
    }

    return { ok: true, dispatched, monitored, relayed, escalated };
  }

  async function beat(): Promise<ResideResult> {
    // Renewing after the seat has been handed back is how two boxes come to believe they hold it.
    if (released || !rec || !residencyId) return refuse("no_backend", "no live seat to renew", { seam: "claim" });
    const beaten = applyResidencyOp(rec, { kind: "heartbeat", fence: fenceNum, cortex_alive: typeof deps.cortex === "function" });
    if (beaten.ok) rec = beaten.next;
    await deps.heartbeat!(residencyId, fence);
    return { ok: true };
  }

  async function shutdown(_signal: "SIGTERM" | "SIGINT"): Promise<ResideResult> {
    // A redeploy HANDS THE SEAT OVER rather than racing for it. Idempotent: a second signal during
    // a drain must not release twice, and a seat never held is not released at all.
    if (released || !rec || !residencyId) return { ok: true };
    released = true;
    const hibernating = applyResidencyOp(rec, { kind: "hibernate", fence: fenceNum, by: "holder" });
    if (hibernating.ok) rec = hibernating.next;
    await deps.release!(residencyId, fence, "hibernated");
    return { ok: true };
  }

  return {
    boot,
    onInbound,
    wake,
    tick,
    beat,
    shutdown,
    get inbox() { return inbox; },
  };
}

// ── The verb ─────────────────────────────────────────────────────────────────────────────────────

interface ResideIo {
  err?: (s: string) => void;
  env?: Record<string, string | undefined>;
}

/**
 * The `reside` verb. REUSES work's env contract — src/worker_env.ts's WORKER_ENV_CONTRACT is the
 * single source, and reside introduces no new credential class: the residency's hands materialize
 * from the drain key that already exists. Missing COLTRANE_STORE_URL / COLTRANE_STORE_ANON is a
 * usage refusal (exit 2), the same door `work` uses.
 *
 * Exit codes mirror work's: 0 released cleanly · 1 the cortex failed · 2 misconfigured, including a
 * seam no deployment has wired · 3 nothing claimable.
 *
 * This reads `io.env` when given one and falls back to the process environment otherwise — the
 * fallback is what makes the mounted command usable, and the injection is what makes law I20
 * checkable. It reads no NAMED variable of its own, which is why src/reside.ts can join the
 * WORKER_PATH scan in tests/spec_worker_environment.test.ts and stay honest there.
 */
export async function runReside(argv: readonly string[], io: unknown): Promise<number> {
  const asIo = io as ResideIo | undefined;
  const env = asIo?.env ?? process.env;
  const say = (s: string): void => { asIo?.err?.(s + "\n"); };

  const at = argv.indexOf("--residency");
  const residency = at >= 0 && argv[at + 1] ? String(argv[at + 1]) : "any";

  // WHERE THE SEAT LIVES is selected FIRST, and never guessed: a local file roster, a backing you
  // wrote, or a hosted one the DEPLOYMENT injects. The engine holds no hosted provider, so with the
  // drain environment set this refuses and names what to wire.
  //
  // THE ORDER HERE IS THE FIX FOR A REAL DEFECT. This used to demand COLTRANE_STORE_URL/_ANON before
  // selecting anything — and both are DRAIN_VARS, so setting COLTRANE_RESIDENCY_DIR produced a
  // backing CONFLICT every time and the local roster could not be selected by any environment on
  // earth. A store credential is the HOSTED backing's requirement, not the verb's: a local seat has
  // no store to point at, and asking it for one made a whole provider unreachable.
  const choice = selectResidencyBacking(env);
  if (choice.backing === "hosted" && (!env["COLTRANE_STORE_URL"] || !env["COLTRANE_STORE_ANON"])) {
    // Said, not silent. A bare exit 2 leaves an operator to guess which of five variables is
    // missing — and leaves the reachability law with nothing only THIS command could have emitted.
    say("reside refused: no_backend (seam: store-env) — the hosted backing needs COLTRANE_STORE_URL and COLTRANE_STORE_ANON.");
    return 2;
  }
  const seat = await resolveSeatBacking(choice, {});
  if (!seat.ok) {
    say(`reside refused: ${seat.refusal} (seam: ${seat.seam}) — ${seat.message}`);
    return resideExitCode(seat.refusal);
  }

  // The seat resolved; the remaining seams (channel, cortex, hands) are per-deployment on every
  // backing, so an unwired one still refuses BY NAME rather than pretending to stand.
  const r = createResidency({ residency }, { ...seat.seat });
  const booted = await r.boot();
  if (!booted.ok) {
    say(`reside refused: ${booted.refusal}${booted.seam ? ` (seam: ${booted.seam})` : ""} — ${booted.message}`);
    return resideExitCode(booted.refusal);
  }
  return 0;
}
