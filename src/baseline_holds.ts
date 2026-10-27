/**
 * chancery-red-drafting-v0 (DS-5) — the baseline holds.
 *
 * A RED PASS drafts new laws and amends the ones its scope names; it must not quietly break a law it was
 * never given. This compares the loop result taken at the baseline commit with the one taken on the
 * drafter's branch, and refuses when a pre-existing law the scope does NOT name has lost its place:
 * it is absent from the branch, its verdict moved, or one of its plants no longer turns it red the way
 * it did. A law the scope names is excepted — changing it is the red pass's whole point (Vör's
 * condition) — and a law that exists only on the branch is allowed (a red pass adds laws).
 *
 * Pure and synchronous: it compares two values it is handed and runs no loop, reads no repository.
 * Producing a loop result from a commit is the caller's.
 */

/** One plant's outcome: "red" when the law goes red under the plant (as it must), "green" when the law
 *  PASSES its own plant — a law that has lost its teeth. */
export interface BaselinePlantResult {
  id: string;
  outcome: "red" | "green";
}

export interface BaselineLawResult {
  id: string;
  verdict: "pass" | "fail";
  plants: ReadonlyArray<BaselinePlantResult>;
}

/** The result of running a charter's law loop at one commit. */
export interface BaselineLoopResult {
  laws: ReadonlyArray<BaselineLawResult>;
}

/** The red pass's scope. Only `laws` is read: the comparison's rule is about the laws a scope names.
 *  `terms` and `files` are accepted so a whole scope object can be passed through unchanged, and are
 *  deliberately NOT read — the contract defines no rule for them here. */
export interface BaselineScope {
  laws?: readonly string[] | undefined;
  terms?: readonly string[] | undefined;
  files?: readonly string[] | undefined;
}

/** One reason the branch does not hold the baseline. `plant` is present only when the plant is what
 *  moved. */
export interface BaselineViolation {
  law: string;
  plant?: string;
  reason: string;
}

export interface BaselineComparison {
  pass: boolean;
  violations: BaselineViolation[];
  /** The law ids the scope names, which the comparison did not hold to the baseline. */
  excepted: string[];
}

/**
 * Every baseline law NOT named in `scope.laws` must, on the branch, be present with the same verdict
 * and the same outcome for each of its plants. A refusal names the law and, for a plant, the plant.
 */
export function compareBaselineLoop(input: {
  baseline: BaselineLoopResult;
  branch: BaselineLoopResult;
  scope: BaselineScope;
}): BaselineComparison {
  const excepted = [...(input.scope.laws ?? [])];
  const exceptedSet = new Set(excepted);
  const onBranch = new Map(input.branch.laws.map((l) => [l.id, l]));
  const violations: BaselineViolation[] = [];

  for (const base of input.baseline.laws) {
    if (exceptedSet.has(base.id)) continue;
    const now = onBranch.get(base.id);
    if (now === undefined) {
      violations.push({ law: base.id, reason: `law "${base.id}" is absent from the branch's loop result` });
      continue;
    }
    if (now.verdict !== base.verdict) {
      violations.push({
        law: base.id,
        reason: `law "${base.id}" changed verdict from ${base.verdict} to ${now.verdict}, and the scope does not name it`,
      });
    }
    const nowPlants = new Map(now.plants.map((p) => [p.id, p]));
    for (const plant of base.plants) {
      const after = nowPlants.get(plant.id);
      if (after === undefined) {
        violations.push({
          law: base.id,
          plant: plant.id,
          reason: `law "${base.id}" no longer has the plant "${plant.id}" on the branch`,
        });
      } else if (after.outcome !== plant.outcome) {
        violations.push({
          law: base.id,
          plant: plant.id,
          reason: `law "${base.id}" under plant "${plant.id}" went from ${plant.outcome} to ${after.outcome}, and the scope does not name the law`,
        });
      }
    }
  }
  return { pass: violations.length === 0, violations, excepted };
}
