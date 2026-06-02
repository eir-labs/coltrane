// The whole pitch, end to end: clone → the genome FILES are already here → load them →
// run a gig. NOTHING is defined in this file — the types, agents, and standard all come
// from disk (domain_types/ agents/ standards/). This is the difference between
// hello_band (defs written inline in TS) and a real genome-driven run.
//
//   npx tsx examples/run_from_genome/run.ts
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadGenome } from "../../src/loader.js";
import { loadRegistry } from "../../src/registry.js";
import { createOutputStore } from "../../src/outputs.js";
import { MemoryLedger } from "../../src/ledger.js";
import { runGig, type AgentInvoker, type GigResult } from "../../src/runtime.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export function runFromGenome(): Promise<GigResult> {
  // 1. load the genome from FILES — types, agents, and standards all off disk.
  const genome = loadGenome(REPO);
  const registry = loadRegistry(genome); // domain types → a validating registry
  const standard = genome.standards.get("summarize");
  if (!standard) throw new Error("genome is missing the 'summarize' standard — check standards/");

  // 2. the one non-deterministic seam, made deterministic for the demo. (Swap for the
  //    real claude invoker + ANTHROPIC_API_KEY to run live agents.)
  const invoke: AgentInvoker = (ctx) =>
    ctx.agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };

  // 3. run the file-loaded standard. Each output is typed against the file-loaded types,
  //    validated, stored, provenance-linked, and sealed in the ledger.
  return runGig(
    standard,
    { topic: "noise" },
    { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, model_version: "deterministic-example" },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runFromGenome().then((result) => {
    console.log(
      JSON.stringify(
        { loaded_from: "files", status: result.status, gig_id: result.gig_id, outputs: result.outputs.map((o) => ({ domain_type: o.domain_type, data: o.data })) },
        null,
        2,
      ),
    );
  });
}
