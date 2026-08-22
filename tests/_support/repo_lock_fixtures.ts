// Shared fixtures for the single-flight repo-lock laws (change c1d0c2e0).
//
// Every law drives the REAL dispatch entry point — `dispatchTool("gig_dispatch", …)` — because
// the in-process gig_dispatch tool and the CLI both funnel through it (cli.ts:404 → call →
// dispatchTool). The lock is a per-repo working-tree lock keyed on `deps.genome_dir`; two deps
// objects that share a `genome_dir` but hold their OWN in-memory maps stand for two independent
// processes dispatching against the SAME tree — which is exactly the corruption the lock forbids.
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../../src/index.js";
import { dispatchTool, type ServerDeps } from "../../src/server.js";
import { testAgent } from "./agents.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The `Signal` core floor a `note` payload owes on top of its own required field. */
export const SIGNAL = { source: "fixture://demo/note" };
/** The `Interpretation` core floor a `reading` payload owes on top of its own required field. */
export const READING = { claims: ["read"] };

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reading: DomainType = { slug: "reading", extends: "Interpretation", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

const soloChair: Chair = { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
/** A one-chair standard: the whole run is a single gated chair, so a gate on its invoker holds the tree. */
export const soloStandard = (): Standard => composeStandard({
  slug: "lock-demo", domain: "demo",
  agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
  phases: [{ name: "sense", chairs: [soloChair] } as PhaseDef],
});

const chairA: Chair = { role: "a", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
const chairB: Chair = { role: "b", agent_slug: "reader2", depends_on: ["a"], input_contract: ["note"], output_contract: ["reading"], required_skills: [] };
/** Two sequential phases — phase 2 exists so a between-phase abort checkpoint has somewhere to land,
 *  the same shape gig_abort_lifecycle uses to force an `aborted` (not `complete`) terminal state. */
export const twoPhaseStandard = (): Standard => composeStandard({
  slug: "lock-demo-2", domain: "demo",
  agents: [
    testAgent({ slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "reader2", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["reading"], domain: "demo" }),
  ],
  phases: [{ name: "sense", chairs: [chairA] } as PhaseDef, { name: "interpret", chairs: [chairB] } as PhaseDef],
});

/** A fresh, empty genome root — a distinct working tree per call. */
export function freshGenomeDir(): string {
  return mkdtempSync(join(tmpdir(), "coltrane-repo-lock-"));
}

/** ServerDeps keyed on a given `genome_dir`, with its own in-memory stores. Two `depsFor` calls
 *  sharing a `genome_dir` model two processes contending for one tree. */
export function depsFor(genome_dir: string, invoke: AgentInvoker, standard = soloStandard()): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(reading);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[standard.slug, standard]]),
    invoke,
    gig_runs: new Map(),
    genome_dir,
  };
}

/** A deferred promise the test opens to release a gated chair. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  return { promise, open };
}

/** An invoker that seals the `note` floor but blocks until `g` opens — holds the tree in flight. */
export const heldInvoke = (g: { promise: Promise<void> }): AgentInvoker => async () => { await g.promise; return { t: "hi", ...SIGNAL }; };
/** An invoker that seals immediately. */
export const fastInvoke: AgentInvoker = async () => ({ t: "hi", ...SIGNAL });

/** Poll gig_monitor until the gig leaves `running`. */
export async function pollSettled(d: ServerDeps, gid: string, ms = 4000): Promise<Record<string, unknown>> {
  return pollUntil(d, gid, (s) => s !== "running", ms);
}

/** Poll gig_monitor until `pred(status)` holds. */
export async function pollUntil(d: ServerDeps, gid: string, pred: (status: string) => boolean, ms = 4000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await dispatchTool("gig_monitor", { gig_id: gid }, d);
    const data = r.data as Record<string, unknown>;
    if (pred(String(data["status"]))) return data;
    if (Date.now() - t0 > ms) throw new Error(`gig ${gid} never satisfied the predicate: ${JSON.stringify(data)}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}
