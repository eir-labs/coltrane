// RED-first — a CONTENT constraint must not make a standard structurally undispatchable.
//
// THE OUTAGE, measured. Commit 30d1b48 ("fix(red-spec): a patch field carries a patch, not a
// sentence about one") added `"pattern": "(^|\\n)[+-]"` to red-spec.diffs[].patch — a good fix, so a
// drafter cannot seal a prose summary where a diff belongs. It is on main.
//
// sealDrill synthesises a stub instance of every chair's output type and validates it, to refuse a
// structurally unsealable standard before spending on any chair (server.ts:839). Its string stub is
//
//     case "string": return "s".repeat(Math.max(1, minLength ?? 1));   // seal_drill.ts:28-31
//
// which honours enum, const and minLength — and NOT pattern. "sss" cannot match "(^|\n)[+-]", so the
// drill reports the type as unsealable and gig_dispatch REFUSES the standard outright. Three
// standards went undispatchable the moment that pattern landed:
//
//     software-change-pr-v1 · software-change-red-first-v0 · spec-drafting-v1
//
// which is the entire RED-first dev loop plus the spec-drafting pipeline. Nothing detected it,
// because the only server running had a genome loaded from BEFORE the commit and was still
// drilling against the old schema — the outage was invisible until a fresh process read the type.
//
// TWO THINGS ARE WRONG AND BOTH ARE FIXED HERE:
//   1. The stub ignores `pattern`. Where a pattern is simple enough to satisfy, the drill should
//      satisfy it rather than fail — the type IS sealable, the stub was just lazy.
//   2. A pattern the drill cannot synthesise must not be reported as CANNOT SEAL. A pattern is a
//      CONTENT constraint on what an agent writes; the drill exists to catch STRUCTURAL
//      unsealability — an unknown type, an impossible required set. Reporting "this standard cannot
//      seal" for a constraint a real agent satisfies every run is a false refusal, and a false
//      refusal that takes the change pipeline offline is worse than the check is good.
import { describe, it, expect } from "vitest";
import { stubForSchema, sealDrill } from "../src/seal_drill.js";
import { createRegistry, type DomainType } from "../src";

describe("the seal drill honours a pattern instead of failing on it", () => {
  it("D1 — a string stub SATISFIES a simple pattern rather than ignoring it", () => {
    // The exact constraint that took the pipeline down.
    const stub = stubForSchema({ type: "string", pattern: "(^|\\n)[+-]" }) as string;
    expect(new RegExp("(^|\\n)[+-]").test(stub)).toBe(true);
  });

  it("D2 — the pattern is honoured INSIDE a nested object and array, where the real one lives", () => {
    // red-spec's is at /diffs/0/patch — the stub builder must carry the constraint down, not only
    // handle a top-level string.
    const stub = stubForSchema({
      type: "object",
      required: ["diffs"],
      properties: {
        diffs: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "patch"],
            properties: { path: { type: "string" }, patch: { type: "string", pattern: "(^|\\n)[+-]" } },
          },
        },
      },
    }) as { diffs: Array<{ patch: string }> };
    expect(new RegExp("(^|\\n)[+-]").test(stub.diffs[0]!.patch)).toBe(true);
  });

  it("D3 — a standard whose output type carries a pattern is DISPATCHABLE", () => {
    // The regression itself, at the level the operator feels it.
    const patterned: DomainType = {
      slug: "patch-carrier", extends: "Artifact", domain: "test",
      schema: {
        type: "object",
        properties: { content: { type: "string" }, patch: { type: "string", pattern: "(^|\\n)[+-]" } },
        required: ["patch"],
      },
      required_fields: ["patch"],
    };
    const registry = createRegistry([patterned]);
    const drill = sealDrill(
      { phases: [{ name: "draft", chairs: [{ role: "draft", output_contract: ["patch-carrier"] }] }] },
      registry,
    );
    expect(drill.failures, "a content pattern must not read as structural unsealability").toEqual([]);
    expect(drill.ok).toBe(true);
  });

  it("D4 — an UNSATISFIABLE pattern still does not take the standard offline", () => {
    // The drill cannot synthesise every regex, and it must not pretend otherwise in either
    // direction: it neither invents a passing value nor condemns the standard. A pattern it cannot
    // satisfy is simply NOT DRILLED — the agent that writes the real value is the one that satisfies
    // it, every run, and has been all along.
    const impossible: DomainType = {
      slug: "impossible-carrier", extends: "Artifact", domain: "test",
      schema: {
        type: "object",
        properties: { content: { type: "string" }, weird: { type: "string", pattern: "^(?=.*A)(?=.*B)(?=.*C)[A-C]{9,}$" } },
        required: ["weird"],
      },
      required_fields: ["weird"],
    };
    const registry = createRegistry([impossible]);
    const drill = sealDrill(
      { phases: [{ name: "draft", chairs: [{ role: "draft", output_contract: ["impossible-carrier"] }] }] },
      registry,
    );
    expect(drill.ok, "an unsynthesisable pattern is not a structural defect").toBe(true);
  });

  // ── NON-VACUITY: the drill must still catch what it exists for ─────────────────────────────
  it("D5 — an UNKNOWN output type is still refused", () => {
    const drill = sealDrill(
      { phases: [{ name: "p", chairs: [{ role: "r", output_contract: ["no-such-type"] }] }] },
      createRegistry([]),
    );
    expect(drill.ok).toBe(false);
    expect(drill.failures[0]!.errors.join(" ")).toMatch(/unknown domain type/i);
  });

  it("D6 — a type whose REQUIRED field the stub cannot produce is still refused", () => {
    // The drill's actual job: a required field with a contradictory type is structural, and must
    // keep failing. A fix that made the drill permissive everywhere would pass D1–D4 and be useless.
    const contradictory: DomainType = {
      slug: "contradictory", extends: "Artifact", domain: "test",
      schema: {
        type: "object",
        properties: { content: { type: "string" }, n: { type: "number", minimum: 10, maximum: 1 } },
        required: ["n"],
      },
      required_fields: ["n"],
    };
    const drill = sealDrill(
      { phases: [{ name: "p", chairs: [{ role: "r", output_contract: ["contradictory"] }] }] },
      createRegistry([contradictory]),
    );
    expect(drill.ok, "a contradictory numeric bound is structural and must still fail").toBe(false);
  });
});
