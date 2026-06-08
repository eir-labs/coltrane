// phase-15e: gap-1 — LLM-judge against coltrane standard for user-flow
// behavioral correctness. Real `claude -p` subprocess, no mocks.
//
// Three specs:
//   1. GOLD  — hand-crafted transcript where claude clearly did the right thing.
//              Judge should score >= 4/5 (overall_pass true).
//   2. DRIFT — transcript where claude responded but ignored the user's actual
//              intent. Judge should score <= 2/5 (overall_pass false) and
//              rationale should mention drift.
//   3. REPRO — same transcript scored twice. Criteria list identical; per-criterion
//              scores within +/- 1.0 (the noise band the standard pre-registered).
//
// Honesty contracts:
//   - The REPRO check may legitimately fail if the judge is too noisy. If it
//     does, the test surfaces the variance honestly and recommends temperature=0
//     (or an equivalent determinism fix) — it does NOT silently widen the bound.
//   - The DRIFT case may pass-when-it-shouldn't if the judge is too lenient.
//     The test stays RED; the spec output names the lenience.

import { describe, it, expect } from "vitest";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import {
  scoreUserFlow,
  loadStandard,
  lastRawStdout,
  USER_FLOW_CRITERIA,
  type UserFlowTranscript,
  type SoftJudgeStandard,
  type JudgeVerdict,
} from "../../src/judges/user_flow_judge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

// ───────────────────────────── fixtures ─────────────────────────────

/** A clean, intent-matched user flow. Claude picks the right tool, responds faithfully,
 *  writes a structurally-valid genome, handles a deliberate-malformed turn with a typed
 *  error, and continuity holds across turns. */
const GOLD_TRANSCRIPT: UserFlowTranscript = [
  {
    user_intent: "create a new agent slug 'priority_sorter' that sorts inbox items by urgency, with SENSE primitive and output_type 'sorted-inbox'",
    claude_response: "Created agent slug 'priority_sorter' with primitives=[SENSE] and output_types=[sorted-inbox]. The agent file is written to agents/priority_sorter.json.",
    tool_calls: [
      { tool_name: "agent_define", args: { slug: "priority_sorter", primitives: ["SENSE"], output_types: ["sorted-inbox"] } },
    ],
    post_turn_genome_state: {
      slug: "user_test_genome",
      agents: [
        { slug: "priority_sorter", primitives: ["SENSE"], output_types: ["sorted-inbox"] },
      ],
      standards: [],
      types: [],
    },
  },
  {
    user_intent: "now compose a standard called 'inbox_triage' that uses priority_sorter in a single SENSE phase",
    claude_response: "Composed standard 'inbox_triage' with agent_slugs=['priority_sorter'] and one phase named 'sense' that runs priority_sorter. The agent created in turn 0 is now referenced.",
    tool_calls: [
      { tool_name: "standard_compose", args: { slug: "inbox_triage", agent_slugs: ["priority_sorter"], phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "priority_sorter", depends_on: [], input_contract: [], output_contract: ["sorted-inbox"], required_skills: [] }] }] } },
    ],
    post_turn_genome_state: {
      slug: "user_test_genome",
      agents: [
        { slug: "priority_sorter", primitives: ["SENSE"], output_types: ["sorted-inbox"] },
      ],
      standards: [
        { slug: "inbox_triage", agent_slugs: ["priority_sorter"], phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "priority_sorter", depends_on: [], input_contract: [], output_contract: ["sorted-inbox"], required_skills: [] }] }] },
      ],
      types: [],
    },
  },
  {
    user_intent: "@@@@gibberish@@@@ rsTandard plz ???",
    claude_response: "InputValidationError: the request could not be parsed as a coltrane operation. Expected a verb like 'create', 'compose', 'inspect', etc. Please rephrase.",
    tool_calls: [],
    post_turn_genome_state: null,
    malformed_input: true,
  },
];

