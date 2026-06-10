// RED-first contract tests — code_tool_access gating (full regression map).
//
// Old runtime gated Claude Code's built-in file/exec tools (Read/Write/Edit/Bash) per
// agent via code_tool_access (none/read/write/full). The new cage is purely an MCP-tool
// allowlist — code_tool_access has zero refs, so an agent's exposure to code tools isn't
// modeled at all. These pin the gate back onto the spawn's tool surface.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import type { Agent, AgentInvocationContext } from "../src";

function spawnArgs(agent: Agent): string[] {
  let captured: string[] = [];
  const invoker = makeClaudeInvoker({ run: (_b, args) => { captured = args; return '{"ok":true}'; } });
  void invoker({ agent, phase: "p", inputs: [], gig_input: {} } as AgentInvocationContext);
  return captured;
}
const flag = (args: string[], name: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : "";
};
const base = (over: Partial<Agent>): Agent => ({
  slug: "a", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "d", ...over,
});
const CODE_TOOLS = ["Read", "Write", "Edit", "Bash"];

describe("code_tool_access gates the Claude Code built-in file/exec tools", () => {
  it("'none' denies every code tool", () => {
    const denied = flag(spawnArgs(base({ code_tool_access: "none" })), "--disallowedTools");
    for (const t of CODE_TOOLS) expect(denied, `${t} not denied at access=none`).toContain(t);
  });

  it("'read' permits Read but denies Write/Edit/Bash", () => {
    const args = spawnArgs(base({ code_tool_access: "read" }));
    const denied = flag(args, "--disallowedTools");
    expect(denied).not.toContain("Read");
    for (const t of ["Write", "Edit", "Bash"]) expect(denied, `${t} not denied at access=read`).toContain(t);
  });

  it("'full' denies no code tool", () => {
    const denied = flag(spawnArgs(base({ code_tool_access: "full" })), "--disallowedTools");
    for (const t of CODE_TOOLS) expect(denied).not.toContain(t);
  });
});
