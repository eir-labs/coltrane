/**
 * WHERE THE SEAT LIVES — the residency backing seam.
 *
 * `reside` is platform-agnostic at THIS level. The engine ships the port, the selector, a local
 * file-backed provider, a shape-check for a hand-built one, and the refusals. It ships no hosted
 * provider of its own: a deployment injects that, the way `deps.queueGig` and
 * `deps.mintVenueCredential` are injected. The last law in tests/spec_reside_backing.test.ts greps
 * this file and reside.ts for platform-specific symbols, so "the engine has no platform" is a
 * property a test can break rather than a claim in a comment.
 *
 * THE SELECTOR IS selectQueueBacking'S SHAPE, ONE TABLE OVER (src/local_queue.ts:153), and that is
 * deliberate reuse of a policy this repo already argued out:
 *   • it answers from key PRESENCE, never from a credential's value;
 *   • two backings configured is a CONFLICT — which store owns a seat is not a thing to guess, and
 *     a precedence order would silently prefer one operator's intent over another's;
 *   • nothing configured names every door, so the operator learns the choices from the refusal.
 * The one addition is a third door — a module you wrote yourself — because "local" and "hand built"
 * are different things: one is a file layout the engine understands, the other is your code.
 *
 * SCOPE. This seam is about the SEAT — the four operations that move a residency row. The channel,
 * the cortex and the work-order hands are separate axes and are supplied per-deployment regardless
 * of where the seat lives; folding them in here would make a local seat imply a local model.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DRAIN_VARS } from "./local_queue.js";
import type { ResidencyClaim } from "./reside.js";

/** The local file-backed roster's root. Its PRESENCE selects the local backing. */
export const RESIDENCY_DIR_VAR = "COLTRANE_RESIDENCY_DIR";
/** A module you wrote, exporting the four seat operations. Its PRESENCE selects the module backing. */
export const RESIDENCY_MODULE_VAR = "COLTRANE_RESIDENCY_MODULE";

export type ResidencyBackingChoice =
  | { backing: "local"; root: string }
  | { backing: "module"; spec: string }
  | { backing: "hosted" }
  | { backing: "none"; why: string }
  | { backing: "conflict"; why: string };

/** The four seat seams — where the residency ROW lives, and nothing else. */
export interface SeatBacking {
  claim: (which: string | "any") => Promise<ResidencyClaim | null>;
  heartbeat: (residencyId: string, fence: string) => Promise<void>;
  release: (residencyId: string, fence: string, status: "hibernated" | "unseated") => Promise<void>;
  cursorAdvance: (residencyId: string, fence: string, n: number) => Promise<number>;
}

/** Checked IN THIS ORDER, so a refusal names the first thing a hand-built backing forgot. */
export const SEAT_MEMBERS = ["claim", "heartbeat", "release", "cursorAdvance"] as const;

export type SeatResolution =
  | { ok: true; seat: SeatBacking; backing: "local" | "module" | "hosted" }
  | { ok: false; refusal: "no_backend" | "backing_conflict"; seam: string; message: string };

export interface SeatSeed {
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
}

/** How long a local claim holds before another box may take the seat. Mirrors the hosted lease. */
const LOCAL_LEASE_MS = 30 * 60 * 1000;

export function selectResidencyBacking(env: Record<string, string | undefined>): ResidencyBackingChoice {
  const dirRaw = env[RESIDENCY_DIR_VAR];
  const modRaw = env[RESIDENCY_MODULE_VAR];
  const localPresent = typeof dirRaw === "string" && dirRaw.length > 0;
  const modulePresent = typeof modRaw === "string" && modRaw.length > 0;
  const keys = Object.keys(env);
  const hostedPresent = DRAIN_VARS.some((v) => keys.includes(v));

  const chosen = [
    localPresent ? RESIDENCY_DIR_VAR : null,
    modulePresent ? RESIDENCY_MODULE_VAR : null,
    hostedPresent ? "the hosted drain environment" : null,
  ].filter((x): x is string => x !== null);

  if (chosen.length > 1) {
    return {
      backing: "conflict",
      why: `${chosen.join(" and ")} are all configured — refusing to guess which backing owns the seat. Two boxes reading one roster both dispatch.`,
    };
  }
  if (localPresent) return { backing: "local", root: dirRaw };
  if (modulePresent) return { backing: "module", spec: modRaw };
  if (hostedPresent) return { backing: "hosted" };
  return {
    backing: "none",
    why:
      `no residency backing configured — set ${RESIDENCY_DIR_VAR} for a local file-backed roster, ` +
      `${RESIDENCY_MODULE_VAR} for a backing you wrote yourself, or the hosted drain environment ` +
      `for a hosted seat (whose provider the deployment injects).`,
  };
}

