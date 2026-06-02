// Run the Document Factory for real: real intent → real claude -p inference → a
// rendered artifact. Demonstrates the whole 5-layer pipeline producing an actual
// document. Usage: npx tsx examples/run_document_factory.ts > /tmp/out.md
import { join } from "node:path";
import { runFactory, makeClaudeInferer, loadSchemaPack, type IntentProfile } from "../src/document_factory.js";

const intent: IntentProfile = {
  doc_type: "internal_update",
  classification: "internal",
  supplied_context: {
    summary: [
      "coltrane-oss is a clean-room, zero-dependency TypeScript rebuild of the agent-orchestration engine",
      "today: wired the Document Factory to production and shipped it green (444 tests)",
    ],
    what_we_built: [
      "a 5-layer document pipeline: 3 deterministic transposition layers (select skeleton, bind slots, render) and 2 bounded-inference layers (compose each section, smooth coherence)",
      "the narrative-kill rule: a section with no supporting fact is dropped, never filled with invented content",
      "the InferenceRequest contract: the model proposes a typed object, the deterministic side validates it and retries once, then fails loud — it never silently passes a non-conforming response",
      "the real claude inferer: a pure prompt builder plus one injectable spawn seam, so the prompt-build and parse paths are tested deterministically without an API key",
      "the schema-pack as genome data in eir_document_schemas.json, loaded at runtime with per-section density targets, failing loud on a malformed pack",
    ],
    where_it_is: [
      "src/document_factory.ts and tests/document_factory.test.ts, barrel-exported, prereg rows O19 and O20",
      "all 444 tests pass under the real gate: tsc --noEmit plus vitest",
    ],
    next: [
      "point the factory at the RecoveryFAM deal brief and the grant-writing update as its first real documents",
      "wire the schema-pack into the genome registry so doc types are first-class alongside agents and standards",
    ],
    // open_decisions intentionally omitted — narrative-kill will record it as dropped
  },
};

const pack = loadSchemaPack(join(import.meta.dirname, "..", "eir_document_schemas.json"));
const infer = makeClaudeInferer({ model: "claude-haiku-4-5-20251001" });

const result = runFactory(intent, infer, pack);

console.error(`[factory] sections kept: ${result.slots.map((s) => s.id).join(", ")}`);
console.error(`[factory] dropped (narrative-kill): ${result.dropped.join(", ") || "(none)"}`);
console.error(`[factory] inference calls: ${result.phrasings.length} compose + 1 coherence`);
console.log(result.artifact);
