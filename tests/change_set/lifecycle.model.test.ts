// RED — the change-set branch LIFECYCLE as a state machine: {none, red, green, retired}.
//
// Covers I10 (across every legal/illegal transition sequence, a RED merge — the spec PR or the
// implementation PR — is NEVER performed against the protected main line, which is how the fourth
// law composes with Law C rather than contradicting it) and I14 (retirement is RECORDED and
// at-most-once: a branch is retired ≤ 1 time and every retirement emits a logged record — never a
// silent delete).
//
// Model-based (fast-check drives random command sequences against a reference model of the
// allowed transitions), because these invariants must hold over the whole transition SPACE, not a
// sampled path. RED because ChangeSetBranchMachine.apply/retiredCount/retirementLog throw until
// the lifecycle is built. Strict: `merge-red`/`merge-green` targeting main fails immediately, so
// an implementation that lets a red merge reach main stays red.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  ChangeSetBranchMachine,
  PROTECTED_MAIN_LINE,
  type LifecycleCommand,
  type MergeAttempt,
} from "../../src/change_set_branch.js";

const commandArb: fc.Arbitrary<LifecycleCommand> = fc.oneof(
  fc.constant<LifecycleCommand>({ kind: "create" }),
  fc.constant<LifecycleCommand>({ kind: "merge-red" }),
  fc.constant<LifecycleCommand>({ kind: "merge-green" }),
  fc.constant<LifecycleCommand>({ kind: "promote-to-main" }),
  fc.constantFrom("governor", "human-governor").map(
    (by): LifecycleCommand => ({ kind: "retire", by }),
  ),
);

function isRedMerge(a: MergeAttempt): boolean {
  return a.action === "merge-red" || a.action === "merge-green";
}

describe("change-set branch lifecycle — main never sees a red merge; retirement is recorded (I10, I14)", () => {
  it("I10 no red merge ever targets the protected main line, across any command sequence", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.array(commandArb, { maxLength: 12 }), (gigId, cmds) => {
        const machine = new ChangeSetBranchMachine(`changeset/${gigId}`);
        for (const cmd of cmds) {
          for (const attempt of machine.apply(cmd)) {
            if (isRedMerge(attempt)) {
              expect(
                attempt.target_branch,
                "a red merge targeted main — Law C would forbid it and the fourth law does not widen it",
              ).not.toBe(PROTECTED_MAIN_LINE);
            }
          }
        }
      }),
    );
  });

  it("I14 retirement is at-most-once and always recorded, across any command sequence", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.array(commandArb, { maxLength: 12 }), (gigId, cmds) => {
        const machine = new ChangeSetBranchMachine(`changeset/${gigId}`);
        for (const cmd of cmds) machine.apply(cmd);
        expect(machine.retiredCount(), "a branch retired more than once").toBeLessThanOrEqual(1);
        expect(
          machine.retirementLog().length,
          "a retirement happened without a recorded event — a silent delete",
        ).toBe(machine.retiredCount());
      }),
    );
  });

  it("I10/I14 the happy path: the ONLY main-targeting merge is the green promotion; retire logs once", () => {
    const branch = "changeset/550e8400-e29b-41d4-a716-446655440000";
    const machine = new ChangeSetBranchMachine(branch);
    machine.apply({ kind: "create" });
    machine.apply({ kind: "merge-red" }); // RED spec into the change-set branch — never main
    expect(machine.state()).toBe("red");
    machine.apply({ kind: "merge-green" }); // GREEN implementation into the change-set branch
    expect(machine.state()).toBe("green");
    const promote = machine.apply({ kind: "promote-to-main" });
    expect(promote.some((a) => a.action === "promote-to-main" && a.target_branch === PROTECTED_MAIN_LINE)).toBe(true);
    machine.apply({ kind: "retire", by: "human-governor" });
    expect(machine.state()).toBe("retired");
    expect(machine.retiredCount()).toBe(1);
    expect(machine.retirementLog()).toEqual([{ branch, by: "human-governor" }]);
  });
});
