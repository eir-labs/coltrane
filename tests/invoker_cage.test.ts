// O25 — the blast-radius cage. The spawned claude must NOT inherit the host's ambient
// tools: every gig gets --strict-mcp-config + a per-gig --mcp-config (deny ambient MCP),
// and --allowedTools/--disallowedTools scope the surface to the agent's declared grant.
// This is what makes "add a standard that uses playwright" SAFE — the agent declares
// allowed_tools and the spawn is caged to exactly that. Ports OG's claude-launcher.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR, testAgent } from "./_support/agents.js";
import { buildInvokerArgs, makeClaudeInvoker } from "../src/claude_invoker.js";
import { defineAgent, type Agent } from "../src/composition.js";
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
  it("a playwright agent is caged to exactly its tools, and the per-gig mcp-config is written then cleaned", async () => {
    const agent = defineAgent({ ...TEST_BEHAVIOR,
      slug: "browser-scout", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo",
      allowed_tools: ["mcp__playwright__browser_navigate"],
    });
    let sawArgs: string[] = [];
    const invoke = makeClaudeInvoker({
      run: (_bin, args) => { sawArgs = args; return '{"text":"saw the page"}'; },
    });
    const ctx = { agent, gig_input: { url: "x" }, inputs: [] } as unknown as AgentInvocationContext;
    const out = await invoke(ctx);
    expect(out).toEqual({ text: "saw the page" });
    // caged: only playwright's nav tool, ambient MCP denied
    expect(sawArgs.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(sawArgs[sawArgs.indexOf("--allowedTools") + 1]).toBe("mcp__playwright__browser_navigate");
    expect(sawArgs).toContain("--strict-mcp-config");
  });
});

describe("the tool ceiling BINDS by enforcement, not omission (deny-side synthesis)", () => {
  // --allowedTools is advisory for host builtins: measured, a session granted only `type_browse`
  // still called Bash and Read, with nothing refusing or recording it — gig 782e89d8 (room-prober,
  // granted exactly ["type_browse"], reached Bash and Read; it did it again on a later run). ONLY
  // --disallowedTools removes a builtin, so an agent's UNGRANTED host builtins must be synthesized
  // into --disallowedTools as the complement of its effective grant set. Drive the injected-run seam
  // and read back the constructed --disallowedTools.
  const denyList = async (agent: Agent): Promise<Set<string>> => {
    let deny: string[] = [];
    const invoke = makeClaudeInvoker({
      run: (_bin, args) => {
        const i = args.indexOf("--disallowedTools");
        deny = i === -1 ? [] : (args[i + 1]?.split(",") ?? []);
        return '{"text":"ok"}';
      },
    });
    await invoke({ agent, gig_input: {}, inputs: [] } as unknown as AgentInvocationContext);
    return new Set(deny);
  };

  it("LAW 1 — an agent granted only ['type_browse'] DENIES Bash (RED against pre-patch code)", async () => {
    // RED before the fix: disallowed_tools defaults to [] and buildInvokerArgs pushes --disallowedTools
    // only when non-empty (claude_invoker.ts), so the flag is ABSENT entirely and 'Bash' is not denied.
    // That is precisely the gig-782e89d8 defect — the flag that binds is missing on every default agent.
    const agent = testAgent({ slug: "room-prober", primitives: ["SENSE"], output_types: ["Signal"], allowed_tools: ["type_browse"] });
    const deny = await denyList(agent);
    expect(deny.has("Bash")).toBe(true);
    expect(deny.has("Read")).toBe(true); // the OTHER ungranted builtin the gig showed room-prober reaching
    expect(deny.has("type_browse")).toBe(false); // never deny what the agent WAS granted
  });

  it("LAW 3 — a declared disallowed_tools is PRESERVED: the synthesized set is a UNION, not a replacement", async () => {
    // The declared name must survive alongside the synthesized ungranted builtin. Pass-through of the
    // declaration already held; the RED half is the synthesized 'Bash' the union must also carry.
    const agent = testAgent({ slug: "narrow", primitives: ["SENSE"], output_types: ["Signal"],
      allowed_tools: ["type_browse"], disallowed_tools: ["SomeTool"] });
    const deny = await denyList(agent);
    expect(deny.has("SomeTool")).toBe(true); // declared — survives the union
    expect(deny.has("Bash")).toBe(true);     // synthesized — an ungranted host builtin
  });
});

