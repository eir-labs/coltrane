// RED — a scoped deny survives beside a scoped grant of the same tool.
//
// THE DEFECT. The Claude invoker assembles --disallowedTools from four sources and then removes
// anything the seat legitimately holds, "by exact name AND base name, so a scoped grant like
// `Bash(npx …)` still protects its `Bash`" (src/claude_invoker.ts, the NO OVER-DENIAL filter). The
// base-name half is right for a BARE deny like `Write`. Applied to a SCOPED deny it is wrong:
// `Write(tests/**)` has base name `Write`, so any `Write(src/**)` grant deletes it. A seat can
// therefore never be granted `src/**` while denied `tests/**` — the one shape a builder that must
// not weaken its own laws needs.
//
// MEASURED on 2026-09-16 through the invoker's `run` seam, for red-spec-builder
// (Write(src/**), Edit(src/**), …): --disallowedTools carries no Write or Edit entry at any
// code_tool_access level. tests/** is excluded only by allow-scoping, and this repo has recorded
// --allowedTools as advisory under `claude -p` (gig 782e89d8). The verifier's weakened-law check is
// the only thing standing between a builder and its own laws.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker, type Agent } from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

function builder(over: Partial<Agent>): Agent {
  return {
    ...TEST_BEHAVIOR,
    slug: "builder",
    primitives: ["CREATE"],
    input_types: [],
    output_types: ["built-thing"],
    domain: "demo",
    ...over,
  } as Agent;
}

async function spawnFlags(agent: Agent): Promise<{ allowed: string[]; disallowed: string[] }> {
  let args: string[] = [];
  const invoke = makeClaudeInvoker({
    toolProviders: new Map(),
    mcpServerConfigs: {},
    run: (_bin, a) => {
      args = a;
      return "{}";
    },
  });
  try {
    await invoke({ agent, phase: "build", inputs: [], gig_input: {} });
  } catch {
    // The canned "{}" transcript may not satisfy the seal; only the spawn flags matter here.
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1]!.split(",") : [];
  };
  return { allowed: flag("--allowedTools"), disallowed: flag("--disallowedTools") };
}

describe("a scoped deny survives beside a scoped grant of the same tool", () => {
  it("LAW 1 — Write(tests/**) is denied while Write(src/**) is granted", async () => {
    const { allowed, disallowed } = await spawnFlags(
      builder({ allowed_tools: ["Read", "Write(src/**)", "Edit(src/**)"], disallowed_tools: ["Write(tests/**)", "Edit(tests/**)"], code_tool_access: "full" }),
    );
    expect(allowed, "the scoped grant itself went missing").toContain("Write(src/**)");
    expect(disallowed, "the declared scoped deny was dropped because Write(src/**) shares its base name").toContain("Write(tests/**)");
    expect(disallowed).toContain("Edit(tests/**)");
  });

  it("LAW 2 (control) — a BARE deny of a tool the seat holds in scoped form is still not emitted", async () => {
    // Green today. This is the protection the base-name filter exists for: code_tool_access "read"
    // puts a bare `Write` on the deny list, and emitting it would kill the Write(src/**) grant too.
    // A fix for LAW 1 must keep this.
    const { disallowed } = await spawnFlags(
      builder({ allowed_tools: ["Read", "Write(src/**)"], code_tool_access: "read" }),
    );
    expect(disallowed, "a bare Write deny was emitted over a scoped Write grant").not.toContain("Write");
  });
});
