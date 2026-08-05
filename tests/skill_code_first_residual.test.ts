// RED-first contract tests — skills as first-class, the CODE-FIRST / MODEL-RESIDUAL
// flow (docs/skills-as-first-class.md, "The runtime flow", Phase 2). This is the heart
// of the dual-artifact model and the part a naive "LLM chair OR code chair" split misses:
//   1. code runs first and resolves what it deterministically can
//   2. residual = output_schema - what the code resolved (computed, no separate schema)
//   3. the model reasons ONLY about the residual; resolved fields are handed in as
//      verified context (it must not re-derive them, and cannot override them)
//   4. the union is validated and every field is tagged code | model (field_origins)
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveSkill, type ResidualInvoker } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DUAL_EXTRACT = join(REPO_ROOT, "tests/_skill_fixtures/dual-extract");
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");

describe("code-first / model-residual resolution", () => {
  it("runs code first, hands the model only the residual, and merges the union", async () => {
    let seen: Parameters<ResidualInvoker>[0] | null = null;
    const invoke: ResidualInvoker = (ctx) => {
      seen = ctx;
      return { sentiment: "positive" };
    };

    const r = await resolveSkill(DUAL_EXTRACT, { text: "good day" }, invoke);

    // code resolved char_count deterministically; model resolved sentiment
    expect(r.output).toEqual({ char_count: 8, sentiment: "positive" });
    expect(r.resolved).toEqual({ char_count: 8 });
    expect(r.residual).toEqual(["sentiment"]);

    // the model was asked ONLY about the gap, and got the resolved field as context
    expect(seen).not.toBeNull();
    expect(seen!.unresolved).toEqual(["sentiment"]);
    expect(seen!.resolved).toEqual({ char_count: 8 });
    expect(seen!.md).toMatch(/sentiment/i);
  });

  it("tags every output field with its origin (code vs model)", async () => {
    const r = await resolveSkill(DUAL_EXTRACT, { text: "good day" }, () => ({ sentiment: "positive" }));
    expect(r.field_origins).toEqual({ char_count: "code", sentiment: "model" });
  });

  it("code-resolved fields are verified context — the model cannot override them", async () => {
    // the model tries to clobber char_count; the code's value must win
    const r = await resolveSkill(DUAL_EXTRACT, { text: "good day" }, () => ({
      char_count: 9999,
      sentiment: "neutral",
    }));
    expect(r.output.char_count).toBe(8);
    expect(r.field_origins.char_count).toBe("code");
  });

  it("a pure-code skill has an empty residual and never invokes the model", async () => {
    const invoke: ResidualInvoker = () => {
      throw new Error("model invoked for a fully code-resolved skill — residual should be empty");
    };
    const r = await resolveSkill(NUMBER_ADDER, { a: 3, b: 5 }, invoke);
    expect(r.output).toEqual({ sum: 8, source: "skill://number-adder@1" });
    expect(r.residual).toEqual([]);
    expect(r.field_origins).toEqual({ sum: "code", source: "code" });
  });
});
