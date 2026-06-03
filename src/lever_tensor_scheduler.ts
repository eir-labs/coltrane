// §X lever_tensor_scheduler — minimal-K covering-design solver over a known
// failure library.
//
// Given a set of candidate casts (each with a known blind spot) and the
// failure library (blind spot -> casts that share it), select K casts whose
// blind spots cancel: the umbra of the selection is empty when, for every
// blind spot in the library, at least one selected cast can read it.
//
// This is a covering-code construction — not a search. The blind spots are
// characterised at design time, so the conductor places casts at the holes
// rather than running redundant agents.
//
// Construction (clean, not brute-force):
//   1. Partition tasks by failure_mode → equivalence classes.
//   2. For each blind spot listed in the failure library, pick one
//      representative cast from a DIFFERENT class (so its blind spot is
//      orthogonal to the one being covered).
//   3. The minimal K is the number of distinct failure_modes whose
//      representatives we had to dispatch, bounded below by k_object_dimension.
//   4. Any blind spot whose every listed cast also belongs to every other
//      class lands in the residual umbra.
//
// The transverse_score is the fraction of (i, j) pairs in the assignment
// whose failure_modes differ — 1.0 when fully transverse, 0.0 when all
// selected casts share a single blind spot.
//
// Author: miles · 2026-06-03

/** A candidate cast — one path through the design tensor. */
export interface CastDescriptor {
  readonly cast_id: string;
  readonly levers: {
    readonly N_depth: number;
    readonly K_position: number;
    readonly Y_layer: string;
    readonly X_angularity: number;
    readonly direction: "forward" | "backward";
    readonly rep: string;
  };
  /** The cast's known blind spot — its entry in the failure library. */
  readonly failure_mode: string;
}

/** Cover problem: tasks + cover-number floor + failure library. */
export interface CoverProblem {
  readonly tasks: readonly CastDescriptor[];
  readonly k_object_dimension: number;
  /** failure_mode -> cast_ids that share that blind spot. */
  readonly failure_library: Record<string, readonly string[]>;
}

/** Solution: the assignment, residual umbra, and transverse_score. */
export interface CoverSolution {
  readonly K_minimal: number;
  readonly cover_complete: boolean;
  readonly umbra_remaining: readonly string[];
  readonly permutation_assignment: ReadonlyArray<{ slot: number; cast_id: string }>;
  readonly transverse_score: number;
}

export class LeverTensorError extends Error {}

/**
 * Solve the minimal-K covering design.
 *
 * Strategy:
 *   • Each blind spot F in the library is "covered" iff the assignment contains
 *     at least one cast NOT listed in failure_library[F] (i.e., whose
 *     failure_mode is not F).
 *   • We pick one representative cast per distinct failure_mode present in
 *     the tasks (transverse selection — the eigenframe step from the lineage).
 *   • If the resulting count is below k_object_dimension we pad with extras
 *     drawn from the largest classes (preserving distinctness when possible).
 *   • Residual umbra: any blind spot whose listed casts are a SUPERSET of the
 *     full task pool — no cast can read it, no scheduling fixes it.
 */
