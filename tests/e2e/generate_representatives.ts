// phase 17: representative-cell generator for the topology-collapsed state-space.
//
// Reads the equivalence-class definitions from topology_state_space.md (encoded
// inline here for direct execution — the spec doc is human-readable, this is the
// machine-readable mirror). Emits the rep list with metadata.
//
// run:  npx tsx tests/e2e/generate_representatives.ts
// out:  tests/e2e/representatives_2026-06-02.json

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type Persona = "solo_dev" | "platform_team" | "research_lab" | "eng_manager";
type ContextClass = "small" | "medium" | "near_overflow";

interface RepCell {
  rep_id: string;
  equivalence_class_id: "A" | "B" | "C" | "D" | "E" | "F";
  equivalence_class_name: string;
  persona: Persona;
  parent_turn: number;
  child_turn: number;
  context_class: ContextClass;
  chain_depth: number;
  cells_in_class: number;
  sampled_as_rep: true;
  rationale: string;
}

const reps: RepCell[] = [];

function chainDepth(p: number, c: number): number {
  return Math.max(p, c);
}

// =============================================================================
// CLASS A — cold-start, structural (1 primary + 3 cross-persona = 4 reps)
// covers 8 cells: 4 personas × 2 context_classes (small, medium)
// =============================================================================
reps.push({
  rep_id: "A-primary-solo_dev-small",
  equivalence_class_id: "A",
  equivalence_class_name: "cold-start structural",
  persona: "solo_dev",
  parent_turn: 0,
  child_turn: 0,
  context_class: "small",
  chain_depth: 0,
  cells_in_class: 8,
  sampled_as_rep: true,
  rationale: "anchor rep — exercises the MCP cold-start handshake at minimal context",
});
// cross-persona validators of invariance prediction 1
for (const persona of ["platform_team", "research_lab", "eng_manager"] as Persona[]) {
  reps.push({
    rep_id: `A-cross-${persona}-small`,
    equivalence_class_id: "A",
    equivalence_class_name: "cold-start structural",
    persona,
    parent_turn: 0,
    child_turn: 0,
    context_class: "small",
    chain_depth: 0,
    cells_in_class: 8,
    sampled_as_rep: true,
    rationale: "cross-persona check of persona-invariance under sub-thread protocol",
  });
}

// =============================================================================
// CLASS B — cold-start, near-overflow (1 rep)
// covers 4 cells: 4 personas × 1 chain_depth × near_overflow
// =============================================================================
reps.push({
  rep_id: "B-overflow-solo_dev",
  equivalence_class_id: "B",
  equivalence_class_name: "cold-start near-overflow",
  persona: "solo_dev",
  parent_turn: 0,
  child_turn: 0,
  context_class: "near_overflow",
  chain_depth: 0,
  cells_in_class: 4,
  sampled_as_rep: true,
  rationale: "tests whether coltrane has any near-overflow code path (predicted: no, collapses to A)",
});

// =============================================================================
// CLASS C — resume-chain, structural (7 reps: 4 chain-depths + 3 cross-persona at depth=2)
// covers 168 cells
// =============================================================================
// one rep per chain_depth at "balanced" parent/child split
const depthAnchors: Array<{ depth: number; parent: number; child: number }> = [
  { depth: 1, parent: 0, child: 1 }, // first resume
  { depth: 2, parent: 1, child: 1 }, // balanced
  { depth: 3, parent: 1, child: 2 }, // child-deeper
  { depth: 4, parent: 2, child: 2 }, // deep
];
for (const anchor of depthAnchors) {
  reps.push({
    rep_id: `C-depth${anchor.depth}-solo_dev-small`,
    equivalence_class_id: "C",
    equivalence_class_name: "resume-chain structural",
    persona: "solo_dev",
    parent_turn: anchor.parent,
    child_turn: anchor.child,
    context_class: "small",
    chain_depth: anchor.depth,
    cells_in_class: 168,
    sampled_as_rep: true,
    rationale: `chain_depth=${anchor.depth} rep — tests invariance-prediction-4 (depths≥1 collapse to one class)`,
  });
}
// cross-persona validators at depth=2 (the sweet spot for catching parent-child lineage)
for (const persona of ["platform_team", "research_lab", "eng_manager"] as Persona[]) {
  reps.push({
    rep_id: `C-depth2-${persona}-cross`,
    equivalence_class_id: "C",
    equivalence_class_name: "resume-chain structural",
    persona,
    parent_turn: 1,
    child_turn: 1,
    context_class: "small",
    chain_depth: 2,
    cells_in_class: 168,
    sampled_as_rep: true,
    rationale: "cross-persona check at depth=2 — does resume-chain failure-mode depend on persona?",
  });
}

