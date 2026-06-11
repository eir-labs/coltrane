// The agent matrix — a data-driven permutation suite over the agent's prompt + cage.
//
// Instead of one hand-written test per scenario, we declare the AXES of variation and let
// pairwise() generate a small set of rows with full t=2 coverage. Each row builds an agent
// (through the single fixture factory) and asserts BOTH halves at once:
//   - the rendered prompt carries the behavioral load implied by the agent's fields
//   - the spawned cage args derive correctly from the agent's tier/cap/code-access
// Expectations are RULES (functions of the inputs), never hand-authored per cell — that's
// what makes a matrix more than imperative tests in a costume. Curated, golden-backed
// scenarios live in prompt_full_parity.test.ts; this is the combinatorial layer.
import { describe, it, expect } from "vitest";
import { buildPrompt, makeClaudeInvoker, MODEL_TIER_MAP, BELBIN_DESCRIPTIONS } from "../src";
import type { Agent, AgentInvocationContext } from "../src";
import { testAgent } from "./_support/agents.js";
import { pairwise } from "./_support/matrix.js";

// ── Axes of variation ──────────────────────────────────────────────────────────
const AXES = {
  disposition: [["explorer", "critic"], ["planner", "executor"], ["audience_modeler", "synthesizer"], ["analyst", "critic"]],
  depth: ["skim", "quick", "standard", "deep"],
  model_tier: ["economy", "standard", "premium"],
  code_access: ["none", "read", "write", "full"],
  tools: [[], ["web_search", "fetch_url"]],
  skills: [[], ["dedup-skill"]],
  cap: [undefined, 25, 80],
  constraints: [[], ["Never assert a fact you cannot cite."]],
} as const;

// ── Derivation rules (the oracle: independent expectations, not the impl) ─────────
const CODE_DENIALS: Record<string, string[]> = {
  none: ["Read", "Write", "Edit", "Bash"],
  read: ["Write", "Edit", "Bash"],
  write: ["Bash"],
  full: [],
};
const ALL_CODE_TOOLS = ["Read", "Write", "Edit", "Bash"];

// ── Harness ──────────────────────────────────────────────────────────────────────
function buildAgent(c: ReturnType<typeof cells>[number]): Agent {
  const o: Record<string, unknown> = {
    slug: "matrix-agent",
    primitives: ["INTERPRET"],
    input_types: [],
    output_types: ["Interpretation"],
    domain: "demo",
    behavioral_primitives: c.disposition,
    constraints: c.constraints,
    depth_profile: c.depth,
    model_tier: c.model_tier,
    code_tool_access: c.code_access,
    allowed_tools: c.tools,
    skill_slugs: c.skills,
  };
  if (c.cap !== undefined) o["max_tool_calls"] = c.cap;
  return testAgent(o as Parameters<typeof testAgent>[0]);
}
// A STATIC invoker default model is always supplied here, so every cell's --model
// assertion (=== MODEL_TIER_MAP[tier]) doubles as proof that model_tier OVERRIDES the
// static default — the original bug was a single static model applied to every agent.
const STATIC_DEFAULT_MODEL = "static-default-should-be-overridden";
function spawnArgs(agent: Agent): string[] {
  let captured: string[] = [];
  const invoker = makeClaudeInvoker({ model: STATIC_DEFAULT_MODEL, run: (_b, args) => { captured = args; return '{"ok":true}'; } });
  void invoker({ agent, phase: "p", inputs: [], gig_input: {} } as AgentInvocationContext);
  return captured;
}
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
function cells() {
  return pairwise(AXES).map((c, i) => ({
    ...c,
    _id: `#${i} ${(c.disposition).join("/")} d=${c.depth} t=${c.model_tier} code=${c.code_access} tools=${(c.tools).length} skills=${(c.skills).length} cap=${c.cap} constr=${(c.constraints).length}`,
  }));
}

describe("agent matrix: prompt + cage derive correctly across all pairwise permutations", () => {
  it.each(cells())("$_id", (c) => {
    const agent = buildAgent(c);
    const prompt = buildPrompt({ agent, phase: "p", inputs: [], gig_input: {} });
    const args = spawnArgs(agent);

    // identity + method always rendered
    expect(prompt).toContain(agent.identity);
    expect(prompt).toContain(agent.method);

    // disposition: each Belbin role, its description, and the tension framing
    for (const role of c.disposition) {
      expect(prompt).toContain(role);
      expect(prompt).toContain(BELBIN_DESCRIPTIONS[role]);
    }
    expect(prompt).toMatch(/tension|equal tension|both modes/i);

    // depth tuning surfaced — both the value and a depth label (not a coincidental match)
    expect(prompt).toMatch(/depth/i);
    expect(prompt).toContain(c.depth);
    // and the model_tier model overrode the static invoker default
    expect(flag(args, "--model")).not.toBe(STATIC_DEFAULT_MODEL);

    // constraints rendered iff present
    if ((c.constraints).length > 0) {
      expect(prompt).toMatch(/#+\s*Constraints/i);
      for (const con of c.constraints) expect(prompt).toContain(con);
    }

    // tools: named + awareness in the prompt, AND granted in the cage
    if ((c.tools).length > 0) {
      for (const t of c.tools) expect(prompt).toContain(t);
      expect(prompt).toMatch(/available tools|call them directly|you have the following tools/i);
      expect(flag(args, "--allowedTools") ?? "").toContain((c.tools)[0]!);
    }

    // skills: bound slugs named in the prompt
    for (const s of c.skills) expect(prompt).toContain(s);

    // cage: model resolved from tier
    expect(flag(args, "--model")).toBe(MODEL_TIER_MAP[c.model_tier]);

    // cage: per-agent cap iff declared
    if (c.cap !== undefined) expect(flag(args, "--max-turns")).toBe(String(c.cap));
    else expect(args).not.toContain("--max-turns");

    // cage: code_tool_access denial ladder
    const denied = flag(args, "--disallowedTools") ?? "";
    for (const t of CODE_DENIALS[c.code_access]!) expect(denied).toContain(t);
    for (const t of ALL_CODE_TOOLS.filter((x) => !CODE_DENIALS[c.code_access]!.includes(x))) {
      expect(denied).not.toContain(t);
    }
  });
});

describe("agent matrix: the derivation rules themselves are sound", () => {
  it("model tiers map to distinct concrete models", () => {
    expect(new Set(Object.values(MODEL_TIER_MAP)).size).toBe(Object.keys(MODEL_TIER_MAP).length);
  });
  it("the code-access denial ladder is monotone (none denies all, full denies none)", () => {
    expect(CODE_DENIALS["none"]!.length).toBe(4);
    expect(CODE_DENIALS["full"]!.length).toBe(0);
    expect(CODE_DENIALS["read"]).not.toContain("Read");
  });
  it("pairwise covers every value of every axis at least once", () => {
    const rows = pairwise(AXES);
    for (const key of Object.keys(AXES) as (keyof typeof AXES)[]) {
      const seen = new Set(rows.map((r) => JSON.stringify(r[key])));
      expect(seen.size, `axis ${String(key)} not fully covered`).toBe(AXES[key].length);
    }
  });
});
