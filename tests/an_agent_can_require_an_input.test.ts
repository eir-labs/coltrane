// RED-first spec for: "an agent can declare an input it CANNOT WORK WITHOUT, and composeStandard
// refuses at compose time any chair that seats it without one."
//
// Agent.input_types is a CAPABILITY ENVELOPE — src/composition.ts:530 checks "what THIS PLACEMENT
// actually consumes, not the agent's GLOBAL input_types", and the runtime floor at runtime.ts:2315
// is deliberately `.some`, not `.every`. Nothing today lets an agent say "I REQUIRE X in EVERY
// placement", so nothing checks it: code-implementer declares input_types ["change-plan","red-spec"]
// yet composed for weeks on a chair whose input_contract was ["change-plan"] only.
//
// These laws are RED by design. The enforcement they demand does not exist yet:
//   - AgentSchema (src/genome_schema.ts) has no `required_inputs` field and no cross-field rule
//     tying it to input_types, so `AgentSchema.parse` accepts anything and drops the unknown key.
//   - composeStandard (src/composition.ts) has no compose-time refusal reading required_inputs.
// Each test targets the REAL callsite (composeStandard / AgentSchema.parse / loadGenome), so it can
// only pass once the field and the refusal are built — never for a tautological reason.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  composeStandard,
  defineAgent,
  loadGenome,
  CompositionError,
  type Agent,
} from "../src";
import { AgentSchema } from "../src/genome_schema.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── Fixtures ────────────────────────────────────────────────────────────────
// A PLAN chair upstream so a CREATE write chair passes the §3 reasoning check and the input_contract
// "change-plan" it declares is genuinely produced upstream. This keeps the synthetic standard valid
// on EVERY other composition law, so the ONLY thing that can make it throw is the missing required
// input — i.e. the test is RED for exactly the contract reason, not for an unrelated defect.
const planner = () =>
  defineAgent({
    ...testAgentBase("planner"),
    primitives: ["PLAN"],
    input_types: [],
    output_types: ["change-plan"],
  });

function testAgentBase(slug: string) {
  return {
    slug,
    identity: "test agent",
    method: "perform the test task",
    constraints: [] as string[],
    behavioral_primitives: ["executor", "critic"] as ["executor", "critic"],
  };
}

/**
 * Build a two-phase standard: plan → write. The write chair seats `writer` with the given
 * input_contract. When `writer` declares required_inputs ["red-spec"] and the input_contract omits
 * it, composeStandard must refuse.
 */
function standardSeating(writer: Agent, writeInputContract: readonly string[]) {
  return {
    slug: "syn-required-input",
    domain: "eirtests",
    // "red-spec" is a gig input to the standard, so a chair MAY legitimately consume it — exactly as
    // the shipped standards produce it upstream (draft-laws). This makes the input_contract-satisfaction
    // law pass for the SATISFIED case, so the only thing that can refuse the chair is the new
    // required_inputs rule and nothing else.
    input_types: ["change-plan", "red-spec"],
    agents: [planner(), writer],
    phases: [
      {
        name: "plan",
        chairs: [
          {
            role: "plan",
            agent_slug: "planner",
            depends_on: [],
            input_contract: [],
            output_contract: ["change-plan"],
            required_skills: [],
          },
        ],
      },
      {
        name: "write",
        chairs: [
          {
            role: "write-change",
            agent_slug: writer.slug,
            depends_on: ["plan"],
            input_contract: writeInputContract,
            output_contract: ["change-set"],
            required_skills: [],
          },
        ],
      },
    ],
  };
}

/** A CREATE writer that REQUIRES red-spec in every placement (red-spec is inside its envelope). */
function requiringWriter(): Agent {
  return Object.assign(
    defineAgent({
      ...testAgentBase("writer"),
      primitives: ["CREATE"],
      input_types: ["change-plan", "red-spec"],
      output_types: ["change-set"],
    }),
    { required_inputs: ["red-spec"] },
  ) as Agent;
}

/** The same writer, declaring NO required_inputs — the negative-control shape. */
function unconstrainedWriter(): Agent {
  return defineAgent({
    ...testAgentBase("writer"),
    primitives: ["CREATE"],
    input_types: ["change-plan", "red-spec"],
    output_types: ["change-set"],
  });
}

