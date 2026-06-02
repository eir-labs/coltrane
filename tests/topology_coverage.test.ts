// Test-coverage proof for the topology helper.
// Asserts the equivalence-class reduction actually saves compute (class count
// strictly smaller than state-space count) and that the chosen representatives
// span all five personas.

import { describe, it, expect } from "vitest";
import {
  buildStateSpace,
  equivalenceClasses,
  selectRepresentatives,
  coverageReport,
  type SubThreadState,
  type PersonaClass,
} from "../src/test_topology.js";

const ALL_PERSONAS: PersonaClass[] = [
  "backend-eng",
  "oss-maintainer",
  "security-eng",
  "fresh-contributor",
  "non-engineer-tash-shape",
];

describe("topology-based sub-thread test-coverage helper", () => {
  it("generates a state space at maxParentTurns=5, maxChildTurns=10 without errors", () => {
    const states = buildStateSpace(5, 10);
    // (5+1) parent turns * (10+1) child turns * 5 personas = 330
    expect(states.length).toBe(6 * 11 * 5);
    // Every state has all four fields populated and within bounds.
    for (const s of states) {
      expect(s.parent_turn).toBeGreaterThanOrEqual(0);
      expect(s.parent_turn).toBeLessThanOrEqual(5);
      expect(s.child_turn).toBeGreaterThanOrEqual(0);
      expect(s.child_turn).toBeLessThanOrEqual(10);
      expect([
        "small",
        "medium",
        "large",
        "overflow",
      ]).toContain(s.context_size_class);
      expect(ALL_PERSONAS).toContain(s.persona_class);
    }
  });

  it("rejects negative bounds", () => {
    expect(() => buildStateSpace(-1, 0)).toThrow();
    expect(() => buildStateSpace(0, -1)).toThrow();
  });

  it("equivalence-class count is bounded — strictly smaller than the state-space (the reduction works)", () => {
    const states = buildStateSpace(5, 10);
    const classes = equivalenceClasses(states);
    // Reduction must actually reduce.
    expect(classes.length).toBeLessThan(states.length);
    // Upper bound by invariant cardinality:
    //   4 context_size_class * 3 child_turn_mod_3 * 5 persona = 60
    // (Some combinations may not be realized — small never has child_turn%3==anything
    //  it can't reach, etc., so we assert <= 60 rather than ==.)
    expect(classes.length).toBeLessThanOrEqual(4 * 3 * 5);
    // And we should see meaningful collapse: each class averages multiple states.
    const avgClassSize = states.length / classes.length;
    expect(avgClassSize).toBeGreaterThan(1);
  });

  it("selects at least 1 representative per equivalence class", () => {
    const states = buildStateSpace(5, 10);
    const classes = equivalenceClasses(states);
    const reps = selectRepresentatives(classes);
    expect(reps.length).toBeGreaterThanOrEqual(classes.length);
    // And no more than 2 per class.
    expect(reps.length).toBeLessThanOrEqual(2 * classes.length);
  });

  it("all 5 personas have at least one representative in the selected set", () => {
    const states = buildStateSpace(5, 10);
    const classes = equivalenceClasses(states);
    const reps = selectRepresentatives(classes);
    const personasCovered = new Set(reps.map((r: SubThreadState) => r.persona_class));
    for (const p of ALL_PERSONAS) {
      expect(personasCovered.has(p)).toBe(true);
    }
  });

  it("coverage report counts covered + missing correctly", () => {
    const states = buildStateSpace(3, 6);
    const classes = equivalenceClasses(states);
    const reps = selectRepresentatives(classes);
    // Full coverage when we test every representative.
    const full = coverageReport(classes, reps);
    expect(full.covered).toBe(classes.length);
    expect(full.total).toBe(classes.length);
    expect(full.missing.length).toBe(0);

    // Empty coverage when nothing is tested.
    const empty = coverageReport(classes, []);
    expect(empty.covered).toBe(0);
    expect(empty.total).toBe(classes.length);
    expect(empty.missing.length).toBe(classes.length);

    // Partial coverage: drop all reps belonging to one specific class
    // (a class may have 2 reps under the centroid+boundary policy, so dropping
    // a single rep can still leave that class covered by its sibling rep).
    if (classes.length > 1) {
      const targetClass = classes[0] as SubThreadState[];
      const targetHead = targetClass[0] as SubThreadState;
      const targetCtx = targetHead.context_size_class;
      const targetMod = targetHead.child_turn % 3;
      const targetPersona = targetHead.persona_class;
      const remaining = reps.filter(
        (r: SubThreadState) =>
          !(
            r.context_size_class === targetCtx &&
            r.child_turn % 3 === targetMod &&
            r.persona_class === targetPersona
          ),
      );
      const partial = coverageReport(classes, remaining);
      expect(partial.covered).toBeLessThan(classes.length);
      expect(partial.covered + partial.missing.length).toBe(classes.length);
      expect(partial.missing.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("equivalence classes are well-formed — each class is non-empty and same-keyed internally", () => {
    const states = buildStateSpace(2, 8);
    const classes = equivalenceClasses(states);
    for (const cls of classes) {
      expect(cls.length).toBeGreaterThan(0);
      const head = cls[0] as SubThreadState;
      for (const m of cls) {
        expect(m.context_size_class).toBe(head.context_size_class);
        expect(m.child_turn % 3).toBe(head.child_turn % 3);
        expect(m.persona_class).toBe(head.persona_class);
      }
    }
  });
});
