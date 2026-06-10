// The real AgentInvoker: builds the 5-layer prompt and runs cognition via the
// `claude` CLI (Claude Code IS the cognition — the prime directive's "depend on
// nothing but Claude Code"). buildPrompt is pure + testable; runClaude is the one
// non-deterministic seam (spawns the CLI, parses structured output).
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentInvocationContext, AgentInvoker } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { ModelTier } from "./pricing.js";
import type { CodeToolAccess } from "./composition.js";

// Per-tier model resolution (the old MODEL_TIER_MAP: economy/standard/premium →
// haiku/sonnet/opus). An agent's model_tier picks the concrete spawn model; falls back to
// the invoker's static default only when the agent declares no tier.
export const MODEL_TIER_MAP: Record<ModelTier, string> = {
  economy: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  premium: "claude-opus-4-8",
};
function resolveModel(tier: ModelTier | undefined, fallback: string | undefined): string | undefined {
  return tier ? MODEL_TIER_MAP[tier] : fallback;
}

// code_tool_access → the built-in code tools the cage denies. none denies all; read keeps
// Read; write keeps Read/Write/Edit; full denies none; unset adds no denial layer.
const CODE_TOOLS = ["Read", "Write", "Edit", "Bash"] as const;
function codeToolDenials(access: CodeToolAccess | undefined): string[] {
  switch (access) {
    case "none": return [...CODE_TOOLS];
    case "read": return ["Write", "Edit", "Bash"];
    case "write": return ["Bash"];
    default: return []; // "full" or unset → no code-tool denial
  }
}

// Belbin cognitive-role descriptions for the Disposition layer (the agent's stance, 2
// "in tension"). Strings match the old runtime verbatim so a restored prompt reaches
// parity with the baseline fixtures. Reference data; buildPrompt wires it in.
export const BELBIN_DESCRIPTIONS: Record<string, string> = {
  explorer: "Navigates unknown territory, discovers structure, maps the landscape.",
  analyst: "Finds patterns, extracts meaning, builds structured understanding from raw data.",
  critic: "Challenges assumptions, finds weaknesses, demands evidence for every claim.",
  synthesizer: "Combines disparate inputs into coherent wholes, resolves contradictions.",
  planner: "Decomposes goals into sequences, allocates resources, designs strategies.",
  executor: "Produces concrete artifacts, writes code, builds deliverables.",
  audience_modeler: "Understands user perspectives, models personas, anticipates needs.",
};

// The 5-layer prompt hierarchy: Disposition → Identity → Skills → Context → Task.
// Pure: same context in, same prompt out. Hashable, reviewable, testable.
// Layer 3 (Skills) is emitted when the AgentInvocationContext carries resolved
// SkillRecords — the runtime resolves the agent's `skill_slugs` against the
// genome's skills map and passes the records through. Empty/absent → the Skills
// section is omitted entirely (no empty header, no noise) so the model only
// sees skills the agent actually declared.
export function buildPrompt(ctx: AgentInvocationContext, outputSchema?: Record<string, unknown>): string {
  const a = ctx.agent;
  const layers: string[] = [];

  // 1. Disposition — the Belbin cognitive-role pairing, held in tension (how you think).
  const dispo = a.behavioral_primitives.map((r) => `- **${r}**: ${BELBIN_DESCRIPTIONS[r] ?? r}`).join("\n");
  layers.push(
    `# Disposition\nYou hold these cognitive modes in equal tension:\n${dispo}\nHold every mode active throughout your work; none dominates.`,
  );

  // 2. Identity — who you are: the slug line plus the agent's own prose.
  layers.push(
    `# Identity\nYou are the agent "${a.slug}"${a.domain ? ` in the "${a.domain}" domain` : ""}.\n\n${a.identity}`,
  );

  // 3. Method — how THIS agent does its job, the step-by-step.
  layers.push(`# Method\n${a.method}`);

  // 4. Skills — content the agent's bound skills contribute to the prompt. Each
  // skill renders as `## <slug>` + its text payload. We pick the first non-empty
  // string from the conventional content keys (`md`, then `text`, then `body`);
  // a slug-only SkillRecord still renders its slug so the model knows it's bound.
  const resolved = ctx.skills ?? [];
  const skillBlocks = resolved.length > 0
    ? resolved.map((s) => {
        const text =
          (typeof s["md"] === "string" && (s["md"] as string)) ||
          (typeof s["text"] === "string" && (s["text"] as string)) ||
          (typeof s["body"] === "string" && (s["body"] as string)) ||
          "";
        return `## ${s.slug}${text ? `\n${text}` : ""}`;
      })
    // No resolved content this gig — still name the bound skills so the model knows it has
    // them (matches the old runtime's skills index).
    : (a.skill_slugs ?? []).map((slug) => `## ${slug}`);
  if (skillBlocks.length > 0) {
    layers.push(`# Skills\n${skillBlocks.join("\n\n")}`);
  }

  // 5. Constraints — the negative space (never-invent / cite-sources). Omitted when empty.
  if (a.constraints.length > 0) {
    layers.push(`# Constraints\n${a.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  // 6. Available Tools — name every granted tool so the model knows it has them and uses
  // them (the cage grants access; the prompt must grant awareness, or the tools sit unused).
  if (a.allowed_tools && a.allowed_tools.length > 0) {
    layers.push(
      `# Available Tools\nThese tools are available to you — call them directly:\n${a.allowed_tools.map((t) => `- ${t}`).join("\n")}`,
    );
  }

  // 7. Context — the gig input + the upstream typed outputs you consume + depth tuning.
  const inputsBlock = ctx.inputs.length
    ? ctx.inputs.map((o) => `- ${o.domain_type} (from ${o.agent_slug}): ${JSON.stringify(o.data)}`).join("\n")
    : "(none — you are a root agent)";
  const depthLine = a.depth_profile ? `Depth: ${a.depth_profile}\n` : "";
  layers.push(`# Context\n${depthLine}Gig input: ${JSON.stringify(ctx.gig_input)}\nUpstream outputs:\n${inputsBlock}`);

  // 5. Task — produce exactly one typed output as JSON matching its schema.
  const outType = a.output_types[0] ?? "output";
  const schemaHint = outputSchema ? `\nIt must match this JSON schema:\n${JSON.stringify(outputSchema)}` : "";
  layers.push(
    `# Task\nProduce exactly one "${outType}".${schemaHint}\n` +
      `Respond with ONLY a single JSON object (the output's data) — no prose, no code fence.`,
  );

  return layers.join("\n\n");
}