describe("the deny-side synthesis runs AFTER the seal grant — output_write is never denied (LAW 2)", () => {
  // On the output_write seal path the invoker adds OUTPUT_WRITE_TOOL (mcp__coltrane__output_write) to
  // effectiveAllowed — the seal is engine mechanism, not an optional capability. The complement
  // synthesis MUST run AFTER that addition; a synthesis that ran BEFORE it would deny every model
  // chair the very tool it must call to seal, failing every gig at the last step. A minimal stream-json
  // transcript standing in for the spawned claude carries one passing output_write so the invoker does
  // not fail the (unrelated) empty-seal check while we read the constructed args.
  const STREAM = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_ok", name: "mcp__coltrane__output_write",
      input: { core_type: "Signal", domain_type: "raw-note", gig_id: "g1", phase: "sense", agent_slug: "sensor", data: { source: "fixture://x" } } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_ok", is_error: false, content: "{\"validated\":true}" }] } },
    { type: "result", subtype: "success", is_error: false, result: "sealed" },
  ].map((e) => JSON.stringify(e)).join("\n");

  it("output_write IS advertised in --allowedTools yet ABSENT from --disallowedTools on the seal path", async () => {
    let deny: string[] = [];
    let allowed: string[] = [];
    const invoke = makeClaudeInvoker({
      sealVia: "output_write",
      // Supplying the engine server config is what makes the invoker add OUTPUT_WRITE_TOOL to
      // effectiveAllowed (claude_invoker.ts) — the exact addition the synthesis must run after.
      mcpServerConfigs: { coltrane: { command: "node", args: ["server_entry.js"] } },
      run: (_bin, args) => {
        const di = args.indexOf("--disallowedTools");
        deny = di === -1 ? [] : (args[di + 1]?.split(",") ?? []);
        const ai = args.indexOf("--allowedTools");
        allowed = ai === -1 ? [] : (args[ai + 1]?.split(",") ?? []);
        return STREAM;
      },
    });
    const agent = testAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"] });
    await invoke({ agent, phase: "sense", gig_id: "g1", output_types: ["raw-note"], gig_input: {}, inputs: [] } as unknown as AgentInvocationContext);
    expect(allowed).toContain("mcp__coltrane__output_write"); // the seal grant IS advertised…
    expect(deny).not.toContain("mcp__coltrane__output_write"); // …and is NEVER denied
  });
});

describe("the cage floor: a cloned repository cannot configure the seat that reads it", () => {
  // A seat's cwd is a freshly cloned repo — drain-loop.sh clones per gig and runs the engine inside
  // it — so everything the repo carries is untrusted input. Verified against the CLI (2.1.x) rather
  // than assumed: without this flag, `.claude/settings.json` hooks EXECUTE (arbitrary commands, no
  // model in the loop) and CLAUDE.md is obeyed as instructions.
  //
  // That turned one gig's write access into every later gig's code execution — a persistent
  // compromise whose carrier is a file, so no credential scoping can see it.
  it("loads user settings only, never the working tree's", () => {
    const args = buildInvokerArgs("prompt", "/tmp/cfg.json", {});
    const i = args.indexOf("--setting-sources");
    expect(i, "--setting-sources must be passed on every spawn").toBeGreaterThan(-1);
    // `project` and `local` are precisely the untrusted halves. Coltrane loses nothing by excluding
    // them: an agent's identity, method and constraints come from the genome in the store, never
    // from a file in the working tree. A repo that could redefine the agent reading it would be
    // editing the genome through the back door.
    expect(args[i + 1]).toBe("user");
  });
});
