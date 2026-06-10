// RED-first contract tests — per-agent execution caps (full regression map).
//
// Old AgentPermissions carried max_tool_calls / max_token_budget, enforced per agent.
// The new cage (buildInvokerArgs) emits no --max-turns and no per-agent cap; budget
// enforcement moved to per-GIG (RunDeps.budget), so a single runaway agent can burn the
// whole gig's budget. These pin the per-agent cap back onto the spawn.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import type { Agent, AgentInvocationContext } from "../src";

function spawnArgs(agent: Agent): string[] {
  let captured: string[] = [];
  const invoker = makeClaudeInvoker({ run: (_b, args) => { captured = args; return '{"ok":true}'; } });
  void invoker({ agent, phase: "p", inputs: [], gig_input: {} } as AgentInvocationContext);
  return captured;
}
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (over: Partial<Agent>): Agent => ({
  slug: "a", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "d", ...over,
});

describe("an agent's max_tool_calls caps its spawn (no runaway burns the whole gig)", () => {
  it("emits --max-turns from the agent's max_tool_calls", () => {
    const args = spawnArgs(base({ max_tool_calls: 5 }));
    expect(flag(args, "--max-turns")).toBe("5");
  });

  it("the cap is per-agent — different agents get different caps", () => {
    const tight = flag(spawnArgs(base({ max_tool_calls: 3 })), "--max-turns");
    const loose = flag(spawnArgs(base({ max_tool_calls: 50 })), "--max-turns");
    expect(tight).toBe("3");
    expect(loose).toBe("50");
  });

  it("an agent with no cap declared spawns without a --max-turns flag (opt-in)", () => {
    const args = spawnArgs(base({}));
    expect(args).not.toContain("--max-turns");
  });
});
