// worker.ts — the drain worker's verb set. The gig table IS the queue; this module is the
// consumer that turns a queued row into a completed one.
//
// The credential model is two keys with two jobs (governor rulings, 2026-08-10):
//   * a ctk_ AGENT token — per-agent, authenticates WHO is working. Claim, genome read, and
//     failure reporting all speak through it; authorization derives from the CHAIR CONTRACT
//     the agent is seated on (the store enforces it — "standards should be authorized on
//     chair contract"). A token narrows the office, never widens it.
//   * a cdk_ DRAIN key — per-ORGANIZATION, because the org is the resource boundary. It is
//     the write path for results (outputs + gig header), consumed by the engine's drain
//     layer via COLTRANE_DRAIN_URL / COLTRANE_DRAIN_KEY, not by this module directly.
//
// workOnce runs the claimed gig UNDER THE CLAIMED GIG'S ID (deps.gig_id), so the drained
// header completes the queue row itself — one record per gig, no parallel bookkeeping. A
// run that throws is recorded as failed through coltrane_mcp_gig_fail; a worker crash
// leaves only an expiring lease, which the claim RPC hands to the next worker.
//
// The third outcome is the HUMAN SEAT. A run that reaches a chair a person holds parks:
// coltrane_mcp_gig_park sets the row to awaiting_approval and clears the lease, so the store's
// approve RPC can re-queue it at once. The approval comes back on the next claim payload, and
// the durable checkpoint (workerStateRoot) means the approved re-claim RESTORES the chairs that
// already sealed instead of paying for them twice.
//
// THAT LOCAL CHECKPOINT IS ONLY THE FAST PATH. A human-in-the-loop delay is measured in hours
// or days, and the worker that re-claims is a different process — often on a different machine
// — from the one that parked. `workerStateRoot()` cannot travel, so on its own it makes the
// saving conditional on the accident of which box picked the row up.
//
// The SINK already is the checkpoint. Every sealed output drained to the org store carries its
// content_sha, its input_shas, its phase, its agent_slug and its whole `data`; the drained gig
// header carries the run's genome_hash. So a worker with no local record reconstructs one from
// the sink (`resumeStateFromDrain` below) and resumes from that. Resume state's home is the
// store; the local checkpoint demotes to a fast path.
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runGig, ResumeRefused, genomeHash, CORE_TO_PRIMITIVE, type AgentInvoker } from "./runtime.js";
import { loadRegistry, type Registry } from "./registry.js";
import { createOutputStore, type OutputStore } from "./outputs.js";
import { MemoryLedger } from "./ledger.js";
import { rpcGenomeStore } from "./genome_store.js";
import { workerCredentialMode } from "./worker_env.js";
import { prepareWorkspace } from "./workspace.js";
import { engineToolProviders, drainBudget, drainTimeoutMs } from "./run_deps.js";
import { createOutputMirror } from "./output_mirror.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import { sha256Hex, canonJson, outputContentHash, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import {
  createCheckpointStore, producersSha, CHECKPOINT_SCHEMA_VERSION,
  type GigCheckpoint, type CheckpointRole, type RunIdentity,
} from "./reuse.js";
import type { Standard, Chair } from "./composition.js";
import type { LoadedGenome } from "./loader.js";
import type { VenueRealizer } from "./venue_realizer.js";

/** Where the org store is, and who is working. */
export interface WorkerContext {
  baseUrl: string;
  anonKey: string;
  /**
   * The ctk_ capability token every RPC speaks through.
   *
   * In VENUE MODE this starts EMPTY and is filled in by each claim. That is the point: a drain is
   * a bandstand, not a musician, and between gigs it should hold no credential at all.
   */
  agentToken: string;
  /**
   * The venue's own credential — org-scoped, bound to `instance`, naming no player. When both this
   * and `instance` are set, claims go through `coltrane_drain_claim` and the store hands back a
   * token scoped to the claimed gig's `acting_for`, expiring with the lease.
   *
   * Absent, the worker claims the old way: as one player, using a token chosen at boot.
   */
  drainKey?: string;
  /**
   * The venue this drain key is bound to. Presented from anywhere else, the key is refused.
   *
   * This is the Fly APP, not the machine: FLY_APP_NAME is shared by every machine in an app, so
   * scaling to two machines gives both the same instance identity. That is intended — the venue is
   * the room, and a room may hold more than one stage. Claims stay disjoint because the store leases
   * `for update skip locked`. Per-MACHINE binding would be FLY_MACHINE_ID, and would mean
   * re-provisioning a key every time a machine is replaced.
   */
  instance?: string;
  /** Lease label recorded on the claimed row (defaults to worker:<acting_for> store-side). */
  worker?: string;
  /**
   * The venue slugs this box can stand up — every room whose ceiling, doors and credential surface
   * it can realize. A gig whose claim payload names a room NOT in this set is refused at the claim
   * (`venueMayClaim`), so work is not run in a room this box cannot build. Undefined or empty means
   * "the default room only": a named gig is not this worker's to take, deny-by-default.
   */
  realizableVenues?: readonly string[];
}

/** The claim RPC's payload: everything the worker needs to run the row it now leases. */
export interface ClaimedGig {
  gig_id: string;
  standard_slug: string;
  standard_version: number | null;
  mode: string;
  input: Record<string, unknown>;
  acting_for: string;
  /**
   * The repository this gig works in, named by the STORE from a governed column — never by the gig.
   * Null when the organization declares none, which is a normal answer: such gigs do not touch a
   * working tree. Only venue mode carries this; the player path leaves it undefined.
   */
  repo_url?: string | null;
  /**
   * The room the gig's chart named, carried onto the claim so the run can REALIZE that room rather
   * than infer it from the fact that nothing refused. Null when the gig named none (claimable by
   * anyone); undefined on the player path, which does not carry it.
   */
  venue?: string | null;
  /**
   * The human seat's verdicts, keyed by chair role — present on a RE-claim of a gig that
   * parked. The approve RPC writes them onto the row's manifest and re-queues it; the claim
   * hands them back here, and each entry carries the verdict AND who gave it, because the
   * approval seals under the approving principal's name rather than the worker's.
   */
  approvals?: Record<string, { verdict: Record<string, unknown>; approved_by?: string }> | null;
}

/**
 * The worker's durable state root: `checkpoints/` for the resume records, `outputs/` + `refs/`
 * for the sealed rows those records name — the sibling layout `createCheckpointStore` documents.
 *
 * BOTH halves have to outlive the process. A worker is a short-lived consumer: it claims one
 * row and exits, and the approved re-claim is a DIFFERENT process. A checkpoint whose outputs
 * the next process cannot read refuses the resume it exists to permit, so the run would be
 * paid for twice — which is the whole cost this store exists to avoid.
 */
export function workerStateRoot(): string {
  const override = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".coltrane", "worker-checkpoints");
}

/** Default worker-state TTL, in days. A checkpoint older than this is presumed abandoned. */
export const DEFAULT_WORKER_STATE_TTL_DAYS = 7;