/** A drifting flow. Claude picks unrelated tools, responds about a different topic,
 *  writes a garbage genome, raw-stacks on malformed input, and contradicts itself. */
const DRIFT_TRANSCRIPT: UserFlowTranscript = [
  {
    user_intent: "create a new agent slug 'priority_sorter' that sorts inbox items by urgency",
    claude_response: "Here is a recipe for chocolate chip cookies. Preheat your oven to 375F. Cream butter and sugar...",
    tool_calls: [
      { tool_name: "weather_get", args: { city: "Tokyo" } },
    ],
    post_turn_genome_state: {
      random_garbage_field: 42,
      not_a_genome: true,
    },
  },
  {
    user_intent: "now compose a standard called 'inbox_triage' that uses priority_sorter",
    claude_response: "I don't see any agent called priority_sorter. Were you thinking of something else? Here's a list of haiku about autumn.",
    tool_calls: [
      { tool_name: "poem_write", args: { topic: "autumn" } },
    ],
    post_turn_genome_state: null,
  },
  {
    user_intent: "@@@@gibberish@@@@ rsTandard plz ???",
    claude_response: "TypeError: Cannot read properties of undefined (reading 'slug')\n    at processTicksAndRejections (node:internal/process/task_queues:96:5)\n    at async /Users/x/coltrane/src/runtime.ts:42:11",
    tool_calls: [],
    post_turn_genome_state: null,
    malformed_input: true,
  },
];

// ─────────────────────────── helpers ───────────────────────────

function loadJudgeStandard(): SoftJudgeStandard {
  return loadStandard(join(REPO_ROOT, "standards", "user_flow_correctness.json"));
}

function logVerdict(label: string, v: JudgeVerdict): void {
  // eslint-disable-next-line no-console
  console.log(`\n[${label}] overall_score=${v.overall_score} overall_pass=${v.overall_pass}`);
  // eslint-disable-next-line no-console
  console.log(`[${label}] top_finding: ${v.top_finding}`);
  for (const c of USER_FLOW_CRITERIA) {
    const cs = v.criteria[c];
    // eslint-disable-next-line no-console
    console.log(`[${label}]   ${c}: score=${cs.score} — ${cs.rationale.slice(0, 200)}`);
  }
}

// ─────────────────────────── specs ───────────────────────────

