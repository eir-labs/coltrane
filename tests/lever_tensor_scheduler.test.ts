// lever_tensor_scheduler.spec.ts — minimal-K covering-design solver.
//
// Specs:
//   1. trivial transverse — 3 casts, 3 distinct blind spots → K=3, complete
//   2. fully aligned — 3 casts sharing one blind spot → incomplete, umbra ≠ ∅
//   3. mixed — 4 casts, 2 aligned + 2 transverse → K=3 covers (aligned class
//      contributes a single representative)
//   4. K_minimal must equal or exceed k_object_dimension (input floor)
//   5. transverse_score = 1.0 (all distinct) and 0.0 (all aligned)

import { describe, it, expect } from "vitest";
import {
  computeCover,
  LeverTensorError,
  LEVER_TENSOR_COMPUTE_COVER_TOOL,
  type CastDescriptor,
  type CoverProblem,
} from "../src/lever_tensor_scheduler.js";

function mk(
  cast_id: string,
  failure_mode: string,
  overrides?: Partial<CastDescriptor["levers"]>,
): CastDescriptor {
  return {
    cast_id,
    failure_mode,
    levers: {
      N_depth: 1,
      K_position: 0,
      Y_layer: "base",
      X_angularity: 0,
      direction: "forward",
      rep: "trivial",
      ...overrides,
    },
  };
}

describe("computeCover — trivial transverse case", () => {
  it("3 casts each blind to a distinct mode → K=3, cover complete, umbra empty", () => {
    const problem: CoverProblem = {
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_beta"),
        mk("c3", "mode_gamma"),
      ],
      k_object_dimension: 3,
      failure_library: {
        mode_alpha: ["c1"],
        mode_beta: ["c2"],
        mode_gamma: ["c3"],
      },
    };
    const sol = computeCover(problem);
    expect(sol.K_minimal).toBe(3);
    expect(sol.cover_complete).toBe(true);
    expect(sol.umbra_remaining).toEqual([]);
    expect(sol.permutation_assignment.map((p) => p.cast_id).sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(sol.permutation_assignment.map((p) => p.slot)).toEqual([0, 1, 2]);
    expect(sol.transverse_score).toBe(1);
  });
});

describe("computeCover — fully aligned case", () => {
  it("3 casts all blind to mode_alpha → cover incomplete, mode_alpha in umbra", () => {
    const problem: CoverProblem = {
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_alpha"),
        mk("c3", "mode_alpha"),
      ],
      k_object_dimension: 3,
      failure_library: {
        mode_alpha: ["c1", "c2", "c3"],
      },
    };
    const sol = computeCover(problem);
    expect(sol.cover_complete).toBe(false);
    expect(sol.umbra_remaining).toEqual(["mode_alpha"]);
    // Padding fills slots up to k_object_dimension but cover stays incomplete —
    // every cast shares the same blind spot.
    expect(sol.K_minimal).toBe(3);
    expect(sol.transverse_score).toBe(0);
  });

  it("3 casts all aligned with k_object_dimension=1 → K=1, cover incomplete", () => {
    const sol = computeCover({
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_alpha"),
        mk("c3", "mode_alpha"),
      ],
      k_object_dimension: 1,
      failure_library: { mode_alpha: ["c1", "c2", "c3"] },
    });
    expect(sol.cover_complete).toBe(false);
    expect(sol.umbra_remaining).toEqual(["mode_alpha"]);
    expect(sol.K_minimal).toBe(1);
  });
});

describe("computeCover — mixed alignment", () => {
  it("4 casts: 2 share mode_alpha + 2 transverse → K=3 cover", () => {
    const problem: CoverProblem = {
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_alpha"), // aligned with c1
        mk("c3", "mode_beta"),
        mk("c4", "mode_gamma"),
      ],
      k_object_dimension: 3,
      failure_library: {
        mode_alpha: ["c1", "c2"],
        mode_beta: ["c3"],
        mode_gamma: ["c4"],
      },
    };
    const sol = computeCover(problem);
    expect(sol.K_minimal).toBe(3);
    expect(sol.cover_complete).toBe(true);
    expect(sol.umbra_remaining).toEqual([]);
    // c1 OR c2 will represent mode_alpha; both are valid.
    const ids = new Set(sol.permutation_assignment.map((p) => p.cast_id));
    expect(ids.has("c3")).toBe(true);
    expect(ids.has("c4")).toBe(true);
    expect(ids.has("c1") || ids.has("c2")).toBe(true);
    expect(ids.has("c1") && ids.has("c2")).toBe(false);
    expect(sol.transverse_score).toBe(1);
  });
});

describe("computeCover — K floor and inputs", () => {
  it("K_minimal pads up to k_object_dimension when distinct classes are fewer", () => {
    const problem: CoverProblem = {
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_alpha"),
        mk("c3", "mode_beta"),
      ],
      k_object_dimension: 3,
      failure_library: {
        mode_alpha: ["c1", "c2"],
        mode_beta: ["c3"],
      },
    };
    const sol = computeCover(problem);
    // 2 distinct classes → skeleton of 2; pad by one extra from mode_alpha.
    expect(sol.K_minimal).toBeGreaterThanOrEqual(3);
    expect(sol.K_minimal).toBe(3);
    expect(sol.cover_complete).toBe(true);
  });

  it("rejects negative k_object_dimension", () => {
    expect(() =>
      computeCover({
        tasks: [mk("c1", "m")],
        k_object_dimension: -1,
        failure_library: { m: ["c1"] },
      }),
    ).toThrow(LeverTensorError);
  });

  it("k_object_dimension=0 still emits the transverse skeleton", () => {
    const sol = computeCover({
      tasks: [mk("c1", "a"), mk("c2", "b")],
      k_object_dimension: 0,
      failure_library: { a: ["c1"], b: ["c2"] },
    });
    expect(sol.K_minimal).toBe(2);
    expect(sol.cover_complete).toBe(true);
  });
});

describe("computeCover — transverse_score boundaries", () => {
  it("transverse_score = 1.0 when all selected casts have distinct blind spots", () => {
    const sol = computeCover({
      tasks: [mk("c1", "a"), mk("c2", "b"), mk("c3", "c"), mk("c4", "d")],
      k_object_dimension: 4,
      failure_library: { a: ["c1"], b: ["c2"], c: ["c3"], d: ["c4"] },
    });
    expect(sol.transverse_score).toBe(1);
  });

  it("transverse_score = 0.0 when all selected casts share one blind spot", () => {
    // Force the padding path: skeleton has only 1 class, k_object_dimension=3
    const sol = computeCover({
      tasks: [
        mk("c1", "mode_alpha"),
        mk("c2", "mode_alpha"),
        mk("c3", "mode_alpha"),
      ],
      k_object_dimension: 3,
      failure_library: { mode_alpha: ["c1", "c2", "c3"] },
    });
    expect(sol.K_minimal).toBe(3);
    expect(sol.transverse_score).toBe(0);
    expect(sol.cover_complete).toBe(false);
  });
});

describe("LEVER_TENSOR_COMPUTE_COVER_TOOL — MCP tool descriptor", () => {
  it("exposes the canonical slug + schemas", () => {
    expect(LEVER_TENSOR_COMPUTE_COVER_TOOL.slug).toBe("lever_tensor_compute_cover");
    expect(LEVER_TENSOR_COMPUTE_COVER_TOOL.input_schema.type).toBe("object");
    expect(LEVER_TENSOR_COMPUTE_COVER_TOOL.output_schema.type).toBe("object");
  });
});
