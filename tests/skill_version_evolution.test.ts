// RED-first contract tests — skills as first-class, the TYPING GUARANTEE that makes
// version evolution safe (docs/skills-as-first-class.md, "The typing guarantee" +
// "Evolution"). A skill earns determinism over versions by resolving more of the output
// in code. What keeps that safe is the output schema as a hard boundary:
//   - code can only resolve fields that EXIST in the output schema (no smuggling)
//   - the residual is always a SUBSET of the output schema
//   - the model likewise cannot introduce fields the schema never declared
// Plus the evolution gate (covered in skill_fixtures): a candidate is accepted only if
// every fixture still passes — an "improvement" that regresses behavior is rejected.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveSkill, type ResidualInvoker } from "../src/skills.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const F = (slug: string) => join(REPO_ROOT, "tests/_skill_fixtures", slug);
const sentiment: ResidualInvoker = () => ({ sentiment: "positive" });

describe("the output schema bounds what any version may resolve", () => {
  it("drops an out-of-schema field the code half returns — code can't smuggle fields", async () => {
    const r = await resolveSkill(F("leaky-extract"), { text: "good day" }, sentiment);
    expect(r.output).toEqual({ char_count: 8, sentiment: "positive" });
    expect(r.output).not.toHaveProperty("secret");
    expect(Object.keys(r.field_origins)).not.toContain("secret");
  });

  it("the residual is a subset of the output schema (only declared fields are ever asked of the model)", async () => {
    let asked: readonly string[] = [];
    const r = await resolveSkill(F("leaky-extract"), { text: "good day" }, (ctx) => {
      asked = ctx.unresolved;
      return { sentiment: "positive" };
    });
    const schemaFields = ["char_count", "sentiment"];
    for (const f of asked) expect(schemaFields).toContain(f);
    for (const f of r.residual) expect(schemaFields).toContain(f);
  });

  it("ignores a model-produced field outside the schema — the model can't introduce fields either", async () => {
    const r = await resolveSkill(F("leaky-extract"), { text: "good day" }, () => ({
      sentiment: "positive",
      extra: "nope",
    }));
    expect(r.output).not.toHaveProperty("extra");
    expect(r.output).toHaveProperty("sentiment", "positive");
  });
});