// Extract the first balanced JSON object from model output (tolerates fences/prose).
export function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice) as Record<string, unknown>;
      }
    }
  }
  throw new Error("unbalanced JSON object in model output");
}

export interface ClaudeInvokerOptions {
  bin?: string | undefined; // default "claude"
  model?: string | undefined; // passed to --model if set
  registry?: Registry | undefined; // to resolve the output type's schema into the prompt
  // The MCP servers the cage permits the spawn to load. Empty = no MCP tools at all.
  // With --strict-mcp-config, ONLY these load — never the host's ambient servers.
  mcpServers?: Record<string, unknown> | undefined;
  run?: ((bin: string, args: string[]) => string) | undefined; // injectable spawn (tests)
  // When set, the spawned child receives COLTRANE_PARENT_SESSION_ID so its first
  // recorded turn seals the lineage edge to its parent.
  parent_session_id?: string | undefined;
}

// The blast-radius cage, PURE. Given the agent's tool grant + a per-gig mcp-config path,
// build the claude CLI args. Two halves: `--strict-mcp-config` + `--mcp-config <path>`
// means the spawn loads ONLY the servers in that file (never the host's ambient MCP) —
// deny-by-default. `--allowedTools`/`--disallowedTools` scope the tool surface to the
// agent's declared grant. Ports OG's claude-launcher 4-flag cage.
export function buildInvokerArgs(
  prompt: string,
  mcpConfigPath: string,
  opts: { model?: string | undefined; allowed_tools?: readonly string[] | undefined; disallowed_tools?: readonly string[] | undefined; max_tool_calls?: number | undefined },
): string[] {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  // per-agent blast-radius cap: a runaway agent can't burn past its own turn budget.
  if (opts.max_tool_calls !== undefined) args.push("--max-turns", String(opts.max_tool_calls));
  // the cage floor: no ambient MCP servers leak into the spawn, ever.
  args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (opts.allowed_tools && opts.allowed_tools.length > 0) args.push("--allowedTools", opts.allowed_tools.join(","));
  if (opts.disallowed_tools && opts.disallowed_tools.length > 0) args.push("--disallowedTools", opts.disallowed_tools.join(","));
  return args;
}

// The production AgentInvoker. Writes a per-gig mcp-config (the permitted servers only),
// spawns `claude -p` inside the cage, parses the JSON. The spawn is the non-deterministic
// seam (inject `run` to test the cage args + parse without the CLI). When a
// parent_session_id is provided, every spawned MCP server in this child receives it via
// env so the recorder seals the parent → child lineage edge on the child's first turn.
export function makeClaudeInvoker(opts: ClaudeInvokerOptions = {}): AgentInvoker {
  const bin = opts.bin ?? "claude";
  const run = opts.run ?? ((b: string, args: string[]) => execFileSync(b, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
  return (ctx) => {
    const outType = ctx.agent.output_types[0];
    const schema = opts.registry?.listTypes().find((t) => t.slug === outType)?.schema as
      | Record<string, unknown>
      | undefined;
    const prompt = buildPrompt(ctx, schema);
    // per-gig mcp-config: only the deployment-permitted servers (empty by default).
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    const servers = opts.mcpServers ?? {};
    const parent = opts.parent_session_id;
    // Inject parent_session_id env into every named server so children seal lineage.
    const enriched = parent
      ? Object.fromEntries(
          Object.entries(servers).map(([name, def]) => {
            const d = (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
            const env = (d["env"] && typeof d["env"] === "object" ? d["env"] : {}) as Record<string, unknown>;
            return [name, { ...d, env: { ...env, COLTRANE_PARENT_SESSION_ID: parent } }];
          }),
        )
      : servers;
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: enriched }));
    try {
      const a = ctx.agent;
      const args = buildInvokerArgs(prompt, cfgPath, {
        model: resolveModel(a.model_tier, opts.model),
        allowed_tools: a.allowed_tools,
        disallowed_tools: [...(a.disallowed_tools ?? []), ...codeToolDenials(a.code_tool_access)],
        max_tool_calls: a.max_tool_calls,
      });
      return extractJson(run(bin, args));
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
}
