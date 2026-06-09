// The six canonical, immutable core types (v2 spec §2). The engine OWNS these —
// they are universal substrate, identical in every genome, never consumer-authored.
//
// loadGenome seeds these when a genome root has no core_types/ of its own, so a
// downstream consumer never has to hand-copy immutable engine substrate just to
// boot (the first slice of genome extension — see docs/genome-extension.md).
//
// These values MUST stay byte-for-value identical to core_types/*.json — a drift
// guard test (tests/canonical_core_types.test.ts) fails the build if they diverge,
// so the same content hashes whether it was sourced from disk or from this constant.
import type { CoreTypeRecord } from "./loader.js";

export const CANONICAL_CORE_TYPES: readonly CoreTypeRecord[] = [
  {
    slug: "Signal",
    primitive: "SENSE",
    description: "Raw acquired data from a source",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        source: { type: "string" },
        data: { type: "object" },
        completeness: { type: "number" },
        acquisition_cost: { type: "number" },
      },
      required: ["id", "source", "data", "completeness", "acquisition_cost"],
    },
  },
  {
    slug: "Interpretation",
    primitive: "INTERPRET",
    description: "Meaning extracted from signals",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        input_refs: { type: "array", items: { type: "string" } },
        frame: { type: "string" },
        claims: { type: "array" },
        confidence: { type: "number" },
      },
      required: ["id", "input_refs", "frame", "claims", "confidence"],
    },
  },
  {
    slug: "Judgment",
    primitive: "JUDGE",
    description: "Evaluation against criteria",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        input_refs: { type: "array", items: { type: "string" } },
        criteria: { type: "array" },
        verdicts: { type: "array" },
        reasoning_chain: { type: "array" },
      },
      required: ["id", "input_refs", "criteria", "verdicts", "reasoning_chain"],
    },
  },
  {
    slug: "Plan",
    primitive: "PLAN",
    description: "Sequenced actions with dependencies",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        input_refs: { type: "array", items: { type: "string" } },
        objective: { type: "string" },
        steps: { type: "array" },
        budget: { type: "number" },
      },
      required: ["id", "input_refs", "objective", "steps", "budget"],
    },
  },
  {
    slug: "Artifact",
    primitive: "CREATE",
    description: "Novel created thing",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        input_refs: { type: "array", items: { type: "string" } },
        artifact_type: { type: "string" },
        format: { type: "string" },
        content: {},
        validation_criteria: { type: "array", minItems: 1 },
      },
      required: ["id", "input_refs", "artifact_type", "format", "content", "validation_criteria"],
    },
  },
  {
    slug: "Verdict",
    primitive: "VERIFY",
    description: "Pass/fail with evidence",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        target_ref: { type: "string" },
        pass: { type: "boolean" },
        checks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              method: { type: "string" },
              target_ref: { type: "string" },
              result: { type: "string" },
            },
            required: ["method"],
          },
        },
      },
      required: ["id", "target_ref", "pass", "checks"],
    },
  },
];