// =============================================================================
// CLASS D — resume-chain, near-overflow (1 rep)
// covers 84 cells
// =============================================================================
reps.push({
  rep_id: "D-depth2-overflow-research_lab",
  equivalence_class_id: "D",
  equivalence_class_name: "resume-chain near-overflow",
  persona: "research_lab",
  parent_turn: 1,
  child_turn: 1,
  context_class: "near_overflow",
  chain_depth: 2,
  cells_in_class: 84,
  sampled_as_rep: true,
  rationale: "combined overflow + chain — does the union path differ from sum of parts?",
});

// =============================================================================
// CLASS E — assertion-specific per-persona (4 reps)
// each persona's load-bearing hard assertion gets one rep
// =============================================================================
reps.push({
  rep_id: "E-eng_manager-ramp",
  equivalence_class_id: "E",
  equivalence_class_name: "assertion-specific: eng_manager 5-min ramp",
  persona: "eng_manager",
  parent_turn: 0,
  child_turn: 0,
  context_class: "small",
  chain_depth: 0,
  cells_in_class: 1,
  sampled_as_rep: true,
  rationale: "5-min ramp budget — load-bearing assertion for onboarding persona",
});
reps.push({
  rep_id: "E-platform_team-api_version",
  equivalence_class_id: "E",
  equivalence_class_name: "assertion-specific: platform api-version fail-closed",
  persona: "platform_team",
  parent_turn: 0,
  child_turn: 1, // requires a resume to test fail-closed across version bump
  context_class: "small",
  chain_depth: 1,
  cells_in_class: 1,
  sampled_as_rep: true,
  rationale: "api-version fail-closed — load-bearing for platform-team observability",
});
reps.push({
  rep_id: "E-research_lab-lineage",
  equivalence_class_id: "E",
  equivalence_class_name: "assertion-specific: research_lab parent-child lineage",
  persona: "research_lab",
  parent_turn: 1,
  child_turn: 2,
  context_class: "small",
  chain_depth: 3,
  cells_in_class: 1,
  sampled_as_rep: true,
  rationale: "depth≥3 lineage with parent_session_id — load-bearing for research-lab determinism",
});
reps.push({
  rep_id: "E-solo_dev-parallel",
  equivalence_class_id: "E",
  equivalence_class_name: "assertion-specific: solo_dev 3-parallel",
  persona: "solo_dev",
  parent_turn: 0,
  child_turn: 0,
  context_class: "small",
  chain_depth: 0,
  cells_in_class: 1,
  sampled_as_rep: true,
  rationale: "3-parallel children w/ session_id capture — load-bearing for solo-dev concurrent",
});

// =============================================================================
// CLASS F — parent/child asymmetry probe (2 reps)
// =============================================================================
reps.push({
  rep_id: "F-asymmetry-parent_heavy",
  equivalence_class_id: "F",
  equivalence_class_name: "parent/child asymmetry probe",
  persona: "solo_dev",
  parent_turn: 2,
  child_turn: 0,
  context_class: "small",
  chain_depth: 2,
  cells_in_class: 2,
  sampled_as_rep: true,
  rationale: "parent-heavy: does parent-side turn accumulation differ from child-side?",
});
reps.push({
  rep_id: "F-asymmetry-child_heavy",
  equivalence_class_id: "F",
  equivalence_class_name: "parent/child asymmetry probe",
  persona: "solo_dev",
  parent_turn: 0,
  child_turn: 2,
  context_class: "small",
  chain_depth: 2,
  cells_in_class: 2,
  sampled_as_rep: true,
  rationale: "child-heavy: paired with F-asymmetry-parent_heavy to validate invariance prediction 3",
});

