// A runnable Coltrane gig with zero external infrastructure: no database, no API key,
// no network. A deterministic invoker stands in for the Claude subprocess, so the whole
// pipeline runs offline. To run live agents instead, swap `invoke` for the real Claude
// invoker (src/claude_invoker.ts) and set ANTHROPIC_API_KEY.
//
//   npx tsx examples/hello_band/run.ts
import { fileURLToPath } from "node:url";
import { createRegistry } from "../../src/registry.js";
import { createOutputStore } from "../../src/outputs.js";
import { MemoryLedger } from "../../src/ledger.js";
import { defineAgent, composeStandard } from "../../src/composition.js";
import { runGig, type AgentInvoker, type GigResult } from "../../src/runtime.js";

export function runHelloBand(): Promise<GigResult> {
  // 1. genome — register two domain types as DATA. No source-file change to add a type.
  const registry = createRegistry();
  registry.registerType({
    slug: "raw-note",
    extends: "Signal",
    domain: "demo",
    schema: { type: "object", properties: { text: { type: "string" } } },
    required_fields: ["text"],
  });
  registry.registerType({
    slug: "summary",
    extends: "Interpretation",
    domain: "demo",
    schema: { type: "object", properties: { gist: { type: "string" } } },
    required_fields: ["gist"],
  });

  // 2. agents — a SENSE agent feeds an INTERPRET agent.
  const sensor = defineAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
  const summarizer = defineAgent({
    slug: "summarizer",
    primitives: ["INTERPRET"],
    input_types: ["raw-note"],
    output_types: ["summary"],
    domain: "demo",
  });

  // 3. standard — two ordered phases.
  const standard = composeStandard({
    slug: "summarize",
    domain: "demo",
    agents: [sensor, summarizer],
    phases: [
      { name: "sense", agent: "sensor" },
      { name: "interpret", agent: "summarizer" },
    ],
  });

  // 4. the one non-deterministic seam, made deterministic for this demo.
  const invoke: AgentInvoker = (ctx) =>
    ctx.agent.slug === "sensor" ? { text: "the room is loud" } : { gist: "loud room" };

  // 5. run the gig — each output is typed, validated, stored, and provenance-linked.
  return runGig(
    standard,
    { topic: "noise" },
    { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, model_version: "deterministic-example" },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runHelloBand().then((result) => {
    console.log(
      JSON.stringify(
        { status: result.status, gig_id: result.gig_id, outputs: result.outputs.map((o) => ({ domain_type: o.domain_type, data: o.data })) },
        null,
        2,
      ),
    );
  });
}
