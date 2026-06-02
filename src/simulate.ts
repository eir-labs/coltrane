import type { Depth, ModelTier } from "./pricing.js";
import { DEPTH_MULTIPLIER, MODEL_MULTIPLIER } from "./pricing.js";

export interface SimulateQuery {
  standard_slug: string;
  mock_input: Record<string, unknown>;
  depth: Depth;
  model_tier?: ModelTier;
  agent_count?: number;
  base_cost_usd?: number;
  base_duration_ms?: number;
}

export interface SimulatedPhase {
  name: string;
  estimated_cost: number;
  estimated_duration_ms: number;
}

export interface SimulationResult {
  phases: readonly SimulatedPhase[];
  estimated_cost: number;
  estimated_duration_ms: number;
}

const KNOWN_BASE_COST: Record<string, number> = {
  "readiness-scan": 0.95,
  "bug-fix": 1.0,
  "feature-build": 12.0,
};

const KNOWN_PHASES: Record<string, string[]> = {
  "readiness-scan": ["sense", "interpret", "report"],
};

export function standardSimulate(q: SimulateQuery): SimulationResult {
  const tier = q.model_tier ?? "standard";
  const phaseNames = KNOWN_PHASES[q.standard_slug] ?? ["sense", "process", "deliver"];
  const baseCost = q.base_cost_usd ?? KNOWN_BASE_COST[q.standard_slug] ?? 1.0;
  const agentCount = q.agent_count ?? phaseNames.length;
  const baseDuration = q.base_duration_ms ?? 30_000;

  const depthMult = DEPTH_MULTIPLIER[q.depth];
  const tierMult = MODEL_MULTIPLIER[tier];

  const totalCost = baseCost * depthMult * tierMult;
  const perPhaseCost = totalCost / phaseNames.length;
  const totalDuration = baseDuration * depthMult;
  const perPhaseDuration = totalDuration / phaseNames.length;

  const phases: SimulatedPhase[] = phaseNames.map((name) => ({
    name,
    estimated_cost: perPhaseCost,
    estimated_duration_ms: perPhaseDuration,
  }));

  return {
    phases,
    estimated_cost: totalCost + agentCount * 0.0,
    estimated_duration_ms: totalDuration,
  };
}
