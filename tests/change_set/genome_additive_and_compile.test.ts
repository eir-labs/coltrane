// RED — the schema touch is ADDITIVE, the whole shipped genome still loads and composes, and the
// seam compiles so red comes from failing assertions, never a type error.
//
// Covers I6 (domain_types/change-request.json carries an OPTIONAL change_set_branch property, and
// every pre-existing change-request still parses loss-free), I15 (every shipped agent, standard,
// chart, venue and institution file loads and composes unchanged after the change), and I16 (the
// seam compiles as real symbols — the discipline that keeps the whole spec's red coming from
// thrown stubs / failing assertions, not from a TS compile error).
//
// I6 and I15 are RED because the additive field and the retarget have not landed yet; they go
// green only when the change is applied ADDITIVELY — a non-additive break would surface as a
// load_error and keep them red. I16 is a durable compile-discipline guard: it stays green before
// and after the implementation, and fails only if a seam symbol is missing or mis-typed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../../src/index.js";
import { DomainTypeSchema } from "../../src/genome_schema.js";
import * as seam from "../../src/change_set_branch.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("change-request carries an additive optional change_set_branch (I6)", () => {
  const raw = JSON.parse(
    readFileSync(join(REPO_ROOT, "domain_types", "change-request.json"), "utf8"),
  ) as { schema: { properties: Record<string, unknown> }; required_fields: string[] };

  it("I6 declares a change_set_branch property so the implementation branch can be CARRIED", () => {
    expect(
      raw.schema.properties.change_set_branch,
      "change-request has no change_set_branch property — the implementation run would have to " +
        "INFER its branch from the working tree, which is how a run lands on the wrong branch silently",
    ).toBeDefined();
  });

  it("I6 the new property is OPTIONAL — additive, so every existing change-request still parses", () => {
    expect(
      raw.required_fields,
      "change_set_branch must be optional; forcing it would break every existing change-request",
    ).not.toContain("change_set_branch");
    // and the domain type itself still parses loss-free through its class.
    const parsed = DomainTypeSchema.parse(raw) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      expect(parsed[k], `authored field "${k}" did not survive the parse`).toEqual(v);
    }
  });
});

describe("the whole shipped genome loads and composes unchanged after the change (I15)", () => {
  const genome = loadGenome(REPO_ROOT);

  it("I15 loads with no errors — the schema touch broke no shipped file", () => {
    expect(
      genome.load_errors.map((e) => `${e.kind} ${e.slug ?? e.path}: ${e.error}`),
      "a load error means a shipped agent/standard/chart/venue/institution no longer composes",
    ).toEqual([]);
  });

  it("I15 both retargeted standards still compose from the genome", () => {
    expect(genome.standards.has("spec-drafting-v1"), "spec-drafting-v1 did not compose").toBe(true);
    expect(genome.standards.has("software-change-pr-v1"), "software-change-pr-v1 did not compose").toBe(true);
  });

  it("I15 the additive change_set_branch is present on the loaded change-request type", () => {
    // Bound to the additive touch so this guard reds until the change lands — and only stays green
    // if the field was added WITHOUT breaking the load above.
    const changeRequest = [...genome.domain_types.values()].find((t) => t.slug === "change-request");
    expect(changeRequest, "change-request type missing from the genome").toBeDefined();
    const props = (changeRequest!.schema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.change_set_branch, "the loaded change-request type has no change_set_branch").toBeDefined();
  });
});

describe("the change-set-branch seam compiles as real symbols (I16)", () => {
  it("I16 every function the red tests call exists — red is a thrown stub, not a missing symbol", () => {
    for (const name of [
      "deriveChangeSetBranch",
      "parseOriginatingGig",
      "isChangeSetBranch",
      "specPrBase",
      "implPrBase",
      "ensureChangeSetBranch",
      "assertBasePublishable",
      "resolveImplementationBranch",
    ] as const) {
      expect(typeof seam[name], `seam export "${name}" is not a function`).toBe("function");
    }
    expect(typeof seam.ChangeSetTrigger).toBe("function"); // a class
    expect(typeof seam.ChangeSetBranchMachine).toBe("function"); // a class
  });

  it("I16 the seam's constants are the values the spec pins", () => {
    expect(seam.PROTECTED_MAIN_LINE).toBe("main");
    expect(seam.CHANGE_SET_BRANCH_PREFIX).toBe("changeset/");
    expect(seam.IMPLEMENTATION_STANDARD).toBe("software-change-pr-v1");
  });
});
