/**
 * The per-chair thread tee, extracted so BOTH run paths share one implementation.
 *
 * The tee existed only inside the server's async-dispatch onProgress — so a gig
 * dispatched through the MCP teed its chairs' child streams, and the SAME gig
 * claimed by `coltrane work` (the drain — the path every production gig actually
 * takes) teed nothing. Found on a live box at 0.24.17: COLTRANE_OUTPUTS_DIR set,
 * gig running, no gigs/ dir anywhere. The location of a feature is part of the
 * feature: a tee on the path gigs don't take is a tee that doesn't exist.
 *
 * Pull-on-command stays the contract: this writes append-only files under
 * <base>/gigs/<gig_id>/<role>.jsonl; `gig_logs` (and any box endpoint) READS
 * them on demand. Nothing pushes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface TeeableEvent {
  type: string;
  role?: string;
  event?: unknown;
}

/** An onProgress fragment: tees agent_event lines; ignores everything else. Best-effort by design —
 *  a full disk must not fail a gig; the thread is an observability record, not the work itself. */
export function makeGigLogTee(base: string | undefined, gigId: string): (ev: TeeableEvent) => void {
  if (!base) return () => {};
  const dir = join(base, "gigs", gigId);
  return (ev) => {
    if (ev.type !== "agent_event" || !ev.role) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${ev.role}.jsonl`), JSON.stringify(ev.event) + "\n");
    } catch { /* best-effort */ }
  };
}

/** The base the tee (and gig_logs) share: explicit env first, then the outputs persist dir. */
export function gigLogBaseFromEnv(defaultBase: () => string): string {
  return process.env["COLTRANE_GIG_LOG_BASE"] ?? defaultBase();
}
