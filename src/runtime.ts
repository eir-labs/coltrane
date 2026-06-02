// §13/runtime — the gig executor. Walks a standard's phases, invokes each agent
// (via an INJECTED invoker so the orchestration is testable without spawning Claude),
// writes each typed output to the store (validated), links provenance (derived_from),
// and records one ledger entry with a deterministic genome_hash + a run_fingerprint
// that carries model_version + (empty, v0) eval_scores — honestly un-tempered.
import { randomUUID } from "node:crypto";
import type { Standard, Agent } from "./composition.js";
import { PRIMITIVE_OUTPUT_TYPE } from "./core_types.js";
import { sha256Hex, canonJson, runFingerprint, CANONICAL_FORM_VERSION } from "./canonical_form.js";
import type { OutputStore, OutputRecord } from "./outputs.js";
import type { Ledger } from "./ledger.js";

// What an agent invocation sees. The invoker returns the output `data` (validated
// downstream against the agent's declared output domain type).
export interface AgentInvocationContext {
  agent: Agent;
  phase: string;
  inputs: readonly OutputRecord[]; // upstream outputs matching this agent's input_types
  gig_input: Record<string, unknown>;
}

// The one non-deterministic seam. Inject a deterministic fn in tests; the real
// Claude subprocess call in the stdio entry. The runtime around it is deterministic.
export type AgentInvoker = (
  ctx: AgentInvocationContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface RunDeps {
  outputs: OutputStore;
  ledger: Ledger;
  invoke: AgentInvoker;
  model_version?: string | undefined;
}

export interface GigResult {
  gig_id: string;
  standard_slug: string;
  genome_hash: string;
  run_fingerprint: string;
  outputs: readonly OutputRecord[];
  status: "complete";
}

export class RuntimeError extends Error {}

// Deterministic hash over the definitions a gig touches: the standard + its agents,
// in a canonical (sorted, JCS) form. This is the reproducibility key — same defs,
// same genome_hash, regardless of model or run.
function genomeHash(standard: Standard): string {
  const agents = [...standard.agents]
    .map((a) => ({
      slug: a.slug,
      primitives: a.primitives,
      input_types: a.input_types,
      output_types: a.output_types,
      domain: a.domain,
    }))
    .sort((x, y) => (x.slug < y.slug ? -1 : 1));
  return sha256Hex(
    canonJson({ standard: { slug: standard.slug, domain: standard.domain, phases: standard.phases }, agents }),
  );
}

/**
 * Execute one gig: walk phases in order, each phase's agent consumes the prior
 * outputs that match its input_types, produces a typed output, which is validated
 * + stored + provenance-linked. One immutable ledger entry records the run.
 */
export async function runGig(
  standard: Standard,
  gigInput: Record<string, unknown>,
  deps: RunDeps,
): Promise<GigResult> {
  const gig_id = randomUUID();
  const started_at = new Date().toISOString();
  const produced: OutputRecord[] = [];

  for (const phase of standard.phases) {
    const agent = standard.agents.find((a) => a.slug === phase.agent);
    if (!agent) throw new RuntimeError(`phase "${phase.name}" references unknown agent "${phase.agent}"`);
    const primitive = agent.primitives[0];
    if (!primitive) throw new RuntimeError(`agent "${agent.slug}" declares no primitive`);
    const domain_type = agent.output_types[0];
    if (!domain_type) throw new RuntimeError(`agent "${agent.slug}" declares no output_type`);

    // gather upstream: prior outputs whose domain_type this agent consumes.
    const inputs = produced.filter((o) => agent.input_types.includes(o.domain_type));

    const data = await deps.invoke({ agent, phase: phase.name, inputs, gig_input: gigInput });

    // write the typed output (outputs.write validates data vs the domain schema → throws on bad-schema).
    const rec = deps.outputs.write({
      core_type: PRIMITIVE_OUTPUT_TYPE[primitive],
      domain_type,
      domain: agent.domain ?? standard.domain,
      gig_id,
      agent_slug: agent.slug,
      phase: phase.name,
      primitive,
      data,
      input_refs: inputs.map((i) => i.id),
    });

    // provenance: this output is derived_from each upstream input it consumed.
    for (const i of inputs) deps.outputs.addRef(rec.id, i.id, "derived_from", primitive);
    produced.push(rec);
  }

  const genome_hash = genomeHash(standard);
  const output_hashes = produced.map((p) => p.id);
  const run_fingerprint = runFingerprint({
    genome_hash,
    model_version: deps.model_version ?? "unknown",
    canonical_form_version: CANONICAL_FORM_VERSION,
    eval_scores: {}, // v0 is un-tempered — no behavioral evals yet (the comma is unmeasured)
    output_hashes,
  });

  deps.ledger.append({
    gig_id,
    standard_slug: standard.slug,
    genome_hash,
    run_fingerprint,
    output_hashes,
    started_at,
    finished_at: new Date().toISOString(),
  });

  return { gig_id, standard_slug: standard.slug, genome_hash, run_fingerprint, outputs: produced, status: "complete" };
}
