// Document Factory — the 5-layer contract, as a coltrane-oss module (the genome-
// integrated build, after the Python form-proof validated the form).
// Principle: the document is a trajectory, not a string. Three deterministic
// transforms hold structure rigid; two bounded-inference layers compose. The
// InferenceRequest contract is a pure typed lambda — the proposer/checker split:
// the model proposes a typed object, the deterministic side validates it (reject +
// retry on miss). No call carries the whole document except the final smoothing.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extractJson } from "./claude_invoker.js";

// ---- the formal contract (governs every inference call) ----

export interface InferenceRequest {
  dataset: Record<string, unknown>; // the ONLY context the model sees
  instruction: string; // imperative — what to compose
  response_type: ResponseShape; // the exact shape it must return
  constraints: readonly string[]; // hard prohibitions (governing rules)
}
// A light structural contract for v0 (full build wires registry.validate / ajv).
export interface ResponseShape {
  fields: Record<string, "string" | "number" | "boolean">;
  maxLength?: Record<string, number>; // per-field length caps
}
export type InferenceResponse = Record<string, unknown>;
// An inferer is a pure function: bounded request → typed object. Injectable so the
// factory tests deterministically (mock) and runs in prod (claude -p). Stateless.
export type Inferer = (req: InferenceRequest) => InferenceResponse;

export class FactoryError extends Error {}

/** Validate a response against its shape. Returns null if ok, else the reason. */
export function checkShape(resp: InferenceResponse, shape: ResponseShape): string | null {
  for (const [k, t] of Object.entries(shape.fields)) {
    if (!(k in resp)) return `missing field "${k}"`;
    if (typeof resp[k] !== t) return `field "${k}" must be ${t}, got ${typeof resp[k]}`;
    const cap = shape.maxLength?.[k];
    if (cap !== undefined && typeof resp[k] === "string" && (resp[k] as string).length > cap) {
      return `field "${k}" exceeds maxLength ${cap}`;
    }
  }
  return null;
}

/** Run one inference call under the contract: validate the typed return; on a miss,
 *  retry ONCE with the error fed back into constraints; then fail loud. Never
 *  silently passes a non-conforming response (the T3 discipline). */
export function runInference(req: InferenceRequest, infer: Inferer): InferenceResponse {
  const first = infer(req);
  const err = checkShape(first, req.response_type);
  if (!err) return first;
  const retry = infer({ ...req, constraints: [...req.constraints, `previous response violated: ${err} — fix it`] });
  const err2 = checkShape(retry, req.response_type);
  if (!err2) return retry;
  throw new FactoryError(`inference response failed contract twice: ${err2}`);
}

// ---- the real inferer: bounded request → claude -p → typed object ----

/** Build the prompt for one inference call. PURE — same request, same prompt.
 *  The dataset is the ONLY material; constraints are hard prohibitions; the
 *  response shape is stated as the exact JSON contract the model must return. */
export function buildInfererPrompt(req: InferenceRequest): string {
  const fields = Object.entries(req.response_type.fields)
    .map(([k, t]) => {
      const cap = req.response_type.maxLength?.[k];
      return `  - "${k}": ${t}${cap !== undefined ? ` (max ${cap} characters)` : ""}`;
    })
    .join("\n");
  const constraints = req.constraints.length
    ? req.constraints.map((c) => `- ${c}`).join("\n")
    : "- (none)";
  return [
    `# Instruction\n${req.instruction}`,
    `# Material (the ONLY source — introduce nothing beyond it)\n${JSON.stringify(req.dataset, null, 2)}`,
    `# Hard constraints\n${constraints}`,
    `# Required response\nReturn ONLY a single JSON object with exactly these fields:\n${fields}\nNo prose, no markdown, no code fence — just the JSON object.`,
  ].join("\n\n");
}

export interface ClaudeInfererOptions {
  bin?: string | undefined; // default "claude"
  model?: string | undefined; // passed to --model if set
  run?: ((bin: string, args: string[]) => string) | undefined; // injectable spawn (tests)
}

/** The production Inferer. Spawns `claude -p <prompt>` and parses the JSON it
 *  returns (reusing extractJson — tolerant of fences/prose). The CLI spawn is the
 *  one non-deterministic seam; inject `run` to test the prompt-build + parse path. */