/** Resolve the reaper TTL from `COLTRANE_WORKER_STATE_TTL_DAYS`, falling back to the default. */
export function workerStateTtlDays(): number {
  const raw = process.env["COLTRANE_WORKER_STATE_TTL_DAYS"];
  if (raw && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_WORKER_STATE_TTL_DAYS;
}

export interface ReapOptions {
  /** Age threshold in days. State whose mtime is older than this is eligible. Defaults to `workerStateTtlDays()`. */
  ttlDays?: number;
  /** "Now", in epoch ms, for the age comparison. Defaults to `Date.now()` at call time (never module load). */
  now?: number;
}

export interface ReapResult {
  /** gig ids whose checkpoint (+ siblings) were removed for being older than the TTL. */
  checkpoints_removed: string[];
  /** gig ids whose orphan output/refs rows (no live checkpoint) were removed for age. */
  orphans_removed: string[];
  /** How many checkpoint files were inspected and KEPT (fresh, or load-bearing). */
  kept: number;
  /** Non-fatal per-file errors, so a partial sweep is visible without throwing. */
  errors: string[];
}

/**
 * Bound the worker state root's growth. The runtime deletes a checkpoint on SUCCESS, but a
 * FAILED / awaiting-approval / abandoned gig leaves its `checkpoints/<gig>.json` (plus the
 * `outputs/<gig>.jsonl` + `refs/<gig>.jsonl` it names) behind forever — an unbounded disk
 * leak. This drops what is old enough to be presumed abandoned.
 *
 * WHAT IT TOUCHES:
 *  - A `checkpoints/<gig>.json` whose MTIME is older than the TTL, together with that gig's
 *    sibling `outputs/<gig>.jsonl` and `refs/<gig>.jsonl` — they are dead weight once the
 *    checkpoint that named them is gone.
 *  - An ORPHAN `outputs/<gig>.jsonl` / `refs/<gig>.jsonl` (no checkpoint file for that gig at
 *    all — e.g. a completed gig whose checkpoint was already dropped on success) older than the
 *    TTL. This is the other half of the leak: success removes the checkpoint but leaves the rows.
 *
 * WHAT IT NEVER TOUCHES:
 *  - Any gig whose checkpoint is FRESHER than the TTL. A parked / awaiting-approval gig's
 *    checkpoint is LOAD-BEARING for the approved resume, and the TTL is the "reasonable window"
 *    that protects it — the reaper cannot see the org store's row status locally, so mtime is
 *    the proxy: recent state is kept. A fresh checkpoint's outputs are never swept even if the
 *    outputs file itself looks old (a restore-only resume re-touches the checkpoint but appends
 *    no new rows), because the sweep is driven from checkpoint age, not output age.
 *
 * Best-effort by construction: every filesystem op is caught and recorded in `errors`; the
 * function never throws, so a reap failure can never fail the claim it runs ahead of.
 */
export function reapWorkerState(root: string, opts?: ReapOptions): ReapResult {
  const result: ReapResult = { checkpoints_removed: [], orphans_removed: [], kept: 0, errors: [] };
  const ttlDays = opts?.ttlDays ?? workerStateTtlDays();
  const now = opts?.now ?? Date.now();
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const cpDir = join(root, "checkpoints");
  const outDir = join(root, "outputs");
  const refDir = join(root, "refs");

  const listDir = (dir: string): string[] => {
    try {
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    } catch (e) {
      result.errors.push(`readdir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const ageMs = (file: string): number | null => {
    try {
      return now - fs.statSync(file).mtimeMs;
    } catch (e) {
      result.errors.push(`stat ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const rm = (file: string): void => {
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      result.errors.push(`rm ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Pass 1 — checkpoint-driven. A gig id is exactly a checkpoint file's basename.
  const liveGigs = new Set<string>();
  for (const name of listDir(cpDir)) {
    if (!name.endsWith(".json")) continue;
    const gig = name.slice(0, -".json".length);
    const age = ageMs(join(cpDir, name));
    if (age === null) { liveGigs.add(gig); continue; } // couldn't stat → keep, don't guess
    if (age > ttlMs) {
      rm(join(cpDir, name));
      rm(join(outDir, `${gig}.jsonl`));
      rm(join(refDir, `${gig}.jsonl`));
      result.checkpoints_removed.push(gig);
    } else {
      // Fresh checkpoint — load-bearing. Its gig's rows are protected regardless of their own age.
      liveGigs.add(gig);
      result.kept += 1;
    }
  }

  // Pass 2 — orphan rows: an outputs/refs file for a gig that has NO checkpoint at all.
  const sweepOrphans = (dir: string): void => {
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const gig = name.slice(0, -".jsonl".length);
      if (liveGigs.has(gig)) continue; // a live checkpoint owns it — keep
      if (result.checkpoints_removed.includes(gig)) continue; // already removed as a sibling
      const age = ageMs(join(dir, name));
      if (age === null || age <= ttlMs) continue;
      rm(join(dir, name));
      if (!result.orphans_removed.includes(gig)) result.orphans_removed.push(gig);
    }
  };
  sweepOrphans(outDir);
  sweepOrphans(refDir);

  return result;
}

export type WorkOnceResult =
  | { claimed: false }
  | {
      claimed: true;
      gig_id: string;
      /** `awaiting_approval` is its own outcome: a run that reached a human chair is neither
       *  finished nor broken, and calling it either would be a lie the operator acts on. */
      status: "complete" | "failed" | "awaiting_approval";
      outputs_count?: number;
      error?: string;
      /** Present iff awaiting_approval: the human chair the run parked at. */
      awaiting?: { phase: string; role: string };
    };

export interface WorkOnceDeps {
  /** Build the chair invoker against the STORE registry (types the org's outputs seal to). */
  makeInvoke(registry: Registry, genome: LoadedGenome): AgentInvoker;
  /** Progress line sink (CLI wires stderr); silent by default. */
  log?(line: string): void;
  /**
   * The SUBSTRATE realizer a venue-named claim's room is stood up on — supplied by the SAME bootstrap
   * that populates `WorkerContext.realizableVenues`, so the realizer and the room-declaration it
   * builds come from one place. Threaded into `runGig` beside the claim's `venue` when the room
   * declares `mcp_servers` (mirroring the server's chart path). Absent = this box builds no room's
   * substrate; a venue-named claim whose room declares servers then fails closed rather than running
   * the room unbuilt (see `workOnce`). Injected, never constructed here — building a docker-backed
   * factory inside `workOnce` would pull substrate the drain does not own into the claim path.
   */
  venueRealizer?: VenueRealizer;
}

async function workerRpc(ctx: WorkerContext, fn: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${ctx.baseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: ctx.anonKey,
      // A ctk_ bearer is not a JWT — it authenticates inside the definer RPC via the body;
      // the transport rides the anon key.
      Authorization: `Bearer ${ctx.anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text || `store error ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch { /* keep the raw text */ }
    throw new Error(`${fn}: ${message}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

/**
 * The ONE oracle for "may this worker take a gig aimed at this room" — total and pure, so the
 * claim path, the worker-side check and any future store-side gate implement one rule rather than
 * three that can drift.
 *
 *  - Unnamed (`null`/`undefined` gigVenue): open to ANY worker, including one that declares no
 *    realizable rooms. This is the law that stops targeting from becoming mandatory routing — an
 *    unnamed gig must stay claimable by anyone or a queue with no matching worker silently stalls.
 *  - Named: open only to a worker whose `realizable` set includes that room. Deny-by-default —
 *    undefined or an empty realizable set with a named room is `false`, the same way an absent
 *    venue field means the empty room a worker declaring nothing can still stand up.
 */
export function venueMayClaim(
  gigVenue: string | null | undefined,
  realizable: readonly string[] | undefined,
): boolean {
  if (gigVenue === null || gigVenue === undefined) return true;
  return realizable !== undefined && realizable.includes(gigVenue);
}

/**
 * Atomically claim the oldest runnable gig (queued, or running with an expired lease). Null means
 * the queue holds nothing for us.
 *
 * TWO MODES, and the difference is who is asking.
 *
 * VENUE (drainKey + instance): the box authenticates as itself and claims ANY gig dispatched to its
 * org, then receives a credential minted for THAT GIG's `acting_for`, expiring with the lease. This
 * is the correct shape — a gig is dispatched to a venue and the chart names who plays. It also
 * removes a real defect: `coltrane_mcp_claim` filters the queue by the CLAIMER's chairs, though
 * authority was already settled at dispatch and recorded in `acting_for`. A gig legitimately
 * dispatched by steve-2 was simply invisible to a box booted as steve-1, and the queue merely
 * LOOKED empty.
 *
 * PLAYER (agentToken only): the historical path, unchanged. A player claims what its own chairs
 * authorize, which is right for a player — it was only ever wrong for a drain forced to be one.
 *
 * The venue path REPLACES ctx.agentToken on every claim. The previous gig's credential is dropped
 * the moment the next one is taken, so a compromised drain holds exactly one gig's authority and
 * only until that lease expires.
 */
export async function claimNextGig(ctx: WorkerContext): Promise<ClaimedGig | null> {
  // ONE DERIVATION, and it is the same one the CLI door asks — Gap 4's whole point. This used to
  // re-derive `ctx.drainKey && ctx.instance` here, which is the second home the specification
  // named; the defensive branch below it existed only because two homes might disagree.
  //
  // The REFUSAL travels with the derivation rather than being deleted alongside the duplicate.
  // That distinction is the amend: removing a redundant boolean is the goal, and removing a
  // refusal is collateral. `claimNextGig` is an exported function, so a context assembled outside
  // the CLI reaches here directly — and `venueCtx`-shaped contexts carry an EMPTY agentToken by
  // design (the credential arrives with the work). Without this, a drain key that lost its
  // instance falls through to the player path and presents that empty bearer to the store, which
  // is precisely the hazard tests/spec_worker_run_modes.test.ts names in its preamble.
  const mode = workerCredentialMode({
    COLTRANE_DRAIN_KEY: ctx.drainKey,
    COLTRANE_AGENT_TOKEN: ctx.agentToken,
    COLTRANE_INSTANCE: ctx.instance,
  });
  if (mode.mode === "none") throw new Error(mode.why);

  if (mode.mode === "venue") {
    const out = await workerRpc(ctx, "coltrane_drain_claim", {
      p_key: ctx.drainKey,
      p_instance: ctx.instance,
    });
    if (!out) return null;
    const claim = out as ClaimedGig & { token?: string };
    if (!claim.token) {
      // Fail loudly. Continuing with a stale or empty bearer would fail later, deeper, and as
      // something that reads like an authorization bug rather than a store that did not mint.
      //
      // KNOWN CONSEQUENCE, accepted: the store has already leased the row, so it sits `running`
      // until the lease expires (30 minutes) before anything can reclaim it. Releasing it here is
      // not possible — every release RPC speaks through the credential that was not minted. A store
      // that claims without minting is broken in a way a worker cannot repair, and stalling one row
      // for one lease window is the correct price for not proceeding unauthenticated.
      throw new Error(
        `coltrane_drain_claim leased ${claim.gig_id} but minted no credential; the row stays leased ` +
          `until its lease expires`,
      );
    }
    // ADDITIVE to the single credential-mode derivation above — it reads the claim the store already
    // handed back, never a second derivation of anything. Placed BEFORE the credential is replaced,
    // so a refused claim never updates the worker's token. The refusal names BOTH the gig's room and
    // this worker's realizable set so the operator learns which is misconfigured; the leased row
    // stays running until its lease expires, the same accepted price as the no-mint case above.
    if (!venueMayClaim(claim.venue, ctx.realizableVenues)) {
      throw new Error(
        `claimed gig ${claim.gig_id} names venue "${claim.venue}", which this worker cannot realize ` +
          `(realizable: ${JSON.stringify(ctx.realizableVenues ?? [])}); the row stays leased until its lease expires`,
      );
    }
    ctx.agentToken = claim.token;
    return claim;
  }

  const out = await workerRpc(ctx, "coltrane_mcp_claim", {
    p_bearer: ctx.agentToken,
    p_worker: ctx.worker ?? null,
  });
  const claim = (out as ClaimedGig | null) ?? null;
  // Deny-by-default on the player path too, not scoped to venue mode: SPEC item 4 refuses a claim
  // naming a room this worker cannot realize with no reference to how the worker logged in. Same
  // shared oracle, same both-slugs refusal.
  if (claim && !venueMayClaim(claim.venue, ctx.realizableVenues)) {
    throw new Error(
      `claimed gig ${claim.gig_id} names venue "${claim.venue}", which this worker cannot realize ` +
        `(realizable: ${JSON.stringify(ctx.realizableVenues ?? [])})`,
    );
  }
  return claim;
}

/**
 * Release the lease on a PARKED gig: the row goes `awaiting_approval` and its lease clears, so
 * an approval can re-queue it immediately instead of waiting the lease out. Deliberately NOT
 * `gig_fail` — a run waiting on a person is not a failed run, and recording it as one both lies
 * to the operator and takes the row out of the approve→requeue path.
 *
 * False means the store did not record the release — including a store that has not deployed
 * the RPC yet. The run's own drained header already carries `awaiting_approval`, so an absent
 * release is a missing convenience, not a lost fact, and must not fail the claim.
 */
export async function parkGig(ctx: WorkerContext, gig_id: string): Promise<boolean> {
  try {
    const out = await workerRpc(ctx, "coltrane_mcp_gig_park", {
      p_bearer: ctx.agentToken,
      p_gig: gig_id,
    });
    return out === true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // PostgREST answers an undeployed function with PGRST202 / "Could not find the function".
    if (/PGRST202|could not find the function|does not exist/i.test(message)) return false;
    throw e;
  }
}

/** Record a failed run on the claimed row. True iff the store recorded it (row was running). */
export async function failGig(ctx: WorkerContext, gig_id: string, error: string): Promise<boolean> {
  const out = await workerRpc(ctx, "coltrane_mcp_gig_fail", {
    p_bearer: ctx.agentToken,
    p_gig: gig_id,
    p_error: error,
  });
  return out === true;
}

// ───────────────────────────────────────────────────────────────────────────────
// Resume state, reconstructed from the drain
// ───────────────────────────────────────────────────────────────────────────────

/**
 * One sealed row as `coltrane_mcp_gig_outputs` hands it back — the sink's view of an output.
 *
 * NARROWER than an `OutputRecord`, and the gap is the whole difficulty: the sink returns no
 * `core_type`, no `domain`, no `primitive`, no `domain_type_version` and no `from_role`. Every
 * one of the first four is folded into `content_sha`, so they are RE-DERIVED from the loaded
 * genome the way the seal boundary derives them, and the re-derivation is then proved against
 * the sha the sink recorded. A row that no longer hashes to its claimed sha is refused.
 */
export interface DrainedOutput {
  id: string;
  domain_type: string;
  agent_slug: string;
  phase?: string | null;
  content_sha: string;
  input_shas?: readonly (string | null)[] | null;
  created_at: string;
  data: Record<string, unknown>;
}

/** A reconstruction either produced a checkpoint or refused, and a refusal always says why. */
export type DrainResumeState =
  | { ok: true; checkpoint: GigCheckpoint }
  | { ok: false; reason: string };

/** The sink's sealed rows for one gig. `[]` covers "no drain to read" as well as "nothing drained". */
export async function fetchDrainedOutputs(
  ctx: WorkerContext,
  gig_id: string,
): Promise<{ rows: DrainedOutput[]; error?: string }> {
  let out: unknown;
  try {
    out = await workerRpc(ctx, "coltrane_mcp_gig_outputs", { p_bearer: ctx.agentToken, p_gig: gig_id });
  } catch (e) {
    // Every failure here is the same kind of event: resume state could not be read. The queue
    // row is still runnable work, so this never fails the claim — it costs a cold run, which is
    // exactly what the worker did before this path existed.
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (!Array.isArray(out)) return { rows: [] };
  return { rows: out.filter((r): r is DrainedOutput => !!r && typeof r === "object") };
}

/**
 * The `genome_hash` the sink recorded on this gig's drained HEADER.
 *
 * This is the only identity a drained gig carries, and reading it is what keeps the
 * reconstruction from being a splice. `genomeHash` folds the standard's whole phase graph and
 * every bound agent's type surface — chair `depends_on`, `input_contract`, an added or removed
 * phase — none of which reaches an individual row's `content_sha`. Without this check a
 * pipeline could be re-wired between the park and the approval and the restored outputs would
 * be consumed by chairs that never produced them, with nothing in the manifest recording it.
 *
 * STATED GAP: the header carries no `producers_sha`, so a rewritten agent `method` (or a
 * rewritten skill under a stable version) is invisible to this path — the very hole
 * `RunIdentity.producers_sha` exists to close for a LOCAL checkpoint. A drain-reconstructed
 * resume is therefore a weaker gate than a local one by exactly that much, and the strongest
 * available check is the one applied: the sink's structural hash plus a per-row re-seal.
 */
export async function fetchDrainedGenomeHash(
  ctx: WorkerContext,
  gig_id: string,
): Promise<{ genome_hash?: string; error?: string }> {
  let out: unknown;
  try {
    out = await workerRpc(ctx, "coltrane_mcp_gig_status", { p_bearer: ctx.agentToken, p_gig: gig_id });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  // The RPC may answer with the header row or a single-row array; both are the same fact.
  const row = Array.isArray(out) ? out[0] : out;
  if (!row || typeof row !== "object") return {};
  const gh = (row as Record<string, unknown>)["genome_hash"];
  // 64 hex or nothing: the header stores `null` for a run with no hash, and the ledger writes
  // "n/a" in places. Neither is a genome identity, and treating one as if it were is the bug.
  return typeof gh === "string" && /^[0-9a-f]{64}$/.test(gh) ? { genome_hash: gh } : {};
}

/** What a chair would seal, and under whose name — one entry per domain_type it promises. */
interface ChairSeat {
  chair: Chair;
  phase: string;
  /** The office. A human chair's incumbent is not knowable from the genome, hence `human`. */
  producer: { kind: "agent" | "skill"; slug: string } | { kind: "human" };
  specs: Map<string, { core_type: string; primitive: string; domain: string }>;
}

/**
 * Re-derive every chair's seal specs from the loaded standard.
 *
 * This mirrors the runtime's own derivation chair-kind for chair-kind (`outputSpecsFor`, the
 * skill-backed branch of `prepareChair`, and the human-seat branch of the phase loop), because
 * `content_sha` folds exactly what it produces. Divergence here would not be a cosmetic
 * mismatch — it would compute a different sha for an unchanged row and refuse every resume.
 */
function chairSeats(standard: Standard, outputs: OutputStore): ChairSeat[] {
  const seats: ChairSeat[] = [];
  for (const phase of standard.phases) {
    for (const chair of phase.chairs) {
      const specs = new Map<string, { core_type: string; primitive: string; domain: string }>();
      if (chair.human === true && (chair.agent_slug ?? "") === "") {
        const dt = chair.output_contract[0] ?? "Judgment";
        const core = outputs.coreTypeOf(dt) ?? dt;
        specs.set(dt, { core_type: core, primitive: CORE_TO_PRIMITIVE[core] ?? "JUDGE", domain: standard.domain });
        seats.push({ chair, phase: phase.name, producer: { kind: "human" }, specs });
        continue;
      }
      if (chair.skill_slug && (chair.agent_slug ?? "") === "") {
        const dt = chair.output_contract[0] ?? "Signal";
        const core = outputs.coreTypeOf(dt) ?? "Signal";
        specs.set(dt, { core_type: core, primitive: CORE_TO_PRIMITIVE[core] ?? "SENSE", domain: standard.domain });
        seats.push({ chair, phase: phase.name, producer: { kind: "skill", slug: chair.skill_slug }, specs });
        continue;
      }
      const agent = standard.agents.find((a) => a.slug === chair.agent_slug);
      const fallback = agent?.primitives[0];
      // A chair whose agent the genome no longer holds could not have sealed anything under
      // THIS genome. Skipping it means its rows find no seat and the reconstruction refuses,
      // which is the honest outcome.
      if (!agent || !fallback) continue;
      const wanted = chair.output_contract.length
        ? agent.output_types.filter((t) => chair.output_contract.includes(t))
        : agent.output_types;
      const domain = agent.domain ?? standard.domain;
      for (const dt of wanted) {
        const core = outputs.coreTypeOf(dt) ?? PRIMITIVE_OUTPUT_TYPE[fallback];
        specs.set(dt, { core_type: core, primitive: CORE_TO_PRIMITIVE[core] ?? fallback, domain });
      }
      seats.push({ chair, phase: phase.name, producer: { kind: "agent", slug: agent.slug }, specs });
    }
  }
  return seats;
}

/**
 * The run identity a COLD run of this claim would compute, field for field.
 *
 * Kept adjacent to the `runGig` call in `workOnce` on purpose: `model_version` and `depth` are
 * that call's defaults (it passes neither), and `skills: []` is what `resolvedSkillHashes()`
 * folds for a worker that registers no `skill_dirs` — a store-loaded skill has no code half by
 * construction. Change what `workOnce` passes and this has to move with it, or every
 * reconstruction is refused for identity drift against its own run.
 */
function coldRunIdentity(standard: Standard, gigInput: Record<string, unknown>): RunIdentity {
  return {
    standard_slug: standard.slug,
    genome_hash: genomeHash(standard),
    producers_sha: producersSha({ agents: standard.agents, skills: [] }),
    gig_input_sha: sha256Hex(canonJson(gigInput)),
    model_version: "unknown",
    depth: "",
    canonical_form_version: CANONICAL_FORM_VERSION,
  };
}

/** One verified sink row, with the chair it maps to and the spec it re-seals under. */
interface PlannedRestore {
  row: DrainedOutput;
  seat: ChairSeat;
  spec: { core_type: string; primitive: string; domain: string };
  fingerprint: string;
}

/** Accumulate one restored record onto its chair's checkpoint role, whether written or adopted. */
function noteRole(
  byRole: Map<string, CheckpointRole>,
  p: PlannedRestore,
  output_id: string,
  content_sha: string,
): void {
  const role = p.seat.chair.role;
  const cur = byRole.get(role) ?? {
    role, phase: p.seat.phase,
    output_ids: [], content_shas: [], domain_types: [], type_fingerprints: [],
    sealed_at: p.row.created_at,
  };
  cur.output_ids.push(output_id);
  cur.content_shas.push(content_sha);
  cur.domain_types.push(p.row.domain_type);
  cur.type_fingerprints.push(p.fingerprint);
  if (p.row.created_at > cur.sealed_at) cur.sealed_at = p.row.created_at;
  byRole.set(role, cur);
}

/**
 * Turn the sink's sealed rows into a resume checkpoint — or refuse, with a reason.
 *
 * ALL-OR-NOTHING, in two passes. Pass one derives and verifies every row while nothing is
 * durable; pass two writes. A gig whose second row fails must not leave its first one in the
 * local store seeding a half-resume, which is the same invariant #243 gave a single chair, one
 * scope up.
 *
 * ROLE MAPPING. The sink does not record `from_role`, so each row is mapped to a chair by
 * `phase` + the chair's SEAT: `agent_slug` for an agent chair, the skill slug for a skill-backed
 * one, and name-agnostically for a human chair (its record seals under the approving principal,
 * whom the genome cannot know). The row's `domain_type` narrows further — a chair that does not
 * seal that type is not a candidate. Zero candidates or MORE THAN ONE both refuse: a guess about
 * which chair produced a sealed output is a guess about the provenance chain.
 *
 * SHA VERIFICATION. Every row is re-sealed under the derived core/primitive/domain and the sha
 * compared to the one the sink recorded. A mismatch refuses the WHOLE reconstruction — a sink
 * row that no longer hashes to its claimed sha must never silently seed a resume, and one such
 * row is evidence about the sink, not about that row alone.
 */
export function resumeStateFromDrain(args: {
  gig_id: string;
  standard: Standard;
  identity: RunIdentity;
  rows: readonly DrainedOutput[];
  outputs: OutputStore;
}): DrainResumeState {
  const { gig_id, standard, identity, rows, outputs } = args;
  if (rows.length === 0) return { ok: false, reason: "the sink holds no sealed outputs for this gig" };
  const seats = chairSeats(standard, outputs);
  // created_at order, so a row's in-gig predecessors are already re-written when it is written.
  const ordered = [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const planned: PlannedRestore[] = [];
  for (const row of ordered) {
    const phase = typeof row.phase === "string" && row.phase !== "" ? row.phase : undefined;
    if (phase === undefined) {
      return { ok: false, reason: `sink row "${row.id}" records no phase, so it cannot be mapped to a chair` };
    }
    if (typeof row.content_sha !== "string" || !row.data || typeof row.data !== "object") {
      return { ok: false, reason: `sink row "${row.id}" is not a sealed output shape (content_sha + data)` };
    }
    const candidates = seats.filter(
      (s) => s.phase === phase && s.specs.has(row.domain_type) &&
        (s.producer.kind === "human" || s.producer.slug === row.agent_slug),
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: `no chair in phase "${phase}" seals "${row.domain_type}" for producer "${row.agent_slug}" — the standard has moved since that output sealed`,
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: `chairs [${candidates.map((c) => c.chair.role).join(", ")}] in phase "${phase}" could each have sealed "${row.domain_type}" — the sink records no from_role, so the mapping is ambiguous`,
      };
    }
    const seat = candidates[0]!;
    const spec = seat.specs.get(row.domain_type)!;
    // The registry moves independently of the standard, so genome_hash does not see a type that
    // changed shape. Same fingerprint tool the local resume gate and the reuse cache use.
    const fingerprint = outputs.typeFingerprint(row.domain_type);
    if (fingerprint === "") {
      return { ok: false, reason: `the registry can no longer describe type "${row.domain_type}", so the sink's row cannot be checked` };
    }
    const gate = outputs.validateWrite({ core_type: spec.core_type, domain_type: row.domain_type, data: row.data });
    if (!gate.valid) {
      return { ok: false, reason: `sink row "${row.id}" would not pass the seal boundary today — ${gate.reason}` };
    }
    const sha = outputContentHash({
      core_type: spec.core_type,
      domain_type: row.domain_type,
      domain_type_version: 1,
      domain: spec.domain,
      primitive: spec.primitive,
      phase,
      agent_slug: row.agent_slug,
      data: row.data,
    });
    if (sha !== row.content_sha) {
      return {
        ok: false,
        reason: `sink row "${row.id}" ("${row.domain_type}", phase "${phase}") re-seals to a different content_sha than the sink recorded — the row no longer hashes to its claimed content_sha`,
      };
    }
    planned.push({ row, seat, spec, fingerprint });
  }

  // Pass two — durable. The resume gate resolves a checkpoint's `output_ids` against the LOCAL
  // output store, so the sink's rows have to become local records before they can be restored.
  //
  // IDEMPOTENT. The local store may already hold these rows: the checkpoint file can go missing
  // while `outputs/<gig_id>.jsonl` survives (a swallowed checkpoint write, a cleared checkpoints
  // dir), and appending second copies would leave `output_query` and `output_trace` reporting a
  // gig that sealed each record twice. An existing IN-GIG record with the same content_sha IS
  // that record — content_sha folds core, type, version, domain, primitive, phase, agent_slug and
  // data, so an identical sha is an identical derivation — and it is adopted by id.
  const alreadyHeld = new Map<string, string>();
  for (const rec of outputs.all()) {
    if (rec.gig_id === gig_id && !alreadyHeld.has(rec.content_sha)) alreadyHeld.set(rec.content_sha, rec.id);
  }
  const byRole = new Map<string, CheckpointRole>();
  const shaToId = new Map<string, string>();
  for (const p of planned) {
    const adopted = alreadyHeld.get(p.row.content_sha);
    if (adopted !== undefined) {
      shaToId.set(p.row.content_sha, adopted);
      noteRole(byRole, p, adopted, p.row.content_sha);
      continue;
    }
    const inputShas = (p.row.input_shas ?? []).map((s) => (typeof s === "string" ? s : ""));
    const mapped = inputShas.map((s) => shaToId.get(s));
    // Object identity is machine-local: the sink's own output ids name nothing here, and the ids
    // of the rows we are writing are fresh. The HASH chain does travel — each `input_sha` names
    // the content a row consumed — so remap ids only when every entry resolves, and otherwise
    // keep the engine-stamped hashes and leave `input_refs` empty rather than emit a
    // half-aligned pair.
    const remapped = mapped.every((id) => typeof id === "string") ? (mapped as string[]) : undefined;
    let rec;
    try {
      rec = outputs.write({
        core_type: p.spec.core_type,
        domain_type: p.row.domain_type,
        domain_type_version: 1,
        domain: p.spec.domain,
        gig_id,
        agent_slug: p.row.agent_slug,
        from_role: p.seat.chair.role,
        phase: p.seat.phase,
        primitive: p.spec.primitive,
        data: p.row.data,
        input_refs: remapped ?? [],
        input_shas: inputShas,
      });
    } catch (e) {
      // Unreachable: `validateWrite` above is the same gate `write` runs, from one implementation.
      return { ok: false, reason: `sink row "${p.row.id}" could not be written locally — ${e instanceof Error ? e.message : String(e)}` };
    }
    if (rec.content_sha !== p.row.content_sha) {
      return { ok: false, reason: `sink row "${p.row.id}" sealed locally to a different content_sha than the sink recorded` };
    }
    shaToId.set(rec.content_sha, rec.id);
    noteRole(byRole, p, rec.id, rec.content_sha);
  }

  return {
    ok: true,
    checkpoint: {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      gig_id,
      identity,
      // The sink's own timestamps. `prior_usage` is deliberately absent: the outputs RPC carries
      // no cost fields, so what the earlier attempt spent is genuinely unknown here, and an
      // invented zero would be the "not captured reported as $0.00" defect #235/#236 removed.
      started_at: ordered[0]!.created_at,
      updated_at: ordered[ordered.length - 1]!.created_at,
      roles: [...byRole.values()],
    },
  };
}

/** Read the sink and rebuild this claim's resume state, or say why it cannot be rebuilt. */
async function rebuildFromDrain(
  ctx: WorkerContext,
  claim: ClaimedGig,
  standard: Standard,
  outputs: OutputStore,
): Promise<DrainResumeState> {
  const drained = await fetchDrainedOutputs(ctx, claim.gig_id);
  if (drained.error !== undefined) return { ok: false, reason: `the sink's outputs could not be read — ${drained.error}` };
  if (drained.rows.length === 0) return { ok: false, reason: "the sink holds no sealed outputs for this gig" };

  const header = await fetchDrainedGenomeHash(ctx, claim.gig_id);
  const current = genomeHash(standard);
  if (header.genome_hash === undefined) {
    // A miss is free; a wrong hit is not. An identity that cannot be checked resolves to doing
    // the work — the same asymmetry every other substitution gate in this engine resolves on.
    return {
      ok: false,
      reason: `the sink reports no genome_hash for this gig${header.error !== undefined ? ` (${header.error})` : ""}, so the pipeline those outputs sealed under cannot be checked`,
    };
  }
  if (header.genome_hash !== current) {
    return {
      ok: false,
      reason: `the genome moved since those outputs sealed (sink genome_hash="${header.genome_hash}" current="${current}")`,
    };
  }
  return resumeStateFromDrain({
    gig_id: claim.gig_id,
    standard,
    identity: coldRunIdentity(standard, claim.input),
    rows: drained.rows,
    outputs,
  });
}

/**
 * Map the claim's per-role approval entries onto runGig's two arguments.
 *
 * The store keys each verdict by ROLE (a standard may hold more than one human chair) while
 * runGig takes a single `approved_by` for the run. So the name is read from the entry for the
 * chair this claim will actually reach — the first human chair the checkpoint does not already
 * hold — and falls back to the first entry when that is not discernible. Attribution on a seal
 * is not decoration: the approval output carries it as its `agent_slug`.
 */
export function approvalWiring(
  approvals: ClaimedGig["approvals"],
  standard: Standard,
  completedRoles: readonly string[] = [],
): { approvals?: Record<string, Record<string, unknown>>; approved_by?: string } {
  const entries = Object.entries(approvals ?? {}).filter(
    ([, e]) => e && typeof e.verdict === "object" && e.verdict !== null,
  );
  if (entries.length === 0) return {};
  const held = new Set(completedRoles);
  const awaitingRole = standard.phases
    .flatMap((p) => p.chairs)
    .find((c) => c.human === true && !held.has(c.role))?.role;
  const named = (awaitingRole === undefined ? undefined : entries.find(([role]) => role === awaitingRole)) ?? entries[0]!;
  const approved_by = named[1].approved_by;
  return {
    approvals: Object.fromEntries(entries.map(([role, e]) => [role, e.verdict])),
    ...(typeof approved_by === "string" && approved_by !== "" ? { approved_by } : {}),
  };
}

/** One unit of work: claim → load the org genome (as the agent) → run under the claimed
 *  gig's id → results drain via the org drain key (engine drain layer, env-configured), or
 *  the failure is recorded. Never throws for a run failure — a thrown claim/store error
 *  means the worker itself could not speak to the store.
 *
 *  A run that reaches an unapproved human chair PARKS: the row is released (parkGig) and the
 *  outcome is `awaiting_approval` — its own status, because it is neither finished nor broken. */
export async function workOnce(ctx: WorkerContext, deps: WorkOnceDeps): Promise<WorkOnceResult> {
  const log = deps.log ?? (() => {});
  // Best-effort bounded reap of the worker state root before we claim. Wrapped so a reap
  // failure can never fail a claim — the money-losing outcome is a run refused, not a file kept.
  try {
    const reaped = reapWorkerState(workerStateRoot());
    if (reaped.checkpoints_removed.length > 0 || reaped.orphans_removed.length > 0) {
      log(`reaped worker state: ${reaped.checkpoints_removed.length} checkpoint(s), ${reaped.orphans_removed.length} orphan row(s)`);
    }
  } catch (e) {
    log(`worker-state reap skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  const claim = await claimNextGig(ctx);
  if (!claim) return { claimed: false };
  log(`claimed ${claim.gig_id} (${claim.standard_slug}, ${claim.mode}) as ${claim.acting_for}`);

  // THE WORKING TREE IS OBTAINED AFTER THE CLAIM, and that ordering is the point. The shell used to
  // clone first, from a REPO_URL fixed at provisioning, which made a per-gig fact a per-box one and
  // pinned every gig of an organization to one repository. Here the store names it on the claim and
  // the credential is minted against this gig's live lease — so a drain between gigs holds no git
  // credential at all, and no repository is reachable that the store did not name.
  //
  // The cwd is changed rather than threaded through runGig: `coltrane work` claims once, runs once
  // and exits, so there is exactly one gig per process and nothing else to disturb. Restored in the
  // finally regardless, because a process that outlived its assumption would be worse than a
  // stranded temp directory.
  const cwdBefore = process.cwd();
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> = null;
  // Declared out here so the finally can clear it: a timer left armed keeps the process alive past
  // a finished gig, which on a drain means the loop's next claim waits on nothing.
  let deadline: ReturnType<typeof setTimeout> | undefined;

  try {
    // ── ONE TREE PER GIG: the Booker clones ONLY when the realized room will NOT populate. ──────────
    // A claim that names both a venue and a repository, on a box that holds a realizer, gets its
    // working tree from realize()'s own prepareWorkspace (SITE below, threaded via venueWiring) —
    // populating the room's workspace through the SAME src/workspace.ts mechanism this Booker uses.
    // Cloning HERE as well would mint a SECOND git credential and stand up a SECOND live tree for one
    // gig — the collision. The decision uses only facts available BEFORE the genome load at :939:
    // claim.venue and claim.repo_url (claim-level ClaimedGig fields) plus the run-level venueRealizer
    // dep. No genome is hoisted; reordering the load would entangle the workspace lifecycle with
    // genome-load failure paths, which is exactly what is avoided here.
    //
    // ERROR PATHS. When SUPPRESSED the Booker neither clones nor mints, so the whole workspace
    // lifecycle — the credential mint, the clone, and every failure of either — shifts to realize()'s
    // populate path, which re-throws a named failure and reaps its own realization directory. When NOT
    // suppressed (no room, no repository named, or no realizer to build the room) the Booker's clone
    // and its error paths are byte-identical to before this guard existed.
    const roomWillPopulate = Boolean(claim.venue && claim.repo_url && deps.venueRealizer);
    if (!roomWillPopulate) {
      workspace = await prepareWorkspace({
        repoUrl: claim.repo_url,
        gigId: claim.gig_id,
        drainKey: ctx.drainKey,
        instance: ctx.instance,
        endpoint: process.env["COLTRANE_GIT_CREDENTIALS_URL"],
      });
      if (workspace) {
        process.chdir(workspace.dir);
        log(`working tree ready: ${claim.repo_url}`);
      }
    } else {
      log(`working tree deferred to room realization for venue "${claim.venue}" (${claim.repo_url})`);
    }

    const genome = await rpcGenomeStore(ctx).load();
    const standard = genome.standards.get(claim.standard_slug);
    if (!standard) {
      throw new Error(
        `claimed standard "${claim.standard_slug}" is not in the org genome this token can read` +
        (genome.load_errors.length ? ` (${genome.load_errors.length} load error(s) — system_health has them)` : ""),
      );
    }
    const registry = loadRegistry(genome);
    const stateRoot = workerStateRoot();
    // The mirror tier is where OUTPUT drain lives (the header drains from the runtime
    // directly) — without it a worker's sealed outputs never reach the sink. Found live:
    // the first worker run drained its failure header and none of its sealed phases.
    //
    // `persistDir` is the RESUME half of the same concern: the checkpoint names sealed rows by
    // id, and the process that resumes is not the process that sealed them. Without a durable
    // row store every re-claim is refused ("the output store no longer holds") and pays again.
    const outputs = createOutputStore(registry, {
      persistDir: stateRoot,
      mirror: createOutputMirror(join(tmpdir(), "coltrane-worker-mirror")),
    });
    const ledger = new MemoryLedger();
    const invoke = deps.makeInvoke(registry, genome);
    const checkpoints = createCheckpointStore(stateRoot);
    // ORDER OF PREFERENCE: the local checkpoint (fast path — same box, nothing to fetch), then
    // the DRAIN reconstruction (a different box, or a state root that was cleared), then cold.
    // Exactly one line is logged for whichever path is taken, including the reason for cold.
    let checkpoint: GigCheckpoint | undefined;
    let resumeSource: "local" | "drain" = "local";
    let coldReason = "no local checkpoint and no drain to rebuild one from";
    try {
      checkpoint = checkpoints.read(claim.gig_id);
    } catch (e) {
      // A damaged checkpoint is not a reason to fail a runnable row — it is a reason to pay for
      // a cold run, and to say so.
      log(`checkpoint for ${claim.gig_id} unreadable, running cold: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!checkpoint) {
      const rebuilt = await rebuildFromDrain(ctx, claim, standard, outputs);
      if (rebuilt.ok) {
        // Written to the LOCAL store because that is where the runtime's resume gate reads a
        // checkpoint from. The reconstruction seeds that gate; the gate remains the authority —
        // it re-resolves every output id, re-checks every content_sha and type fingerprint, and
        // compares the identity itself, so a bad reconstruction is refused by the same code a
        // bad local checkpoint is.
        checkpoints.write(rebuilt.checkpoint);
        checkpoint = rebuilt.checkpoint;
        resumeSource = "drain";
      } else {
        coldReason = rebuilt.reason;
      }
    }
    const human = approvalWiring(claim.approvals, standard, checkpoint?.roles.map((r) => r.role) ?? []);

    // ENFORCEMENT PARITY WITH THE SERVER PATH. These four were absent, and every absence turned a
    // control OFF for the one path that runs queued work with nobody watching: no spend ceiling, no
    // grant resolution (so a dead tool name reached the spawn instead of failing closed), and no way
    // to stop a run. tests/run_deps_parity pins them so the two call sites cannot drift again.
    //
    // mcpServerConfigs is EMPTY, deliberately, and is not read from the working tree: the drain's
    // cwd is a freshly cloned repository, so honouring a `.mcp.json` there would let a repo declare
    // servers for the seat reading it. Present enables resolution; empty makes any grant naming a
    // server other than the engine's own fail closed.
    const aborter = new AbortController();
    deadline = setTimeout(() => aborter.abort(), drainTimeoutMs());
    // unref so a finished gig exits promptly instead of waiting out its own timeout.
    if (typeof deadline === "object" && "unref" in deadline) deadline.unref();

    // ── THE ROOM THE GIG NAMED, carried into the run (SITE 2 — the drain half of the venue wire) ──
    // `venueMayClaim` already gated the CLAIM on this room being one this box can stand up
    // (claimNextGig); threading it into runGig is the OTHER half of that coherence — a box that
    // claimed a gig BECAUSE it declared the room must actually stand the room up, not run the gig
    // venue-less. Before this, workOnce passed ZERO venue fields, so a worker refused work for rooms
    // it could not build and then built no room for the ones it could: the targeting layer was fully
    // implemented and the thing it targeted for was never connected.
    //
    // Fail-closed is the only permitted alternative to realization. A venue-less claim is the open
    // room, wholly unchanged. A DEAD room name fails closed inside runGig (resolveAndRealize refuses
    // an unknown venue) and is recorded as a failed gig by the catch below. And a room that declares
    // mcp_servers this worker has no realizer to stand up is refused HERE rather than run with its
    // servers unbuilt — gating on a room and then not building it is the defect. What must never
    // happen is proceeding as if no venue was asked: that is exactly what gig a77f6f7f did on the
    // server path, and the production drain path must not repeat it.
    const gigVenue = claim.venue ? genome.venues.get(claim.venue) : undefined;
    if (claim.venue && gigVenue && gigVenue.mcp_servers.length > 0 && !deps.venueRealizer) {
      throw new Error(
        `claimed gig ${claim.gig_id} names venue "${claim.venue}", whose declared mcp_servers need a ` +
          `realizer this worker was not given — refusing rather than running the room unbuilt`,
      );
    }
    // The repository is carried on the claim (claim.repo_url — the STORE's governed column), and is
    // mapped into the run the SAME conditional-spread way the venue fields are, so runGig realizes the
    // room WITH a repository to populate its tree from. Present only alongside a venue, because the
    // repository populates a ROOM's workspace; a venue-less claim keeps the Booker's own clone above.
    const venueWiring = claim.venue
      ? {
          venue: claim.venue,
          venues: genome.venues,
          ...(deps.venueRealizer ? { venueRealizer: deps.venueRealizer } : {}),
          ...(claim.repo_url ? { repoUrl: claim.repo_url } : {}),
        }
      : {};

    const run = (resume: boolean): ReturnType<typeof runGig> => runGig(standard, claim.input, {
      outputs,
      ledger,
      invoke,
      gig_id: claim.gig_id, // ← the run IS the queue row; the drained header completes it
      ...venueWiring,
      skills: genome.skills,
      budget: drainBudget(claim.input),
      toolProviders: engineToolProviders(),
      mcpServerConfigs: {},
      signal: aborter.signal,
      // Which model actually ran, so a drained gig's record is as complete as a dispatched one's.
      // Passed unconditionally, as the server does: undefined is a truthful "not configured", and a
      // conditional spread would make the wire invisible to anything reading the call site.
      model_version: process.env["COLTRANE_MODEL"],
      evals: genome.evals,
      // EMPTY, and explicitly so rather than by omission. Store-loaded skills carry no local package
      // dir by construction — there is no code half to point at — so a skill-BACKED chair fails at
      // prep with the runtime's own "no skill_dir is registered" error. That was already true when
      // this was absent; declaring it says the drain HAS no local dirs, instead of leaving a reader
      // to infer whether the wire was considered. An absence and an empty map behave identically
      // here; only one of them is a statement.
      skill_dirs: new Map<string, string>(),
      // Store-loaded skills carry no local package dir (no code half) by construction, so
      // no skill_dirs: a skill-BACKED chair in a store standard fails precisely at prep
      // with the runtime's own "no skill_dir is registered" error, not a confabulated run.
      checkpoints,
      ...(resume ? { resume_from: claim.gig_id } : {}),
      ...human,
    });
    let res;
    if (checkpoint) {
      // An approved re-claim is the common case for this branch: the chairs before the human
      // seat already sealed and were already paid for, so replaying them is money spent twice.
      log(
        `resuming ${claim.gig_id} from its ${resumeSource === "drain" ? "DRAIN-reconstructed" : "local"} ` +
        `checkpoint (${checkpoint.roles.length} chair(s) recorded)`,
      );
      try {
        res = await run(true);
      } catch (e) {
        if (!(e instanceof ResumeRefused)) throw e;
        // A refusal is the engine declining to splice two runs together (the genome, the
        // payload or a type moved). The queue row is still work that must happen, so it is run
        // COLD and the second payment is stated rather than hidden.
        log(`resume refused for ${claim.gig_id} — running it COLD: ${e.message}`);
        res = await run(false);
      }
    } else {
      log(`running ${claim.gig_id} COLD — ${coldReason}`);
      res = await run(false);
    }

    if (res.status === "awaiting_approval") {
      const awaiting = res.awaiting;
      log(
        `gig ${claim.gig_id} awaiting approval` +
        (awaiting ? ` at human chair "${awaiting.role}" (phase "${awaiting.phase}")` : "") +
        ` — ${res.outputs.length} sealed output(s)`,
      );
      try {
        const released = await parkGig(ctx, claim.gig_id);
        if (!released) {
          log(`park not recorded for ${claim.gig_id} (coltrane_mcp_gig_park absent or the row moved) — the drained header carries awaiting_approval`);
        }
      } catch (pe) {
        // Same posture as an unrecordable failure: say it, and let the lease expire.
        log(`could not park ${claim.gig_id} (lease will expire): ${pe instanceof Error ? pe.message : String(pe)}`);
      }
      return {
        claimed: true, gig_id: claim.gig_id, status: "awaiting_approval",
        outputs_count: res.outputs.length,
        ...(awaiting ? { awaiting } : {}),
      };
    }
    log(`gig ${claim.gig_id} ${res.status} — ${res.outputs.length} sealed output(s)`);
    return { claimed: true, gig_id: claim.gig_id, status: "complete", outputs_count: res.outputs.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`gig ${claim.gig_id} failed: ${message}`);
    try {
      await failGig(ctx, claim.gig_id, message);
    } catch (fe) {
      // The failure could not even be recorded — surface both; the lease will expire.
      log(`could not record failure (lease will expire): ${fe instanceof Error ? fe.message : String(fe)}`);
    }
    return { claimed: true, gig_id: claim.gig_id, status: "failed", error: message };
  } finally {
    // Restored BEFORE the temp directory is removed: deleting the directory a process is standing
    // in leaves it with an invalid cwd, and every later relative path resolves from nowhere.
    try {
      process.chdir(cwdBefore);
    } catch { /* the original cwd is gone; nothing useful left to do about it here */ }
    if (deadline) clearTimeout(deadline);
    workspace?.cleanup();
    // Hand the git credential back. GitHub fixes installation tokens at an hour and the lease that
    // justified this one is thirty minutes, so a finished gig otherwise leaves a live credential
    // behind for the remainder. Not a security control — a compromised drain declines to call it —
    // but in the ordinary case a four-minute run stops holding one fifty-six minutes early.
    // Deliberately not awaited: the gig is drained and its result must not wait on GitHub.
    void workspace?.revoke();

    // In venue mode the credential arrived WITH the work and must not outlive it.
    //
    // Without this, "a drain between gigs holds nothing that opens a door" is a property of the
    // CALLER's shape rather than of this function: workOnce is one-shot today and the drain loop
    // re-execs, so the token dies with the process by accident. If workOnce ever loops internally —
    // an obvious optimisation, since the claim → run → drain cycle above it already IS a loop — that
    // accident stops holding silently, and nothing here would notice.
    //
    // AFTER the catch, deliberately: failGig still speaks through this token.
    if (ctx.drainKey) ctx.agentToken = "";
  }
}
