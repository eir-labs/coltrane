// The examine⇄amend loop — enforcing max_examine_rounds.
//
// A standard's `max_examine_rounds` was declared-but-unenforced (composition.ts note): the
// engine seated a verify chair, sealed whatever verdict it produced, and moved on — a failing
// verdict was recorded, never acted on. So the pipeline could not iterate to green; that job
// fell to a human tail.
//
// This is the RED contract for the enforcement. The trigger is the ONE canonical fail signal
// every Verdict already carries: `pass === false`. When a VERIFY chair seals a failing verdict
// and rounds remain, the maker(s) it depends on (the CREATE seat that produced the artifact it
// judged) re-run — the AMEND — with the failing verdict fed back as input, and the verify chair
// re-runs. The loop is bounded by max_examine_rounds and terminates on `pass === true` or on
// rounds exhausted (then the gig completes honestly with the last, failing verdict — never a
// false green).
//
// These tests fail RED on today's engine: it runs each chair exactly once, so the maker never
// amends, the verifier never re-runs, and a first-round failure is the final word.

import { describe, it, expect } from "vitest";
import { coreInvariantFields } from "./_support/specs.js";
import { testAgent } from "./_support/agents.js";
import {
  composeStandard,
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type PhaseDef,
  type Chair,
  type AgentInvoker,
} from "../src";

const artifactType: DomainType = {
  slug: "artifact",
  extends: "Artifact",
  domain: "test",
  schema: { properties: { value: { type: "string" } } },
  required_fields: [],
};
const verdictType: DomainType = {
  slug: "verdict",
  extends: "Verdict",
  domain: "test",
  schema: { properties: { value: { type: "string" } } },
  required_fields: [],
};
const planType: DomainType = {
  slug: "plan-in",
  extends: "Plan",
  domain: "test",
  schema: { properties: { value: { type: "string" } } },
  required_fields: [],
};
const ctxType: DomainType = {
  slug: "ctx",
  extends: "Signal",
  domain: "test",
  schema: { properties: { value: { type: "string" } } },
  required_fields: [],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(artifactType);
  registry.registerType(verdictType);
  registry.registerType(planType);
  registry.registerType(ctxType);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { outputs, ledger };
}

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role,
  agent_slug,
  depends_on: [],
  input_contract: [],
  output_contract: [],
  required_skills: [],
  ...opts,
});