export function makeClaudeInferer(opts: ClaudeInfererOptions = {}): Inferer {
  const bin = opts.bin ?? "claude";
  const run =
    opts.run ?? ((b: string, args: string[]) => execFileSync(b, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
  return (req) => {
    const args = ["-p", buildInfererPrompt(req)];
    if (opts.model) args.push("--model", opts.model);
    return extractJson(run(bin, args));
  };
}

// ---- the document types ----

export type Fact = string;
export interface IntentProfile {
  doc_type: string;
  classification: string; // e.g. "internal" | "external"
  supplied_context: Record<string, Fact[]>; // section-id → facts
}
export interface Skeleton {
  sections: string[]; // ordered section ids
  density_targets: Record<string, number>; // section-id → target length
}
export interface Slot {
  id: string;
  facts: Fact[];
  constraints: readonly string[];
  response_type: ResponseShape;
  target_length: number;
}
export interface Phrasing { slot_id: string; text: string; }
export interface CoherentDraft { audience: string; doc_type: string; body: string; }

export const GOVERNING_RULES: readonly string[] = [
  "Use only the facts in the dataset. Introduce nothing beyond them.",
  "No hedging, no filler, no invented specifics.",
];

// A schema-pack is genome data: doc_type → ordered section topology + per-section
// density targets. This is Layer 0→1's ruleset — the "sheet music" the factory
// transposes intent onto. Authored once in eir_document_schemas.json, loaded by
// loadSchemaPack; the const below is only the zero-file bootstrap default.
export interface DocSchema {
  sections: string[]; // ordered section ids
  density_targets?: Record<string, number>; // section-id → target length
}
export type SchemaPack = Record<string, DocSchema>;

export const SCHEMA_PACK: SchemaPack = {
  internal_update: { sections: ["summary", "what_we_built", "where_it_is", "next", "open_decisions"] },
  deal_brief: { sections: ["short_version", "what_we_heard", "what_phase1_builds", "roadmap", "commercial_terms", "next_steps"] },
  default: { sections: ["summary", "body", "next"] },
};

/** Load a schema-pack from a genome JSON file (eir_document_schemas.json). Validates
 *  each entry has a non-empty sections[] and a "default" exists — fails loud, so a
 *  malformed genome can never silently degrade to the bootstrap pack. */
export function loadSchemaPack(path: string): SchemaPack {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  if (!raw["default"]) throw new FactoryError(`schema pack ${path} has no "default" doc_type`);
  const pack: SchemaPack = {};
  for (const [doc_type, v] of Object.entries(raw)) {
    const entry = v as DocSchema;
    if (!Array.isArray(entry.sections) || entry.sections.length === 0) {
      throw new FactoryError(`schema pack ${path}: doc_type "${doc_type}" has no sections`);
    }
    pack[doc_type] = entry.density_targets
      ? { sections: entry.sections, density_targets: entry.density_targets }
      : { sections: entry.sections };
  }
  return pack;
}

// ---- Layer 0→1 — Intent → Shape · DETERMINISTIC ----
export function selectSkeleton(intent: IntentProfile, pack: SchemaPack = SCHEMA_PACK): Skeleton {
  const schema = pack[intent.doc_type] ?? pack["default"]!;
  const density_targets: Record<string, number> = {};
  for (const s of schema.sections) density_targets[s] = schema.density_targets?.[s] ?? 600;
  return { sections: schema.sections, density_targets };
}

// ---- Layer 1→2 — Shape → Slots · DETERMINISTIC (the narrative-kill rule) ----
export function bindSlots(skeleton: Skeleton, intent: IntentProfile): Slot[] {
  const slots: Slot[] = [];
  for (const id of skeleton.sections) {
    const facts = intent.supplied_context[id] ?? [];
    if (facts.length === 0) continue; // NO fact → NO slot → no invented content
    slots.push({
      id, facts, constraints: GOVERNING_RULES,
      response_type: { fields: { text: "string" }, maxLength: { text: skeleton.density_targets[id] ?? 600 } },
      target_length: skeleton.density_targets[id] ?? 600,
    });
  }
  return slots;
}

// ---- Layer 2→3 — Slots → Phrasings · INFERENCE (independent, parallel, cheap) ----
// Each call sees ONLY its slot's facts — never the document, never sibling slots.
export function composePhrasings(slots: readonly Slot[], infer: Inferer): Phrasing[] {
  return slots.map((slot) => {
    const resp = runInference(
      { dataset: { facts: slot.facts }, instruction: "Compose this section from its facts alone. No content beyond the facts.", response_type: slot.response_type, constraints: slot.constraints },
      infer,
    );
    return { slot_id: slot.id, text: String(resp["text"]) };
  });
}

// ---- Layer 3→4 — Phrasings → Coherence · INFERENCE (single, global, adds nothing) ----
export function smoothCoherence(phrasings: readonly Phrasing[], intent: IntentProfile, infer: Inferer): CoherentDraft {
  const ordered = phrasings.map((p) => p.text).join("\n\n");
  const resp = runInference(
    {
      dataset: { ordered_phrasings: ordered },
      instruction: "Join these sections into one voice. Fix transitions and repetition. Add nothing.",
      response_type: { fields: { text: "string" } },
      constraints: [...GOVERNING_RULES, "introduce no new facts"],
    },
    infer,
  );
  return { audience: intent.classification, doc_type: intent.doc_type, body: String(resp["text"]) };
}

// ---- Layer 4→5 — Coherence → Substrate · DETERMINISTIC (branded render) ----
export function render(draft: CoherentDraft): string {
  const header = draft.audience === "external"
    ? `# ${draft.doc_type}\n\n*Eir Is Real, Inc.*\n\n`
    : `# ${draft.doc_type} (internal)\n\n`;
  return header + draft.body + "\n";
}

// ---- the full factory: intent → rendered artifact ----
export interface FactoryResult { skeleton: Skeleton; slots: Slot[]; dropped: string[]; phrasings: Phrasing[]; artifact: string; }
export function runFactory(intent: IntentProfile, infer: Inferer, pack: SchemaPack = SCHEMA_PACK): FactoryResult {
  const skeleton = selectSkeleton(intent, pack);
  const slots = bindSlots(skeleton, intent);
  const kept = new Set(slots.map((s) => s.id));
  const dropped = skeleton.sections.filter((s) => !kept.has(s)); // narrative-kill record
  const phrasings = composePhrasings(slots, infer);
  const draft = smoothCoherence(phrasings, intent, infer);
  return { skeleton, slots, dropped, phrasings, artifact: render(draft) };
}
