// RED-first contract tests — skills as first-class, the CHAIR INTEGRATION payoff
// (docs/skills-as-first-class.md, Phase 1). A chair can be backed by a skill package
// instead of an agent. A skill-backed chair runs the skill's deterministic code half in
// the permission-scoped subprocess — the model is NEVER invoked for it. This is the
// proper fix for the e2e-band problem ("an LLM should not babysit a deterministic
// command"): the deterministic step becomes a code chair, sealed like any other output.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  defineAgent,
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Chair,
  type PhaseDef,
  type AgentInvoker,
} from "../src";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NUMBER_ADDER = join(REPO_ROOT, "skills/number-adder");

function setup() {
  const registry = createRegistry();
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

// a skill-backed chair: skill_slug set, agent_slug empty (mutually exclusive)
function skillChair(role: string, skill_slug: string, opts: Partial<Chair> = {}): Chair {
  return {
    role,
    agent_slug: "",
    skill_slug,
    depends_on: opts.depends_on ?? [],
    input_contract: opts.input_contract ?? [],
    output_contract: opts.output_contract ?? ["Signal"],
    required_skills: [],
  };
}

describe("a chair backed by a skill runs deterministic code, not the model", () => {
  it("composes a standard with a skill-backed chair (skill_slug, no agent)", () => {
    expect(() =>
      composeStandard({
        slug: "deterministic-add",
        domain: "test",
        agents: [],
        phases: [{ name: "compute", chairs: [skillChair("adder", "number-adder")] } as PhaseDef],
      }),
    ).not.toThrow();
  });

  it("runs the skill's code half and seals its output — without ever invoking the model", async () => {
    const std = composeStandard({
      slug: "deterministic-add",
      domain: "test",
      agents: [],
      phases: [{ name: "compute", chairs: [skillChair("adder", "number-adder")] } as PhaseDef],
    });
    const { outputs, ledger } = setup();

    let modelCalls = 0;
    const invoke: AgentInvoker = () => {
      modelCalls++;
      return { value: "model should not run for a code chair" };
    };

    const res = await runGig(
      std,
      { a: 3, b: 5 },
      { outputs, ledger, invoke, skill_dirs: new Map([["number-adder", NUMBER_ADDER]]) },
    );

    expect(res.status).toBe("complete");
    expect(modelCalls, "the model was invoked for a deterministic skill chair").toBe(0);
    // the sealed output is the skill's deterministic result
    expect(res.outputs.length).toBe(1);
    expect(res.outputs[0]!.data).toEqual({ sum: 8 });
    // and it's recorded in the ledger like any other output
    expect(ledger.count()).toBe(1);
    // the sealed entry carries the skill's identity (slug + version + verified code_hash + tier),
    // so an audit can trace this output back to the exact skill that produced it — the chair→skill
    // provenance edge, not just the slug in agent_slug.
    const prov = res.outputs[0]!.skill_provenance;
    expect(prov, "skill-backed output is missing skill_provenance").toBeTruthy();
    expect(prov!.slug).toBe("number-adder");
    expect(prov!.version).toBe(1);
    expect(prov!.tier).toBe(0);
    expect(prov!.code_hash, "code_hash should be the verified on-disk hash").toMatch(/[0-9a-f]{16,}/);
  });

  it("a skill-backed chair feeds its deterministic output to a downstream agent chair", async () => {
    // adder (skill) -> reporter (agent). The agent must see the skill's {sum:8} as input.
    const reporter = defineAgent({ ...TEST_BEHAVIOR,
      slug: "reporter",
      primitives: ["INTERPRET"],
      input_types: ["Signal"],
      output_types: ["Interpretation"],
      skill_slugs: [],
    });
    const std = composeStandard({
      slug: "add-then-report",
      domain: "test",
      agents: [reporter],
      phases: [
        { name: "compute", chairs: [skillChair("adder", "number-adder", { output_contract: ["Signal"] })] } as PhaseDef,
        {
          name: "report",
          chairs: [
            {
              role: "reporter",
              agent_slug: "reporter",
              depends_on: ["adder"],
              input_contract: ["Signal"],
              output_contract: ["Interpretation"],
              required_skills: [],
            },
          ],
        } as PhaseDef,
      ],
    });
    const { outputs, ledger } = setup();
    let seenInput: unknown = null;
    const invoke: AgentInvoker = ({ inputs }) => {
      seenInput = inputs[0]?.data;
      return { note: "reported" };
    };
    await runGig(std, { a: 3, b: 5 }, { outputs, ledger, invoke, skill_dirs: new Map([["number-adder", NUMBER_ADDER]]) });
    expect(seenInput).toEqual({ sum: 8 });
  });
});