function makeStandard(max_examine_rounds?: number) {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const maker = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"] });
  const verifier = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-loop",
    domain: "test",
    agents: [planner, maker, verifier],
    ...(max_examine_rounds !== undefined ? { max_examine_rounds } : {}),
    phases: [
      { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
      { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
      { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

// A shared invoker maker: the planner emits a plan once, the maker/verifier behavior is
// supplied per test. `plan` never re-runs — only the maker amends.
function plannerOutput() {
  return { ...coreInvariantFields("Plan"), value: "plan" };
}

describe("examine⇄amend loop enforces max_examine_rounds", () => {
  it("a failing verdict amends the maker and re-verifies, then ends green within the round bound", async () => {
    const std = makeStandard(2);

    let makerCalls = 0;
    let verifyCalls = 0;
    let amendSawFailingVerdict = false;

    const invoke: AgentInvoker = ({ agent, inputs }) => {
      if (agent.slug === "planner") return plannerOutput();
      if (agent.slug === "maker") {
        makerCalls++;
        if (makerCalls > 1) {
          // The amend must receive the verdict that failed, so it can fix the right thing.
          amendSawFailingVerdict = inputs.some(
            (i) => i.domain_type === "verdict" && (i.data as { pass?: boolean }).pass === false,
          );
        }
        return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls}` };
      }
      // verifier: fail the first round, pass once amended.
      verifyCalls++;
      return { ...coreInvariantFields("Verdict"), pass: verifyCalls >= 2, value: `verdict#${verifyCalls}` };
    };

    const res = await runGig(std, {}, { ...setup(), invoke });

    expect(verifyCalls).toBe(2); // re-verified after the amend
    expect(makerCalls).toBe(2); // the maker amended once
    expect(amendSawFailingVerdict).toBe(true); // the failing verdict fed the amend
    const finalVerdict = res.outputs.filter((o) => o.domain_type === "verdict").at(-1);
    expect((finalVerdict?.data as { pass?: boolean } | undefined)?.pass).toBe(true);
    expect(res.status).toBe("complete");
  });

  it("exhausting the rounds completes honestly with the failing verdict — never a false green", async () => {
    const std = makeStandard(2);

    let makerCalls = 0;
    let verifyCalls = 0;

    // The verifier never passes. The loop must stop at the bound, not spin, and must NOT
    // launder the last verdict into a pass.
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "planner") return plannerOutput();
      if (agent.slug === "maker") {
        makerCalls++;
        return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls}` };
      }
      verifyCalls++;
      return { ...coreInvariantFields("Verdict"), pass: false, value: `verdict#${verifyCalls}` };
    };

    const res = await runGig(std, {}, { ...setup(), invoke });

    // 1 initial verify + 2 amend rounds = 3 verifications; the maker amends twice.
    expect(verifyCalls).toBe(3);
    expect(makerCalls).toBe(3);
    const finalVerdict = res.outputs.filter((o) => o.domain_type === "verdict").at(-1);
    expect((finalVerdict?.data as { pass?: boolean } | undefined)?.pass).toBe(false);
    expect(res.status).toBe("complete");
  });

  it("no max_examine_rounds means no loop — a single pass, unchanged behavior", async () => {
    const std = makeStandard(); // no rounds declared

    let makerCalls = 0;
    let verifyCalls = 0;
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "planner") return plannerOutput();
      if (agent.slug === "maker") {
        makerCalls++;
        return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls}` };
      }
      verifyCalls++;
      return { ...coreInvariantFields("Verdict"), pass: false, value: `verdict#${verifyCalls}` };
    };

    const res = await runGig(std, {}, { ...setup(), invoke });

    // Absent the bound, a failing verdict is sealed once and the gig completes — the amend
    // loop is opt-in via max_examine_rounds, never imposed.
    expect(makerCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(res.status).toBe("complete");
  });

  it("amends only the ARTIFACT-producing seat — a multi-primitive agent's plan seat is not re-run", async () => {
    // The realistic shape: ONE agent (like the quartet's bill) seats both the plan chair and the
    // write chair — its primitives are [PLAN, CREATE]. The amend must re-run only the seat that
    // produced the ARTIFACT the verdict judged (write), never the plan seat, whose plan is settled
    // for the run. Keying the amend on the agent's CREATE primitive would wrongly re-run both.
    const root = testAgent({ slug: "root2", primitives: ["SENSE"], input_types: [], output_types: ["ctx"] });
    const builder = testAgent({ slug: "builder", primitives: ["PLAN", "CREATE"], input_types: ["ctx", "plan-in"], output_types: ["plan-in", "artifact"] });
    const verifier = testAgent({ slug: "verifier2", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });
    const std = composeStandard({
      slug: "amend-precise",
      domain: "test",
      agents: [root, builder, verifier],
      max_examine_rounds: 2,
      phases: [
        { name: "sense", chairs: [chair("sense", "root2", { output_contract: ["ctx"] })] },
        { name: "plan", chairs: [chair("plan", "builder", { depends_on: ["sense"], input_contract: ["ctx"], output_contract: ["plan-in"] })] },
        { name: "make", chairs: [chair("make", "builder", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
        { name: "check", chairs: [chair("check", "verifier2", { depends_on: ["plan", "make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
      ] as PhaseDef[],
    });

    let planCalls = 0;
    let writeCalls = 0;
    let verifyCalls = 0;
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      if (agent.slug === "root2") return { ...coreInvariantFields("Signal"), value: "ctx" };
      if (agent.slug === "verifier2") {
        verifyCalls++;
        return { ...coreInvariantFields("Verdict"), pass: verifyCalls >= 2, value: `v#${verifyCalls}` };
      }
      // builder seats both plan and write — the write seat is the one consuming plan-in.
      if (inputs.some((i) => i.domain_type === "plan-in")) {
        writeCalls++;
        return { ...coreInvariantFields("Artifact"), value: `art#${writeCalls}` };
      }
      planCalls++;
      return { ...coreInvariantFields("Plan"), value: `plan#${planCalls}` };
    };

    await runGig(std, {}, { ...setup(), invoke });

    expect(writeCalls).toBe(2); // initial + one amend
    expect(planCalls).toBe(1); // the plan seat is settled — never re-run by the amend
    expect(verifyCalls).toBe(2);
  });
});
