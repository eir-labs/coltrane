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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runGig, ResumeRefused, type AgentInvoker } from "./runtime.js";
import { loadRegistry, type Registry } from "./registry.js";
import { createOutputStore } from "./outputs.js";
import { MemoryLedger } from "./ledger.js";
import { rpcGenomeStore } from "./genome_store.js";
import { createOutputMirror } from "./output_mirror.js";
import { createCheckpointStore, type GigCheckpoint } from "./reuse.js";
import type { Standard } from "./composition.js";
import type { LoadedGenome } from "./loader.js";

/** Where the org store is, and who is working. */
export interface WorkerContext {
  baseUrl: string;
  anonKey: string;
  /** The seated agent's ctk_ capability token — claim/genome/fail all speak through it. */
  agentToken: string;
  /** Lease label recorded on the claimed row (defaults to worker:<acting_for> store-side). */
  worker?: string;
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

/** Atomically claim the oldest runnable gig (queued, or running with an expired lease) the
 *  seated agent's chair contract authorizes. Null means the queue holds nothing for us. */
export async function claimNextGig(ctx: WorkerContext): Promise<ClaimedGig | null> {
  const out = await workerRpc(ctx, "coltrane_mcp_claim", {
    p_bearer: ctx.agentToken,
    p_worker: ctx.worker ?? null,
  });
  return (out as ClaimedGig | null) ?? null;
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
  const claim = await claimNextGig(ctx);
  if (!claim) return { claimed: false };
  log(`claimed ${claim.gig_id} (${claim.standard_slug}, ${claim.mode}) as ${claim.acting_for}`);

  try {
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
    let checkpoint: GigCheckpoint | undefined;
    try {
      checkpoint = checkpoints.read(claim.gig_id);
    } catch (e) {
      // A damaged checkpoint is not a reason to fail a runnable row — it is a reason to pay for
      // a cold run, and to say so.
      log(`checkpoint for ${claim.gig_id} unreadable, running cold: ${e instanceof Error ? e.message : String(e)}`);
    }
    const human = approvalWiring(claim.approvals, standard, checkpoint?.roles.map((r) => r.role) ?? []);
    const run = (resume: boolean): ReturnType<typeof runGig> => runGig(standard, claim.input, {
      outputs,
      ledger,
      invoke,
      gig_id: claim.gig_id, // ← the run IS the queue row; the drained header completes it
      skills: genome.skills,
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
      log(`resuming ${claim.gig_id} from its checkpoint (${checkpoint.roles.length} chair(s) recorded)`);
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
  }
}
