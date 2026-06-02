// Topology-based test-coverage helper for sub-thread state-space tests.
// Saves compute by collapsing the full (parent_turn x child_turn x context_size x persona)
// product into equivalence classes, then picking 1-2 representatives per class
// instead of running every multi-turn flow exhaustively.

export type ContextSizeClass = "small" | "medium" | "large" | "overflow";

export type PersonaClass =
  | "backend-eng"
  | "oss-maintainer"
  | "security-eng"
  | "fresh-contributor"
  | "non-engineer-tash-shape";

export interface SubThreadState {
  parent_turn: number;
  child_turn: number;
  context_size_class: ContextSizeClass;
  persona_class: PersonaClass;
}

export interface Transition {
  from: SubThreadState;
  to: SubThreadState;
  kind: "spawn" | "resume" | "context-overflow" | "persona-switch";
}

const PERSONA_CLASSES: PersonaClass[] = [
  "backend-eng",
  "oss-maintainer",
  "security-eng",
  "fresh-contributor",
  "non-engineer-tash-shape",
];

// Map child_turn -> context_size_class by accumulation bound.
// Bands cumulative tokens by integer turn count; overflow at the last threshold.
function contextSizeForTurn(childTurn: number): ContextSizeClass {
  if (childTurn <= 2) return "small";
  if (childTurn <= 5) return "medium";
  if (childTurn <= 8) return "large";
  return "overflow";
}

// Enumerate all reachable sub-thread states up to the given bounds.
// A state is reachable if there is some parent_turn in [0, maxParentTurns]
// and child_turn in [0, maxChildTurns] paired with a persona; context_size_class
// follows from child_turn under the accumulation model above.
export function buildStateSpace(
  maxParentTurns: number,
  maxChildTurns: number,
): SubThreadState[] {
  if (maxParentTurns < 0 || maxChildTurns < 0) {
    throw new Error(
      `buildStateSpace bounds must be non-negative; got parent=${maxParentTurns}, child=${maxChildTurns}`,
    );
  }
  const states: SubThreadState[] = [];
  for (let p = 0; p <= maxParentTurns; p++) {
    for (let c = 0; c <= maxChildTurns; c++) {
      const ctx = contextSizeForTurn(c);
      for (const persona of PERSONA_CLASSES) {
        states.push({
          parent_turn: p,
          child_turn: c,
          context_size_class: ctx,
          persona_class: persona,
        });
      }
    }
  }
  return states;
}

// Two states are equivalent modulo (context_size_class, child_turn % 3, persona_class).
function classKey(s: SubThreadState): string {
  return `${s.context_size_class}|${s.child_turn % 3}|${s.persona_class}`;
}

export function equivalenceClasses(
  states: SubThreadState[],
): SubThreadState[][] {
  const buckets = new Map<string, SubThreadState[]>();
  for (const s of states) {
    const k = classKey(s);
    const existing = buckets.get(k);
    if (existing) {
      existing.push(s);
    } else {
      buckets.set(k, [s]);
    }
  }
  // Stable iteration order by insertion.
  return Array.from(buckets.values());
}

// Pick 1-2 representatives per class.
// Centroid: the median-child_turn member of the class.
// Boundary: the maximum-parent_turn member.
// If the class is singleton, return just the centroid.
export function selectRepresentatives(
  classes: SubThreadState[][],
): SubThreadState[] {
  const reps: SubThreadState[] = [];
  for (const cls of classes) {
    if (cls.length === 0) continue;
    const sorted = [...cls].sort((a, b) => a.child_turn - b.child_turn);
    const centroidIdx = Math.floor(sorted.length / 2);
    const centroid = sorted[centroidIdx];
    if (!centroid) continue;
    reps.push(centroid);
    if (cls.length > 1) {
      const boundary = [...cls].sort(
        (a, b) => b.parent_turn - a.parent_turn,
      )[0];
      if (boundary && !sameState(boundary, centroid)) {
        reps.push(boundary);
      }
    }
  }
  return reps;
}

function sameState(a: SubThreadState, b: SubThreadState): boolean {
  return (
    a.parent_turn === b.parent_turn &&
    a.child_turn === b.child_turn &&
    a.context_size_class === b.context_size_class &&
    a.persona_class === b.persona_class
  );
}

// Coverage report: which classes are exercised by `testedStates`, which are missed.
export function coverageReport(
  allClasses: SubThreadState[][],
  testedStates: SubThreadState[],
): { covered: number; total: number; missing: SubThreadState[][] } {
  const testedKeys = new Set<string>();
  for (const s of testedStates) testedKeys.add(classKey(s));

  const missing: SubThreadState[][] = [];
  let covered = 0;
  for (const cls of allClasses) {
    const first = cls[0];
    if (!first) continue;
    if (testedKeys.has(classKey(first))) {
      covered += 1;
    } else {
      missing.push(cls);
    }
  }
  return { covered, total: allClasses.length, missing };
}

// Optional convenience: enumerate transitions between adjacent states.
// Not required by the public spec, but cheap to expose for downstream graph use.
export function adjacentTransitions(states: SubThreadState[]): Transition[] {
  const ts: Transition[] = [];
  for (let i = 0; i < states.length - 1; i++) {
    const from = states[i];
    const to = states[i + 1];
    if (!from || !to) continue;
    let kind: Transition["kind"] = "resume";
    if (from.persona_class !== to.persona_class) kind = "persona-switch";
    else if (
      from.context_size_class !== "overflow" &&
      to.context_size_class === "overflow"
    )
      kind = "context-overflow";
    else if (to.child_turn === 0) kind = "spawn";
    ts.push({ from, to, kind });
  }
  return ts;
}