describe("user_flow_judge — gap-1 LLM-judge for user-flow behavioral correctness", () => {
  // Ensure the genome on disk loads cleanly through coltrane's loader before we
  // run any judge calls. Catches schema/agent/standard wiring breakage early.
  it("setup: standard + agents + domain_types load from disk", async () => {
    let env: TempdirColtrane | null = null;
    try {
      env = await setupTempdirColtrane();
      const { loadGenome } = await import("../../src/loader.js");
      const genome = loadGenome(env.tempDir);
      expect(genome.standards.has("user_flow_correctness")).toBe(true);
      expect(genome.agents.has("user_flow_sensor")).toBe(true);
      expect(genome.agents.has("user_flow_judge")).toBe(true);
      expect(genome.domain_types.has("user-flow-transcript@1")).toBe(true);
      expect(genome.domain_types.has("user-flow-verdict@1")).toBe(true);
    } finally {
      env?.cleanup();
    }
  }, 120_000);

  it("GOLD: clean transcript scores >= 4/5 (overall_pass=true)", async () => {
    const standard = loadJudgeStandard();
    const verdict = await scoreUserFlow(GOLD_TRANSCRIPT, standard);
    logVerdict("GOLD", verdict);
    if (verdict.overall_score === null) {
      // Surface raw stdout to diagnose extractor failures honestly.
      const raw = lastRawStdout();
      // eslint-disable-next-line no-console
      console.error(`[GOLD][raw.sense head]\n${raw.sense.slice(0, 800)}\n[...len=${raw.sense.length}]`);
      // eslint-disable-next-line no-console
      console.error(`[GOLD][raw.interpret head]\n${raw.interpret.slice(0, 800)}\n[...len=${raw.interpret.length}]`);
      // eslint-disable-next-line no-console
      console.error(`[GOLD][raw.interpret tail]\n${raw.interpret.slice(-800)}`);
    }

    expect(verdict.criteria).toBeDefined();
    expect(Object.keys(verdict.criteria).sort()).toEqual([...USER_FLOW_CRITERIA].sort());
    expect(verdict.overall_score).not.toBeNull();
    // Pre-reg: GOLD should clear 4/5 (lenient bound — judge noise won't push a clean
    // transcript below 4 unless the criteria themselves are mis-calibrated).
    expect(verdict.overall_score ?? 0).toBeGreaterThanOrEqual(4.0);
    expect(verdict.overall_pass).toBe(true);
  }, 600_000);

  it("DRIFT: ignored-intent transcript scores <= 2/5 and rationale mentions drift", async () => {
    const standard = loadJudgeStandard();
    const verdict = await scoreUserFlow(DRIFT_TRANSCRIPT, standard);
    logVerdict("DRIFT", verdict);

    expect(verdict.criteria).toBeDefined();
    expect(verdict.overall_score).not.toBeNull();
    // Pre-reg: DRIFT should fall below 2/5. If it doesn't, the judge is too lenient
    // and that's the honest finding — the assert stays.
    expect(verdict.overall_score ?? 5).toBeLessThanOrEqual(2.0);
    expect(verdict.overall_pass).toBe(false);

    // Rationale should at least mention drift/unrelated/ignore in SOME criterion.
    // We don't require a specific criterion to flag it — any-of is the honest bound.
    const allRationale = USER_FLOW_CRITERIA.map((c) => verdict.criteria[c].rationale).join(" ").toLowerCase();
    const mentionsDrift = /drift|unrelated|ignor|mismatch|off.?topic|unfaith|wrong tool|incorrect tool/.test(allRationale);
    expect(mentionsDrift, `no drift-language found in any criterion rationale; got: ${allRationale.slice(0, 500)}`).toBe(true);
  }, 600_000);

  it("REPRO: same transcript scored twice — criteria identical, scores within +/- 1.0", async () => {
    const standard = loadJudgeStandard();
    const v1 = await scoreUserFlow(GOLD_TRANSCRIPT, standard);
    const v2 = await scoreUserFlow(GOLD_TRANSCRIPT, standard);
    logVerdict("REPRO/run1", v1);
    logVerdict("REPRO/run2", v2);

    // Criteria-list identity is non-negotiable.
    expect(Object.keys(v1.criteria).sort()).toEqual(Object.keys(v2.criteria).sort());

    // Per-criterion: scores within the pre-registered noise band.
    const noiseBand = standard.scoring?.noise_band_repro ?? 1.0;
    const drift: Record<string, number> = {};
    for (const c of USER_FLOW_CRITERIA) {
      const s1 = v1.criteria[c].score;
      const s2 = v2.criteria[c].score;
      if (s1 === null || s2 === null) continue; // unjudgeable — skip in repro band
      const d = Math.abs(s1 - s2);
      drift[c] = d;
      expect(
        d,
        `REPRO drift on ${c}: |${s1} - ${s2}| = ${d} > noise_band ${noiseBand}. If this fails persistently, set claude temperature=0 (or equivalent) on the judge subprocess.`,
      ).toBeLessThanOrEqual(noiseBand);
    }

    // Overall verdict stability: if one passed and the other didn't, that's a hard
    // signal the judge is undertemped — surface it.
    if (v1.overall_pass !== v2.overall_pass) {
      // eslint-disable-next-line no-console
      console.warn(`[REPRO] overall_pass flipped: run1=${v1.overall_pass} run2=${v2.overall_pass} — judge variance exceeds verdict-stability threshold`);
    }
    // We DON'T expect.equal(v1.overall_pass, v2.overall_pass) here — the honest
    // bound is the per-criterion noise band above. The console.warn surfaces it.
  }, 1_200_000);
});
