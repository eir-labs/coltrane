export const DEPTH_MULTIPLIER = { skim: 0.5, quick: 0.75, standard: 1.0, deep: 2.0 } as const;
export const MODEL_MULTIPLIER = { economy: 0.5, standard: 1.0, premium: 2.0 } as const;

export type Depth = keyof typeof DEPTH_MULTIPLIER;
export type ModelTier = keyof typeof MODEL_MULTIPLIER;

// The admissible depth values, derived from the multiplier table so the two cannot drift.
// #237 — `depth` was advertised on gig_dispatch and silently discarded; a dispatch-time depth
// now has to BE one of these or the call fails loudly, because "silently ran at full depth"
// is exactly the failure the parameter existed to prevent.
export const DEPTHS: readonly Depth[] = Object.keys(DEPTH_MULTIPLIER) as Depth[];
export function isDepth(v: unknown): v is Depth {
  return typeof v === "string" && (DEPTHS as readonly string[]).includes(v);
}

export interface CreditInput {
  base_cost: number;
  depth: Depth;
  model_tier: ModelTier;
  agents: number;
  external_tool_calls: number;
}

export function computeCredits(input: CreditInput): number {
  return (
    input.base_cost * DEPTH_MULTIPLIER[input.depth] * MODEL_MULTIPLIER[input.model_tier] +
    input.agents * 0.5 +
    input.external_tool_calls * 0.1
  );
}