/** Every seat member present and callable, or the name of the first that is not. */
function missingMember(candidate: Partial<SeatBacking> | undefined): string | null {
  if (!candidate) return SEAT_MEMBERS[0];
  for (const m of SEAT_MEMBERS) {
    if (typeof candidate[m] !== "function") return m;
  }
  return null;
}

/**
 * Resolve a choice to a usable seat, or refuse naming what is missing. A hosted choice resolves ONLY
 * to what a deployment injected — the engine will not conjure one, which is the whole of its
 * platform-agnosticism. `injected.module` is accepted so a hand-built backing can be handed in
 * directly (and so a law can drive one without writing a file).
 */
export async function resolveSeatBacking(
  choice: ResidencyBackingChoice,
  injected: {
    hosted?: Partial<SeatBacking> | undefined;
    /** May be a promise: a backing that opens connections is naturally async. */
    module?: Partial<SeatBacking> | Promise<Partial<SeatBacking>> | undefined;
  } = {},
): Promise<SeatResolution> {
  if (choice.backing === "conflict") {
    return { ok: false, refusal: "backing_conflict", seam: "backing", message: choice.why };
  }
  if (choice.backing === "none") {
    return { ok: false, refusal: "no_backend", seam: "backing", message: choice.why };
  }

  if (choice.backing === "local") {
    return { ok: true, seat: fileSeatBacking(choice.root), backing: "local" };
  }

  if (choice.backing === "module") {
    // AWAITED, because a backing OPENS THINGS. A factory that dials a store or reads a keyring is
    // naturally async, and calling it without awaiting yielded a Promise whose shape check then
    // reported `no_backend at seam claim — the hand-built backing has no claim()`. That refusal was
    // typed, named a seam, and was WRONG: the backing had a claim and the engine could not see it
    // through the promise. A precise refusal about the wrong thing is worse than a vague one,
    // because it sends the reader to the wrong file. Found by the seat that had to build against it.
    let candidate = await injected.module;
    if (!candidate) {
      try {
        const mod = (await import(choice.spec)) as {
          residencyBacking?: () => Partial<SeatBacking> | Promise<Partial<SeatBacking>>;
          default?: Partial<SeatBacking> | Promise<Partial<SeatBacking>>;
        };
        candidate = await (typeof mod.residencyBacking === "function" ? mod.residencyBacking() : mod.default);
      } catch (e) {
        return {
          ok: false,
          refusal: "no_backend",
          seam: "module",
          message: `${RESIDENCY_MODULE_VAR}=${choice.spec} could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    const missing = missingMember(candidate);
    if (missing) {
      return {
        ok: false,
        refusal: "no_backend",
        seam: missing,
        message: `the hand-built backing has no ${missing}() — a seat needs all of ${SEAT_MEMBERS.join(", ")}. A partial backing is refused rather than half-used.`,
      };
    }
    return { ok: true, seat: candidate as SeatBacking, backing: "module" };
  }

  // hosted — and the engine ships nothing for it ON PURPOSE.
  const missing = missingMember(injected.hosted);
  if (missing) {
    return {
      ok: false,
      refusal: "no_backend",
      seam: "hosted",
      message:
        `the hosted backing is supplied by the DEPLOYMENT, not by the engine — inject it (parallel ` +
        `to deps.queueGig / deps.mintVenueCredential). The engine ships the port, the local backing ` +
        `and the refusals; it deliberately holds no hosted provider of its own.`,
    };
  }
  return { ok: true, seat: injected.hosted as SeatBacking, backing: "hosted" };
}

// ── The local file-backed roster ─────────────────────────────────────────────────────────────────

interface SeatRow {
  residency_id: string;
  agent_slug: string;
  org: string;
  venue_slug: string;
  channel_id: string;
  session_id: string | null;
  status: string;
  cursor: number;
  host: string | null;
  lease_until: number;
  hands: string[];
  /** The fence on the CURRENT grant: monotonic, so a stale holder's token is simply LOWER. Never
   *  reset — zeroing it on release would make a resurrected host's old token valid again, which is
   *  the precise failure it exists to prevent. */
  fence: number;
}

/**
 * The fence check, and the reason the local backing has one at all: a backing laxer than the store it
 * stands in for lets a bug pass locally and fail only in production. Refused with the name the
 * ENGINE already uses for this rule (stale_fence, src/residency.ts:268) rather than a second name
 * for one invariant.
 */
function assertFence(root: string, id: string, fence: string): SeatRow {
  const row = readRow(root, id);
  if (Number(fence) < Number(row.fence)) {
    throw new Error(
      `stale_fence: a stale fence on residency ${id} — the lease was re-claimed, or this box never held it. Claim again.`,
    );
  }
  return row;
}

function rowPath(root: string, id: string): string {
  return join(root, `${id}.json`);
}
function readRow(root: string, id: string): SeatRow {
  return JSON.parse(readFileSync(rowPath(root, id), "utf8")) as SeatRow;
}
function writeRow(root: string, row: SeatRow): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(rowPath(root, row.residency_id), JSON.stringify(row, null, 2) + "\n");
}

/** Put one seat on a local roster so there is something to claim. The local counterpart of seating. */
export async function fileSeatSeed(root: string, seed: SeatSeed): Promise<string> {
  const row: SeatRow = {
    residency_id: randomUUID(),
    agent_slug: seed.agent_slug,
    org: seed.org,
    venue_slug: seed.venue_slug,
    channel_id: seed.channel_id,
    session_id: null,
    status: "unseated",
    cursor: 0,
    host: null,
    lease_until: 0,
    hands: [],
    fence: 0,
  };
  writeRow(root, row);
  return row.residency_id;
}

/**
 * A real seat on disk — not a stub. It holds a lease (so two boxes cannot both claim one roster) and
 * it refuses a cursor regression, because a local backing that were laxer than the hosted one it
 * stands in for would let a bug pass locally and fail only in production.
 */
export function fileSeatBacking(root: string): SeatBacking {
  const now = (): number => Date.now();

  return {
    claim: async (which) => {
      if (!existsSync(root)) return null;
      const ids = readdirSync(root).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
      for (const id of ids) {
        if (which !== "any" && id !== which) continue;
        const row = readRow(root, id);
        // A live lease is another box's seat. An expired one is reclaimable, so a crashed runner
        // never wedges the roster.
        if (row.host !== null && row.lease_until > now()) continue;
        row.host = "local";
        row.status = "seated";
        row.lease_until = now() + LOCAL_LEASE_MS;
        // A NEW grant gets a NEW grip. This is what makes a re-claim by the SAME box distinguishable
        // from its own expired grant — the failure an instance name cannot see.
        row.fence = (row.fence ?? 0) + 1;
        writeRow(root, row);
        return {
          residency_id: row.residency_id,
          agent_slug: row.agent_slug,
          org: row.org,
          venue_slug: row.venue_slug,
          channel_id: row.channel_id,
          session_id: row.session_id,
          cursor: row.cursor,
          // A local seat is not a minted credential and must never read as one.
          lease_token: `local:${row.residency_id}`,
          fence: String(row.fence),
          gig_id: null,
          may_dispatch: ["*"],
          hands: row.hands,
        };
      }
      return null;
    },

    heartbeat: async (id, fence) => {
      const row = assertFence(root, id, fence);
      row.lease_until = now() + LOCAL_LEASE_MS;
      writeRow(root, row);
    },

    release: async (id, fence, status) => {
      const row = assertFence(root, id, fence);
      row.status = status;
      row.host = null;
      writeRow(root, row);
    },

    cursorAdvance: async (id, fence, n) => {
      const row = assertFence(root, id, fence);
      if (n < row.cursor) {
        throw new Error(`cursor_regression: ${n} is behind the seat's cursor ${row.cursor} — a cursor only ever moves forward.`);
      }
      row.cursor = n;
      writeRow(root, row);
      return row.cursor;
    },
  };
}
