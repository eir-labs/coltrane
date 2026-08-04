import type { Depth, ModelTier } from "./pricing.js";
import { DEPTH_MULTIPLIER, MODEL_MULTIPLIER } from "./pricing.js";

/** The structural facts a simulation needs about the standard it is simulating. A projection,
 *  not the Standard itself, so this module stays free of the composition layer. */
export interface SimulatedStandardShape {
  slug: string;
  phases: readonly { name: string; chairs: number }[];
}

export interface SimulateQuery {
  standard_slug: string;
  mock_input: Record<string, unknown>;
  depth: Depth;
  model_tier?: ModelTier;
  agent_count?: number;
  base_cost_usd?: number;
  base_duration_ms?: number;
  /**
   * #239 — the standard being simulated. Without it `standardSimulate` received only a SLUG,
   * so it could not read the thing it was estimating: the 6-phase submission-convergence came
   * back as three invented phases named sense/process/deliver. The caller reads it out of the
   * genome and passes it here.
   */
  standard?: SimulatedStandardShape | undefined;
  /**
   * Settled per-run costs (USD) previously observed for this standard, from the ledger's gig
   * rows (#195). When present these ARE the estimate — a measured mean beats any formula.
   */
  observed_costs_usd?: readonly number[] | undefined;
}

export interface SimulatedPhase {
  name: string;
  /** How many chairs this phase dispatches. 0 when the standard could not be read. */
  chairs: number;
  estimated_cost: number;
  estimated_duration_ms: number;
}

/**
 * Where the number came from. The pre-spend check CLAUDE.md tells operators to run before
 * dispatching has to say which of these it is, or a guess reads like a reading:
 *   observed   — mean of real settled runs of this standard, depth-adjusted
 *   structural — derived from this standard's real phases + chair count
 *   fallback   — no standard resolvable; a per-slug default, i.e. a guess
 */
export type SimulationBasis = "observed" | "structural" | "fallback";

export interface SimulationResult {
  phases: readonly SimulatedPhase[];
  estimated_cost: number;
  estimated_duration_ms: number;
  basis: SimulationBasis;
  /** How many real runs the `observed` estimate averaged. 0 for the other bases. */
  sample_size: number;
}

// Retained ONLY as the no-standard fallback (see SimulationBasis.fallback). These are the
// original hardcoded lookups; they are no longer the primary path, and a result computed from
// them is labelled `fallback` so no caller mistakes one for a reading of their pipeline.
const KNOWN_BASE_COST: Record<string, number> = {
  "readiness-scan": 0.95,
  "bug-fix": 1.0,
  "feature-build": 12.0,
};

const KNOWN_PHASES: Record<string, string[]> = {
  "readiness-scan": ["sense", "interpret", "report"],
};

/** Structural per-chair cost, USD, at depth=standard/tier=standard. A documented constant,
 *  not a measurement — which is why a structural estimate is labelled `structural`. */
export const PER_CHAIR_BASE_COST_USD = 0.6;
/** Structural per-chair wall clock, ms, at depth=standard. Same caveat. */
export const PER_CHAIR_BASE_DURATION_MS = 30_000;

export function standardSimulate(q: SimulateQuery): SimulationResult {
  const tier = q.model_tier ?? "standard";
  const depthMult = DEPTH_MULTIPLIER[q.depth];
  const tierMult = MODEL_MULTIPLIER[tier];

  // Phase shape: the standard's own phases when we can read it, the per-slug fallback otherwise.
  const phaseShapes: { name: string; chairs: number }[] = q.standard
    ? q.standard.phases.map((p) => ({ name: p.name, chairs: p.chairs }))
    : (KNOWN_PHASES[q.standard_slug] ?? ["sense", "process", "deliver"]).map((name) => ({ name, chairs: 0 }));

  const chairTotal = phaseShapes.reduce((s, p) => s + p.chairs, 0);

  // Cost. Observed history wins; then the standard's real size; then the per-slug default.
  const observed = (q.observed_costs_usd ?? []).filter((n) => Number.isFinite(n) && n > 0);
  let basis: SimulationBasis;
  let baseCost: number;
  if (q.base_cost_usd !== undefined) {
    // An explicit caller-supplied base is honoured, and honestly labelled by what it describes.
    basis = q.standard ? "structural" : "fallback";
    baseCost = q.base_cost_usd;
  } else if (observed.length > 0) {
    basis = "observed";
    // Observed runs are already depth-and-tier-inclusive of whatever depth they RAN at; we have
    // no per-run depth on the ledger, so normalise to depth=standard and let the multipliers
    // re-apply. Honest about being an approximation — it is still a measurement of this pipeline.
    baseCost = observed.reduce((s, n) => s + n, 0) / observed.length;
  } else if (q.standard) {
    basis = "structural";
    baseCost = Math.max(chairTotal, 1) * PER_CHAIR_BASE_COST_USD;
  } else {
    basis = "fallback";
    baseCost = KNOWN_BASE_COST[q.standard_slug] ?? 1.0;
  }

  const baseDuration = q.base_duration_ms
    ?? (q.standard ? Math.max(phaseShapes.length, 1) * PER_CHAIR_BASE_DURATION_MS : 30_000);

  const totalCost = baseCost * depthMult * tierMult;
  const totalDuration = baseDuration * depthMult;
  const n = Math.max(phaseShapes.length, 1);

  // Spread cost by chair count when we know it (a 3-chair phase costs more than a 1-chair one);
  // evenly when we don't.
  const phases: SimulatedPhase[] = phaseShapes.map((p) => ({
    name: p.name,
    chairs: p.chairs,
    estimated_cost: chairTotal > 0 ? (totalCost * p.chairs) / chairTotal : totalCost / n,
    estimated_duration_ms: totalDuration / n,
  }));

  return {
    phases,
    estimated_cost: totalCost,
    estimated_duration_ms: totalDuration,
    basis,
    sample_size: basis === "observed" ? observed.length : 0,
  };
}