// ── INV-COMPOSE-REFUSES-OMITTED ───────────────────────────────────────────────
// composeStandard REFUSES a chair whose input_contract omits a seated agent's required_inputs.
describe("required_inputs — compose-time refusal", () => {
  it("INV-COMPOSE-REFUSES-OMITTED: refuses a chair that omits a seated agent's required input", () => {
    // write-change seats a writer requiring "red-spec" but its input_contract is ["change-plan"] only.
    const bad = standardSeating(requiringWriter(), ["change-plan"]);
    expect(() => composeStandard(bad)).toThrow(CompositionError);
  });

  // INV-MESSAGE-NAMES-ALL — the refusal is actionable: it names the standard, the chair, the agent,
  // the missing type, and the fix (modelled on the dead-slot refusal at composition.ts:352-358).
  it("INV-MESSAGE-NAMES-ALL: the refusal names standard, chair, agent, missing type, and the fix", () => {
    const bad = standardSeating(requiringWriter(), ["change-plan"]);
    let err: unknown;
    try {
      composeStandard(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompositionError);
    const msg = err instanceof Error ? err.message : "";
    expect(msg).toContain("syn-required-input"); // the standard slug
    expect(msg).toContain("write-change"); // the chair role
    expect(msg).toContain("writer"); // the agent slug
    expect(msg).toContain("red-spec"); // the missing required input type
    expect(msg).toContain("input_contract"); // the fix: supply it on the chair's input_contract
  });

  it("INV-COMPOSE-ACCEPTS-SATISFIED: accepts the chair once its input_contract carries the required input", () => {
    // Same writer, but the chair now supplies "red-spec" — the requirement is met, so no refusal.
    const good = standardSeating(requiringWriter(), ["change-plan", "red-spec"]);
    expect(() => composeStandard(good)).not.toThrow();
  });
});

// ── INV-NO-OVER-REFUSAL (negative control) ────────────────────────────────────
// An agent declaring NO required_inputs is never refused on this path — a chair may legitimately
// omit part of the agent's input_types envelope. Must stay GREEN before AND after the change.
describe("required_inputs — no over-refusal", () => {
  it("INV-NO-OVER-REFUSAL: a chair omitting an envelope input is fine when the agent requires nothing", () => {
    // writer's envelope is ["change-plan","red-spec"]; the chair consumes only ["change-plan"].
    const control = standardSeating(unconstrainedWriter(), ["change-plan"]);
    expect(() => composeStandard(control)).not.toThrow();
  });
});

// ── INV-SCHEMA-SUBSET ─────────────────────────────────────────────────────────
// The cross-field rule lives at the SCHEMA layer (fails at parse/define/load), not at compose:
// every entry of required_inputs MUST also appear in input_types. An agent that requires an input
// outside its own capability envelope is malformed, not merely un-composable.
describe("required_inputs — schema cross-field rule", () => {
  it("INV-SCHEMA-SUBSET: AgentSchema.parse rejects a required_inputs entry absent from input_types", () => {
    expect(() =>
      AgentSchema.parse({
        ...testAgentBase("bad"),
        primitives: ["CREATE"],
        input_types: ["change-plan"], // "red-spec" is NOT here …
        output_types: ["change-set"],
        required_inputs: ["red-spec"], // … but is required → malformed
      }),
    ).toThrow();
  });

  it("INV-SCHEMA-SUBSET-OK: AgentSchema.parse accepts required_inputs that is a subset of input_types", () => {
    expect(() =>
      AgentSchema.parse({
        ...testAgentBase("ok"),
        primitives: ["CREATE"],
        input_types: ["change-plan", "red-spec"],
        output_types: ["change-set"],
        required_inputs: ["red-spec"],
      }),
    ).not.toThrow();
  });
});

// ── INV-SCHEMA-OPTIONAL ───────────────────────────────────────────────────────
// required_inputs is OPTIONAL everywhere: an agent record that omits it round-trips unchanged.
// This guards the non-goal "required_inputs optional everywhere" — GREEN before and after.
describe("required_inputs — optional everywhere", () => {
  it("INV-SCHEMA-OPTIONAL: an agent record with no required_inputs parses without error", () => {
    expect(() =>
      AgentSchema.parse({
        ...testAgentBase("plain"),
        primitives: ["CREATE"],
        input_types: ["change-plan"],
        output_types: ["change-set"],
      }),
    ).not.toThrow();
  });
});

// ── INV-CALIBRATION-GREEN ──────────────────────────────────────────────────────
// The calibration gate: once code-implementer declares required_inputs ["red-spec"], the WHOLE
// shipped genome must still compose. Both standards that seat code-implementer (software-change-pr-v1,
// software-change-red-first-v0) already carry "red-spec" in the write-change chair's input_contract,
// so loadGenome must report ZERO standard load_errors. If the analysis were wrong — a chair seating
// code-implementer without red-spec — the new refusal would fire here and this gate would go RED.
describe("required_inputs — shipped genome calibration", () => {
  it("INV-CALIBRATION-GREEN: the shipped genome composes with no standard load_errors", () => {
    const g = loadGenome(REPO_ROOT);
    const standardErrors = g.load_errors.filter((e) => e.kind === "standard");
    expect(standardErrors).toEqual([]);
    expect(g.standards.has("software-change-pr-v1")).toBe(true);
    expect(g.standards.has("software-change-red-first-v0")).toBe(true);
  });
});
