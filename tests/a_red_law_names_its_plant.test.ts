// A RED LAW NAMES WHAT IT DRIVES AND THE PRODUCTION DEFECT THAT TURNS IT RED — OR IT IS NOT SEALED.
//
// The defect this closes is the one this repo's CLAUDE.md names as the one it keeps producing: a
// green check that could never have been red. Here it arrives one level earlier, at AUTHORSHIP. A
// red-spec's coverage_map said only {invariant_id, test_name, test_file}: that a law EXISTS for each
// invariant, never what it CALLS or what breakage it can SEE. So a law that reads source for a token,
// calls a stand-in, or builds its own copy of the thing it guards sealed exactly like one that drives
// production. Measured on one work order, three lanes: nine laws that read source stayed 30/30 green
// under five planted defects in the call sites they claimed to guard; a law mutated an in-memory
// constant instead of the genome file it named; eight laws grepped call sites for the mechanism. Each
// passed its seal, and each was caught only by adversarial review after publication.
//
// red-spec v5 makes the law's aim part of the record: every coverage_map entry REQUIRES `kind`
// (behavioural | structural), `drives` (the production symbol, with its file) and `plant` (the
// smallest PRODUCTION edit that must turn it red); `plant_observed` records what the drafter saw; a
// structural law must say why no behavioural law could express the invariant. The drafter plants,
// watches the red, and reverts before sealing.
//
// These laws DRIVE the seal: the registry's validate() over the genome's real red-spec type (the check
// outputs.write runs before anything is sealed), and the output store's write() itself.
//
//   law                              kind         drives                                    plant (observed red, then reverted)
//   names kind, drives and plant     behavioural  registry.validate + outputs.write — red-spec  drop "plant" from coverage_map.items.required in
//                                                  v5 in domain_types/red-spec.json          domain_types/red-spec.json
//   kind is exactly the two          behavioural  same                                      drop the `enum` from coverage_map.items.kind
//   structural says why              behavioural  same                                      delete coverage_map.items.allOf
//   the seats that seal it plant     structural   agents/red-spec-drafter.json,             delete step 6's PLANT sentence from the drafter's method
//                                                  agents/red-spec-attester.json method
//
// The last law is structural because the obligation IS text: a method is prose handed to a model,
// and nothing executes it but the model. What the engine can refuse, the first three laws refuse.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore, OutputStoreError } from "../src/outputs.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const genome = loadGenome(REPO_ROOT);
const registry = createRegistry([...genome.domain_types.values()] as never);

const LAW = {
  invariant_id: "I1",
  test_name: "a law > holds",
  test_file: "tests/x.test.ts",
  kind: "behavioural",
  drives: "createRegistry(...).validate — src/registry.ts",
  plant: "return { valid: true } from validate() in src/registry.ts",
  plant_observed: "AssertionError: expected true to be false",
};

const redSpec = (entry: Record<string, unknown>) => ({
  validation_criteria: ["every invariant has a red law that names its plant"],
  input_refs: ["subsystem-contract-x"],
  laws: [{ path: "tests/x.test.ts", commit: "a".repeat(40) }],
  coverage_map: [entry],
  testing_method: "vitest, example-based",
});

const validate = (entry: Record<string, unknown>) =>
  registry.validate({ core_type: "Artifact", domain_type: "red-spec", data: redSpec(entry) } as never);

const without = (k: string) => Object.fromEntries(Object.entries(LAW).filter(([key]) => key !== k));

const seal = (entry: Record<string, unknown>) =>
  createOutputStore(registry).write({
    core_type: "Artifact", domain_type: "red-spec", domain: "spec-drafting", gig_id: "gig-plant",
    agent_slug: "red-spec-drafter", primitive: "CREATE", data: redSpec(entry),
  });

describe("a red law names what it drives and the defect that turns it red", () => {
  it("the genome's red-spec is v5 or later, and a law that names kind, drives and plant validates and SEALS", () => {
    expect(genome.domain_types.get("red-spec")?.version ?? 0, "the red-spec type on disk predates the plant").toBeGreaterThanOrEqual(5);
    const v = validate(LAW);
    expect(v.valid, `a fully-named law was refused: ${JSON.stringify(v.errors)}`).toBe(true);
    expect(() => seal(LAW), "the output store refused to seal a fully-named law").not.toThrow();
  });

  for (const field of ["kind", "drives", "plant"]) {
    it(`a law that does not name its \`${field}\` is refused at validate AND at the seal, by name`, () => {
      const v = validate(without(field));
      expect(v.valid, `a coverage_map entry with no \`${field}\` validated: a law that does not say ${field === "plant" ? "what defect turns it red" : "what it drives"} could seal`).toBe(false);
      expect(v.errors.join(" "), `the refusal must name \`${field}\``).toMatch(new RegExp(`'${field}'`));
      expect(() => seal(without(field)), `the output store sealed a law with no \`${field}\``).toThrow(OutputStoreError);
    });
  }

  it("`kind` is exactly behavioural | structural — a third word is refused", () => {
    const v = validate({ ...LAW, kind: "trust-me" });
    expect(v.valid, "a kind outside behavioural|structural validated").toBe(false);
    expect(v.errors.join(" ")).toMatch(/\/coverage_map\/0\/kind/);
  });

  it("a STRUCTURAL law must say why no behavioural law can express the invariant; a behavioural one need not", () => {
    const structural = { ...LAW, kind: "structural", drives: "agents/red-spec-drafter.json" };
    const bare = validate(structural);
    expect(bare.valid, "a structural law with no structural_reason validated — reading source would be the free default").toBe(false);
    expect(bare.errors.join(" "), "the refusal must name structural_reason").toMatch(/'structural_reason'/);
    const reasoned = validate({ ...structural, structural_reason: "the obligation is method prose; nothing executes it but the model" });
    expect(reasoned.valid, `a structural law WITH a reason was refused: ${JSON.stringify(reasoned.errors)}`).toBe(true);
    // Non-vacuity of the conditional: the SAME entry as behavioural needs no reason.
    expect(validate(LAW).valid).toBe(true);
  });

  it("the seats that seal a red-spec are told to plant: the drafter observes the red, the attester never invents one", () => {
    const drafter = genome.agents.get("red-spec-drafter");
    const attester = genome.agents.get("red-spec-attester");
    expect(drafter?.output_types, "red-spec-drafter no longer produces red-spec — this law is aimed at the wrong seat").toContain("red-spec");
    expect(attester?.output_types, "red-spec-attester no longer produces red-spec — this law is aimed at the wrong seat").toContain("red-spec");
    const dm = drafter?.method ?? "";
    expect(dm, "the drafter's method does not oblige it to PLANT each defect").toMatch(/PLANT: for each law, name the smallest edit to PRODUCTION code/);
    expect(dm, "the drafter's method does not oblige a behavioural law to CALL its `drives`").toMatch(/must CALL the production symbol \(`drives`\)/);
    expect(dm, "the drafter's method does not oblige it to revert the plant").toMatch(/revert the plant/);
    expect(dm, "the drafter's seal step does not carry kind/drives/plant into coverage_map").toMatch(/`kind`, `drives`, `plant`/);
    const am = attester?.method ?? "";
    expect(am, "the attester's coverage_map step does not carry kind/drives/plant").toMatch(/`kind`, `drives` and `plant`/);
    expect(am, "the attester may invent a plant the spec never stated").toMatch(/do not invent a plant/);
  });
});
