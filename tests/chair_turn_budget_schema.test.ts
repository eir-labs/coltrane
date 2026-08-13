// RED-first — Item 1, the SCHEMA half: a turn budget is a property of the WORK asked for (the
// chair), not of the player (the agent). Today the only turn cap lives on the AgentSchema
// (max_tool_calls, genome_schema.ts:123), so one scout carries the same budget into every chair it
// is seated in. This pins the additive move: ChairSchema gains an optional turn_budget and an
// optional turn_reserve, both non-negative integers, and every shipped genome file keeps loading
// unchanged.
//
// Covers contract INV1 (additive-compat + the fields are RETAINED, not stripped) and F1 (a
// negative / non-integer budget fails CLOSED at parse, so a nonsensical cap never reaches
// resolution). RED because ChairSchema does not declare the fields yet — a Zod object strips
// unknown keys, so today the parsed chair silently loses them and a negative value parses clean.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { ChairSchema } from "../src/genome_schema.js";
import { loadGenome } from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("ChairSchema carries the turn budget — Item 1, the additive schema move", () => {
  it("RETAINS turn_budget and turn_reserve on a chair record instead of stripping them", () => {
    const parsed = ChairSchema.parse({ role: "sense", turn_budget: 7, turn_reserve: 5 });
    // A Zod object with no such field strips the key: parsed.turn_budget === undefined TODAY.
    expect(
      (parsed as Record<string, unknown>)["turn_budget"],
      "the chair's declared turn budget was dropped on the floor — it must be an authored decision, " +
        "not silently discarded",
    ).toBe(7);
    expect(
      (parsed as Record<string, unknown>)["turn_reserve"],
      "the chair's declared reserve was dropped — the per-chair share of the pool must survive parse",
    ).toBe(5);
  });

  it("treats both fields as OPTIONAL — a chair that declares neither still parses (byte-equivalent)", () => {
    const parsed = ChairSchema.parse({ role: "sense" });
    expect(parsed.role).toBe("sense");
    expect((parsed as Record<string, unknown>)["turn_budget"]).toBeUndefined();
    expect((parsed as Record<string, unknown>)["turn_reserve"]).toBeUndefined();
  });

  it("keeps turn_budget===0 DISTINCT from absent — 0 is a deliberate hard floor, not a missing field", () => {
    const zero = ChairSchema.parse({ role: "sense", turn_budget: 0 });
    // Absent parses to undefined (previous test); zero must parse to the number 0, so the resolver
    // can tell "author asked for zero turns" apart from "author said nothing". RED: stripped today.
    expect(
      (zero as Record<string, unknown>)["turn_budget"],
      "0 was stripped or coerced to absent — then a hard floor of zero is indistinguishable from a " +
        "fall-through, which acceptance forbids",
    ).toBe(0);
  });

  it("FAILS CLOSED on a negative or non-integer turn budget — a nonsensical cap never loads", () => {
    // F1: parse must throw, not silently strip. Today an unknown key is stripped → no throw.
    expect(() => ChairSchema.parse({ role: "sense", turn_budget: -1 })).toThrow();
    expect(() => ChairSchema.parse({ role: "sense", turn_budget: 1.5 })).toThrow();
    expect(() => ChairSchema.parse({ role: "sense", turn_reserve: -3 })).toThrow();
  });

  it("ADDITIVE-COMPAT — every shipped genome file still loads and composes with no new errors", () => {
    // The additive floor: adding two optional chair fields must not red any shipped
    // standard/chart/agent/institution. This stays GREEN across the change; it is the regression
    // guard that proves the move was additive, paired with the RED retain-test above.
    const genome = loadGenome(REPO_ROOT);
    expect(
      genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`),
      "a shipped definition stopped composing after the chair-budget fields were added — the change " +
        "was supposed to be additive-only",
    ).toEqual([]);
  });
});
