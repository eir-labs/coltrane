// RED-first contract tests — skills as first-class, COMPOSITION
// (docs/skills-as-first-class.md, "Composition"). An agent can load multiple skills per
// gig. composable_with declares valid pairings (invalid ones fail loudly at compose
// time). Execution order follows dependency — if B's input references A's output, A runs
// first. Skills sharing an output field must declare identical types. The agent sees one
// merged residual: everything no skill's code resolved.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { composeSkills, SkillCompositionCycleError } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const F = (slug: string) => join(REPO_ROOT, "tests/_skill_fixtures", slug);

describe("skill composition", () => {
  it("orders by dependency: B consumes A's output, so A runs first", () => {
    const r = composeSkills([F("compose-a"), F("compose-b")]);
    expect(r.order).toEqual(["compose-a", "compose-b"]);
  });

  it("dependency order is independent of the order skills are passed in", () => {
    const r = composeSkills([F("compose-b"), F("compose-a")]);
    expect(r.order).toEqual(["compose-a", "compose-b"]);
  });

  it("merges the residual across the composed skills (both fully code-resolve here)", () => {
    const r = composeSkills([F("compose-a"), F("compose-b")]);
    expect(r.merged_residual).toEqual([]);
  });

  it("detects a composition cycle and raises SkillCompositionCycleError — never deadlocks", () => {
    expect(() => composeSkills([F("cycle-x"), F("cycle-y")])).toThrow(SkillCompositionCycleError);
  });

  it("names the full cycle path (A → B → A), not just the re-entered node", () => {
    // a one-node message can't be regression-tested for the RIGHT cycle; the path can.
    let msg = "";
    try { composeSkills([F("cycle-x"), F("cycle-y")]); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/cycle-x/);
    expect(msg).toMatch(/cycle-y/);
    expect(msg, "path should be rendered with arrows and close the loop").toMatch(/→.*→/);
  });

  it("rejects an invalid pairing (not in composable_with) loudly", () => {
    expect(() => composeSkills([F("compose-a"), F("loner")])).toThrow(/composable_with|not composable/i);
  });

  it("rejects skills that share an output field with conflicting types", () => {
    expect(() => composeSkills([F("overlap-a"), F("overlap-b")])).toThrow(/type|overlap|conflict/i);
  });
});
