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
import { runGig, type AgentInvoker } from "./runtime.js";
import { loadRegistry, type Registry } from "./registry.js";
import { createOutputStore } from "./outputs.js";
import { MemoryLedger } from "./ledger.js";
import { rpcGenomeStore } from "./genome_store.js";
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
}

export type WorkOnceResult =
  | { claimed: false }
  | { claimed: true; gig_id: string; status: "complete" | "failed"; outputs_count?: number; error?: string };

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

/** Record a failed run on the claimed row. True iff the store recorded it (row was running). */
export async function failGig(ctx: WorkerContext, gig_id: string, error: string): Promise<boolean> {
  const out = await workerRpc(ctx, "coltrane_mcp_gig_fail", {
    p_bearer: ctx.agentToken,
    p_gig: gig_id,
    p_error: error,
  });
  return out === true;
}

/** One unit of work: claim → load the org genome (as the agent) → run under the claimed
 *  gig's id → results drain via the org drain key (engine drain layer, env-configured), or
 *  the failure is recorded. Never throws for a run failure — a thrown claim/store error
 *  means the worker itself could not speak to the store. */
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
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const invoke = deps.makeInvoke(registry, genome);
    const res = await runGig(standard, claim.input, {
      outputs,
      ledger,
      invoke,
      gig_id: claim.gig_id, // ← the run IS the queue row; the drained header completes it
      skills: genome.skills,
      // Store-loaded skills carry no local package dir (no code half) by construction, so
      // no skill_dirs: a skill-BACKED chair in a store standard fails precisely at prep
      // with the runtime's own "no skill_dir is registered" error, not a confabulated run.
    });
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
