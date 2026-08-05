// The e2e band, minus the specs that need a live `claude` CLI — the half that CAN run in CI.
//
// WHY THIS EXISTS (#262). The whole e2e band executed in no automation: `npm run e2e` was
// invoked by nothing, and test.yml's `e2e-smoke` job was a documented stub that echoed a
// warning and was gated to push-to-main anyway. 36 files ran nowhere. That is the mechanism
// behind e2e regressions being discovered by hand months later — including the 30-second
// relay-restart hang in relay_restart_handshake.spec.ts, a spec that needs no model at all
// and would have gone red on the PR that broke it.
//
// The band can't run whole in CI: most of it spawns the real CLI, which needs an install and
// an API key. But "needs a model" was never expressed anywhere a runner could read, so the
// runnable part was unreachable. This config expresses it.
//
// THE LIST BELOW IS AN EXCLUDE, NOT AN ALLOWLIST — on purpose. A new spec is IN by default.
// If it needs a live model, this job goes red and someone has to add it here deliberately,
// in a diff a reviewer sees. An allowlist would rot the other way: every new deterministic
// spec would silently stay out of CI, which is exactly the failure being fixed.
//
// Nothing here is skipped or weakened. Every excluded spec still runs under
// `npm run e2e`, unchanged. This config only decides what a machine with no `claude`
// binary is able to execute.

import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * Specs that spawn the real `claude` CLI (directly, via tests/e2e/_harness.ts, or through the
 * invoker) and therefore cannot pass on a runner that has no CLI and no API key.
 *
 * Verified empirically, not guessed: the full band was run with `claude` shimmed to a
 * non-zero-exit script, and every file below failed for want of a live model.
 *
 * NOT excluded, deliberately: patent_triage_v1_live.spec.ts and playwright_cage_live.spec.ts
 * already gate themselves on COLTRANE_LIVE, so they collect and report as skipped — which is
 * the behaviour we want visible in CI rather than hidden by an exclude.
 */
export const LIVE_CLAUDE_SPECS = [
  "tests/e2e/chain_query_primitives.spec.ts",
  "tests/e2e/code_change_workflow_live.spec.ts",
  "tests/e2e/coltrane_full_workflow.spec.ts",
  "tests/e2e/coltrane_lifecycle.spec.ts",
  "tests/e2e/coltrane_user_manual.spec.ts",
  "tests/e2e/downstream_agent_live.spec.ts",
  "tests/e2e/downstream_import.spec.ts",
  "tests/e2e/genome_hot_reload.spec.ts",
  "tests/e2e/malformed_genome_load_errors.spec.ts",
  "tests/e2e/mcp_tool_registry_governance.spec.ts",
  "tests/e2e/npm_install_roundtrip.spec.ts",
  "tests/e2e/operator_dispatches_standard.spec.ts",
  "tests/e2e/players_smoke.spec.ts",
  "tests/e2e/recorder_durability_mid_crash.spec.ts",
  "tests/e2e/scaffold/code_template.spec.ts",
  "tests/e2e/scaffold/sprint_portfolio.spec.ts",
  "tests/e2e/schema_validation_edge_cases.spec.ts",
  "tests/e2e/skills_declared_but_not_invoked.spec.ts",
  "tests/e2e/skills_now_fire.spec.ts",
  "tests/e2e/standard_with_cycle.spec.ts",
  "tests/e2e/sub_thread.eng_manager.spec.ts",
  "tests/e2e/sub_thread.platform_team.spec.ts",
  "tests/e2e/sub_thread.research_lab.spec.ts",
  "tests/e2e/sub_thread.solo_dev.spec.ts",
  "tests/e2e/type_fail_at_boundary.spec.ts",
  "tests/e2e/type_fail_boundary.spec.ts",
  "tests/e2e/user_drives_claude_with_coltrane.spec.ts",
  "tests/e2e/user_flow_judge.spec.ts",
];

export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [...LIVE_CLAUDE_SPECS, "node_modules/**", "dist/**"],
    },
  }),
);
