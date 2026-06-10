// Behavioral defaults for test agents that don't exercise the behavioral layers. The
// runtime now REQUIRES identity/method/constraints/behavioral_primitives on every agent;
// tests that only care about primitives/composition spread these to stay focused.
import { defineAgent, type Agent, type AgentDef, type BelbinRole } from "../../src/composition.js";

export const TEST_BEHAVIOR: Pick<AgentDef, "identity" | "method" | "constraints" | "behavioral_primitives"> = {
  identity: "test agent",
  method: "perform the test task",
  constraints: [],
  behavioral_primitives: ["analyst", "synthesizer"] as BelbinRole[],
};

/** An AgentDef with behavioral defaults filled — override anything via `o`. */
export const agentDef = (o: Partial<AgentDef> & Pick<AgentDef, "slug" | "primitives">): AgentDef => ({
  ...TEST_BEHAVIOR,
  ...o,
});

/** A validated Agent with behavioral defaults filled. */
export const testAgent = (o: Partial<AgentDef> & Pick<AgentDef, "slug" | "primitives">): Agent => defineAgent(agentDef(o));
