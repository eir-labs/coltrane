// RED — an amend round with the reuse cache wired must still RUN the maker and the verifier.
//
// FOUND BY READING (debate round 1, 2026-09-17): in the EXAMINE⇄AMEND loop the failing verdict is
// pushed into the maker's inputs only AFTER prepareChair returns (src/runtime.ts, the amend block:
// `prep.inputs.push(feedback)`), but prepareChair has already taken the reuse lookup over the
// round-1 inputs. The key is therefore identical to round 1's, so a gig dispatched with `reuse`
// is served its own failing artifact, the re-verify is served its own failing verdict, and every
// amend round is a silent no-op that ends "complete" with the first-round failure.
import { describe, it, expect } from "vitest";
import { coreInvariantFields } from "./_support/specs.js";
import { testAgent } from "./_support/agents.js";
import { createMemoryReuseStore } from "../src/reuse.js";
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

const t = (slug: string, ext: string): DomainType => ({
  slug, extends: ext, domain: "test", schema: { properties: { value: { type: "string" } } }, required_fields: [],
});

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug, depends_on: [], input_contract: [], output_contract: [], required_skills: [], ...opts,
});

function standard() {
  const planner = testAgent({ slug: "planner", primitives: ["PLAN"], input_types: [], output_types: ["plan-in"] });
  const maker = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["plan-in"], output_types: ["artifact"] });
  const verifier = testAgent({ slug: "verifier", primitives: ["VERIFY"], input_types: ["artifact"], output_types: ["verdict"] });
  return composeStandard({
    slug: "amend-with-reuse", domain: "test", agents: [planner, maker, verifier], max_examine_rounds: 2,
    phases: [
      { name: "plan", chairs: [chair("plan", "planner", { output_contract: ["plan-in"] })] },
      { name: "make", chairs: [chair("make", "maker", { depends_on: ["plan"], input_contract: ["plan-in"], output_contract: ["artifact"] })] },
      { name: "check", chairs: [chair("check", "verifier", { depends_on: ["make"], input_contract: ["artifact"], output_contract: ["verdict"] })] },
    ] as PhaseDef[],
  });
}

describe("an amend round is never served from the reuse cache", () => {
  it("with reuse wired, a failing verdict still re-runs the maker and the verifier, and the gig ends green", async () => {
    const registry = createRegistry();
    for (const [s, e] of [["artifact", "Artifact"], ["verdict", "Verdict"], ["plan-in", "Plan"]] as const) registry.registerType(t(s, e));

    let makerCalls = 0;
    let verifyCalls = 0;
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "planner") return { ...coreInvariantFields("Plan"), value: "plan" };
      if (agent.slug === "maker") {
        makerCalls++;
        return { ...coreInvariantFields("Artifact"), value: `art#${makerCalls}` };
      }
      verifyCalls++;
      return { ...coreInvariantFields("Verdict"), pass: verifyCalls >= 2, value: `verdict#${verifyCalls}` };
    };

    const res = await runGig(standard(), {}, {
      outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, gig_id: "gig-amend-reuse", reuse: createMemoryReuseStore(),
    });

    expect(makerCalls, "the amend round was served round 1's failing artifact from the cache").toBe(2);
    expect(verifyCalls, "the re-verify was served round 1's failing verdict from the cache").toBe(2);
    const last = res.outputs.filter((o) => o.domain_type === "verdict").at(-1);
    expect((last?.data as { pass?: boolean } | undefined)?.pass, "the gig ended on the first round's failure").toBe(true);
  });
});
