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

  // 1. Disposition — the behavioral primitives (how you think).
  layers.push(`# Disposition\nYou operate with the primitive(s): ${a.primitives.join(", ")}.`);

  // 2. Identity — who you are.
  layers.push(`# Identity\nYou are the agent "${a.slug}"${a.domain ? ` in the "${a.domain}" domain` : ""}.`);

  // 3. Skills — content the agent's bound skills contribute to the prompt. Each
  // skill renders as `## <slug>` + its text payload. We pick the first non-empty
  // string from the conventional content keys (`md`, then `text`, then `body`);
  // a slug-only SkillRecord still renders its slug so the model knows it's bound.
  const skillBlocks = (ctx.skills ?? []).map((s) => {
    const text =
      (typeof s["md"] === "string" && (s["md"] as string)) ||
      (typeof s["text"] === "string" && (s["text"] as string)) ||
      (typeof s["body"] === "string" && (s["body"] as string)) ||
      "";
    return `## ${s.slug}${text ? `\n${text}` : ""}`;
  });
  if (skillBlocks.length > 0) {
    layers.push(`# Skills\n${skillBlocks.join("\n\n")}`);
  }

  // 4. Context — the gig input + the upstream typed outputs you consume.
  const inputsBlock = ctx.inputs.length
    ? ctx.inputs.map((o) => `- ${o.domain_type} (from ${o.agent_slug}): ${JSON.stringify(o.data)}`).join("\n")
    : "(none — you are a root agent)";
  layers.push(`# Context\nGig input: ${JSON.stringify(ctx.gig_input)}\nUpstream outputs:\n${inputsBlock}`);

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
  opts: { model?: string | undefined; allowed_tools?: readonly string[] | undefined; disallowed_tools?: readonly string[] | undefined },
): string[] {
  const args = ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
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
      const args = buildInvokerArgs(prompt, cfgPath, {
        model: opts.model,
        allowed_tools: ctx.agent.allowed_tools,
        disallowed_tools: ctx.agent.disallowed_tools,
      });
      return extractJson(run(bin, args));
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
}
