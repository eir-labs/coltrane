// O25 — the blast-radius cage. The spawned claude must NOT inherit the host's ambient
// tools: every gig gets --strict-mcp-config + a per-gig --mcp-config (deny ambient MCP),
// and --allowedTools/--disallowedTools scope the surface to the agent's declared grant.
// This is what makes "add a standard that uses playwright" SAFE — the agent declares
// allowed_tools and the spawn is caged to exactly that. Ports OG's claude-launcher.
import { describe, it, expect } from "vitest";
import { buildInvokerArgs, makeClaudeInvoker } from "../src/claude_invoker.js";
import { defineAgent } from "../src/composition.js";
import type { AgentInvocationContext } from "../src/runtime.js";

describe("blast-radius cage: buildInvokerArgs (pure)", () => {
  it("ALWAYS denies ambient MCP — --strict-mcp-config + --mcp-config on every spawn", () => {
    const args = buildInvokerArgs("prompt", "/tmp/cfg.json", {});
    expect(args).toContain("--strict-mcp-config");
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("/tmp/cfg.json");
  });

  it("scopes the surface to the agent's allowed_tools / disallowed_tools grant", () => {
    const args = buildInvokerArgs("p", "/tmp/c.json", {
      allowed_tools: ["mcp__playwright__browser_navigate", "mcp__playwright__browser_click"],
      disallowed_tools: ["Bash"],
    });
    const a = args.indexOf("--allowedTools");
    expect(args[a + 1]).toBe("mcp__playwright__browser_navigate,mcp__playwright__browser_click");
    const d = args.indexOf("--disallowedTools");
    expect(args[d + 1]).toBe("Bash");
  });

  it("no declared grant → no --allowedTools flag, but still caged (strict + no ambient)", () => {
    const args = buildInvokerArgs("p", "/tmp/c.json", {});
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--strict-mcp-config"); // deny-by-default still holds
  });
});

describe("blast-radius cage: makeClaudeInvoker (seam, injectable spawn)", () => {
  it("a playwright agent is caged to exactly its tools, and the per-gig mcp-config is written then cleaned", () => {
    const agent = defineAgent({
      slug: "browser-scout", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo",
      allowed_tools: ["mcp__playwright__browser_navigate"],
    });
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({
      run: (_bin, args) => { sawArgs = args; return '{"text":"saw the page"}'; },
    });
    const ctx = { agent, gig_input: { url: "x" }, inputs: [] } as unknown as AgentInvocationContext;
    const out = invoke(ctx);
    expect(out).toEqual({ text: "saw the page" });
    // caged: only playwright's nav tool, ambient MCP denied
    expect(sawArgs.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(sawArgs[sawArgs.indexOf("--allowedTools") + 1]).toBe("mcp__playwright__browser_navigate");
    expect(sawArgs).toContain("--strict-mcp-config");
  });
});