// =============================================================================
// emit
// =============================================================================
const cartesian = 5 * 5 * 3 * 4;
const covered = new Set<string>();

// account coverage carefully
function expand(classId: string): Set<string> {
  const set = new Set<string>();
  if (classId === "A") {
    for (const p of ["solo_dev", "platform_team", "research_lab", "eng_manager"]) {
      for (const ctx of ["small", "medium"]) {
        set.add(`${p}|0|0|${ctx}`);
      }
    }
  } else if (classId === "B") {
    for (const p of ["solo_dev", "platform_team", "research_lab", "eng_manager"]) {
      set.add(`${p}|0|0|near_overflow`);
    }
  } else if (classId === "C") {
    for (const p of ["solo_dev", "platform_team", "research_lab", "eng_manager"]) {
      for (let parent = 0; parent <= 4; parent++) {
        for (let child = 0; child <= 4; child++) {
          if (chainDepth(parent, child) >= 1) {
            for (const ctx of ["small", "medium"]) {
              set.add(`${p}|${parent}|${child}|${ctx}`);
            }
          }
        }
      }
    }
  } else if (classId === "D") {
    for (const p of ["solo_dev", "platform_team", "research_lab", "eng_manager"]) {
      for (let parent = 0; parent <= 4; parent++) {
        for (let child = 0; child <= 4; child++) {
          if (chainDepth(parent, child) >= 1) {
            set.add(`${p}|${parent}|${child}|near_overflow`);
          }
        }
      }
    }
  }
  // E and F are individual cells, not classes covering many — accounted directly
  return set;
}

const classAcoverage = expand("A");
const classBcoverage = expand("B");
const classCcoverage = expand("C");
const classDcoverage = expand("D");

for (const s of classAcoverage) covered.add(s);
for (const s of classBcoverage) covered.add(s);
for (const s of classCcoverage) covered.add(s);
for (const s of classDcoverage) covered.add(s);
// E + F probe cells live within already-covered classes (A and C) — they don't add to coverage,
// they refine within-class structure. Honest accounting: covered = union of A∪B∪C∪D.
const honestlyCovered = covered.size;

const out = {
  generated_at: new Date().toISOString(),
  state_space: {
    axes: {
      parent_turn: [0, 1, 2, 3, 4],
      child_turn: [0, 1, 2, 3, 4],
      context_size_class: ["small", "medium", "near_overflow"],
      persona: ["solo_dev", "platform_team", "research_lab", "eng_manager"],
    },
    cartesian_cell_count: cartesian,
  },
  equivalence_classes: [
    { id: "A", name: "cold-start structural", cells: classAcoverage.size },
    { id: "B", name: "cold-start near-overflow", cells: classBcoverage.size },
    { id: "C", name: "resume-chain structural", cells: classCcoverage.size },
    { id: "D", name: "resume-chain near-overflow", cells: classDcoverage.size },
    { id: "E", name: "assertion-specific (per-persona)", cells: 4 },
    { id: "F", name: "parent/child asymmetry probe", cells: 2 },
  ],
  coverage: {
    cells_in_mapped_classes: honestlyCovered,
    cells_total: cartesian,
    cells_unmapped: cartesian - honestlyCovered,
    note: "E + F reps overlap A/C coordinates (refine within-class, do not extend coverage)",
  },
  representatives: reps,
  compute_saving: {
    cells_covered: honestlyCovered,
    reps_run: reps.length,
    raw_ratio: honestlyCovered / reps.length,
  },
};

const outPath = join(__dirname, "representatives_2026-06-02.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${reps.length} reps covering ${out.coverage.cells_in_mapped_classes}/${cartesian} cells → ${outPath}`);
console.log(`raw compute saving: ${out.compute_saving.raw_ratio.toFixed(1)}× (cells_covered / reps_run)`);
