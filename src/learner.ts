// E5 impl — learner downgrade proposal with 50-gig floor (§8 constraint 10 applied).

import type { ModelTier } from "./pricing.js";

export interface GigObservation {
  gig_id: string;
  agent_slug: string;
  primitive: string;
  model_tier_used: ModelTier;
  success: boolean;
  cost: number;
  duration_ms: number;
}

export interface LearnerProposeDowngradeInput {
  agent_slug: string;
  from_tier: ModelTier;
  to_tier: ModelTier;
  observations: GigObservation[];
  auto_approve_as?: string;
}

export interface DowngradeProposal {
  agent_slug: string;
  from_tier: ModelTier;
  to_tier: ModelTier;
  data_points: number;
  evidence_summary: {
    success_rate: number;
    avg_cost: number;
    avg_duration_ms: number;
  };
  requires_human_approval: boolean;
  auto_approved: boolean;
}

export interface LearnerProposeDowngradeResult {
  ok: boolean;
  violation?: "insufficient_evidence";
  proposal?: DowngradeProposal;
}

const MIN_DATA_POINTS = 50;

export function learnerProposeDowngrade(
  input: LearnerProposeDowngradeInput
): LearnerProposeDowngradeResult {
  const n = input.observations.length;
  if (n < MIN_DATA_POINTS) {
    return { ok: false, violation: "insufficient_evidence" };
  }

  const successCount = input.observations.filter((o) => o.success).length;
  const totalCost = input.observations.reduce((a, o) => a + o.cost, 0);
  const totalDuration = input.observations.reduce((a, o) => a + o.duration_ms, 0);

  // §8 constraint 11: coltrane cannot self-approve
  const approverIsColtrane =
    !!input.auto_approve_as &&
    (input.auto_approve_as === "coltrane" || input.auto_approve_as.startsWith("coltrane:"));

  const proposal: DowngradeProposal = {
    agent_slug: input.agent_slug,
    from_tier: input.from_tier,
    to_tier: input.to_tier,
    data_points: n,
    evidence_summary: {
      success_rate: successCount / n,
      avg_cost: totalCost / n,
      avg_duration_ms: totalDuration / n,
    },
    requires_human_approval: true,
    auto_approved: !approverIsColtrane && !!input.auto_approve_as,
  };

  return { ok: true, proposal };
}

export const learnerProposeDowngradeResult = learnerProposeDowngrade;
