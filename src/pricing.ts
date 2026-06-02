export const DEPTH_MULTIPLIER = { skim: 0.5, quick: 0.75, standard: 1.0, deep: 2.0 } as const;
export const MODEL_MULTIPLIER = { economy: 0.5, standard: 1.0, premium: 2.0 } as const;

export type Depth = keyof typeof DEPTH_MULTIPLIER;
export type ModelTier = keyof typeof MODEL_MULTIPLIER;

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