export function computeCover(problem: CoverProblem): CoverSolution {
  if (!Number.isInteger(problem.k_object_dimension) || problem.k_object_dimension < 0) {
    throw new LeverTensorError(
      `k_object_dimension must be a non-negative integer, got ${problem.k_object_dimension}`,
    );
  }

  // 1. Partition tasks by failure_mode.
  const classes = new Map<string, CastDescriptor[]>();
  for (const t of problem.tasks) {
    const cls = classes.get(t.failure_mode) ?? [];
    cls.push(t);
    classes.set(t.failure_mode, cls);
  }

  // 2. Pick one representative per class — the transverse skeleton.
  //    Order: classes sorted by failure_mode for determinism.
  const sortedModes = Array.from(classes.keys()).sort();
  const skeleton: CastDescriptor[] = [];
  for (const mode of sortedModes) {
    const reps = classes.get(mode);
    if (reps && reps.length > 0 && reps[0]) skeleton.push(reps[0]);
  }

  // 3. Pad to k_object_dimension by drawing additional casts from existing
  //    classes (round-robin, distinctness-first). These extras buy
  //    error-correction past the cover, never coverage — but the floor is
  //    a hard input contract.
  const assignment: CastDescriptor[] = [...skeleton];
  if (assignment.length < problem.k_object_dimension) {
    const queues = sortedModes.map((m) => {
      const list = classes.get(m) ?? [];
      // skip the representative already used
      return list.slice(1);
    });
    let qi = 0;
    let safety = 0;
    while (assignment.length < problem.k_object_dimension && safety < 10_000) {
      const q = queues[qi % Math.max(queues.length, 1)];
      if (q && q.length > 0) {
        const next = q.shift();
        if (next) assignment.push(next);
      }
      qi += 1;
      safety += 1;
      // If every queue is empty we cannot pad further — break to avoid an
      // infinite loop on an under-resourced task pool.
      if (queues.every((q) => q.length === 0)) break;
    }
  }

  // 4. Compute residual umbra against the FULL library.
  //    F is in umbra iff every selected cast is listed under F (i.e., every
  //    selected cast is blind to F). Equivalently: assignment ⊆ library[F].
  const assignmentIds = new Set(assignment.map((c) => c.cast_id));
  const umbra: string[] = [];
  for (const [mode, blind] of Object.entries(problem.failure_library)) {
    const blindSet = new Set(blind);
    let allBlind = assignment.length > 0;
    for (const id of assignmentIds) {
      if (!blindSet.has(id)) {
        allBlind = false;
        break;
      }
    }
    if (allBlind) umbra.push(mode);
  }
  umbra.sort();

  // 5. Transverse score: fraction of distinct-pair slots whose failure_modes
  //    differ. 1.0 ⇔ fully orthogonal selection; 0.0 ⇔ all aligned.
  const score = transverseScore(assignment);

  // 6. Emit the permutation slot assignment.
  const permutation = assignment.map((c, i) => ({ slot: i, cast_id: c.cast_id }));

  return {
    K_minimal: assignment.length,
    cover_complete: umbra.length === 0 && assignment.length >= problem.k_object_dimension,
    umbra_remaining: umbra,
    permutation_assignment: permutation,
    transverse_score: score,
  };
}

/** Pair-wise fraction of slots whose blind spots differ. */
function transverseScore(assignment: readonly CastDescriptor[]): number {
  if (assignment.length < 2) return assignment.length === 1 ? 1 : 0;
  let differ = 0;
  let total = 0;
  for (let i = 0; i < assignment.length; i++) {
    for (let j = i + 1; j < assignment.length; j++) {
      total += 1;
      const a = assignment[i];
      const b = assignment[j];
      if (a && b && a.failure_mode !== b.failure_mode) differ += 1;
    }
  }
  return total === 0 ? 0 : differ / total;
}

/** MCP tool descriptor — slot into the bandstand server registry. */
export const LEVER_TENSOR_COMPUTE_COVER_TOOL = {
  slug: "lever_tensor_compute_cover",
  description:
    "Solve minimal-K covering design over a failure library. Returns the K-permutation assignment whose blind spots cancel.",
  input_schema: {
    type: "object" as const,
    required: ["tasks", "k_object_dimension", "failure_library"],
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["cast_id", "levers", "failure_mode"],
          properties: {
            cast_id: { type: "string" },
            levers: {
              type: "object",
              required: [
                "N_depth",
                "K_position",
                "Y_layer",
                "X_angularity",
                "direction",
                "rep",
              ],
              properties: {
                N_depth: { type: "number" },
                K_position: { type: "number" },
                Y_layer: { type: "string" },
                X_angularity: { type: "number" },
                direction: { type: "string", enum: ["forward", "backward"] },
                rep: { type: "string" },
              },
            },
            failure_mode: { type: "string" },
          },
        },
      },
      k_object_dimension: { type: "number" },
      failure_library: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
  },
  output_schema: {
    type: "object" as const,
    required: [
      "K_minimal",
      "cover_complete",
      "umbra_remaining",
      "permutation_assignment",
      "transverse_score",
    ],
    properties: {
      K_minimal: { type: "number" },
      cover_complete: { type: "boolean" },
      umbra_remaining: { type: "array", items: { type: "string" } },
      permutation_assignment: {
        type: "array",
        items: {
          type: "object",
          required: ["slot", "cast_id"],
          properties: {
            slot: { type: "number" },
            cast_id: { type: "string" },
          },
        },
      },
      transverse_score: { type: "number" },
    },
  },
} as const;
