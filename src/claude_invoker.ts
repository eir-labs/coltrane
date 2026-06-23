// The real AgentInvoker: builds the 5-layer prompt and runs cognition via the
// `claude` CLI (Claude Code IS the cognition — the prime directive's "depend on
// nothing but Claude Code"). buildPrompt is pure + testable; runClaude is the one
// non-deterministic seam (spawns the CLI, parses structured output).
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentInvocationContext, AgentInvoker, AgentStreamEvent } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { ModelTier } from "./pricing.js";
import type { CodeToolAccess } from "./composition.js";
import { assertToolGrantsResolvable, type ToolProviderRegistry } from "./tool_providers.js";
import { playwrightServerFor } from "./playwright_cage.js";

const EMPTY_TOOL_REGISTRY: ToolProviderRegistry = new Map();

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
export function buildPrompt(
  ctx: AgentInvocationContext,
  outputSchema?: Record<string, unknown>,
  // Per-type schemas for a MULTI-output agent (slug → schema). When the agent declares
  // more than one output type, the Task layer asks for a blob keyed by type rather than a
  // single object — the runtime then seals one record per key.
  outputSchemas?: Record<string, Record<string, unknown> | undefined>,
): string {
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

  // 5. Task — produce the types THIS CHAIR promises as JSON. #174: the chair's output_contract
  // (threaded as ctx.output_types) is the selector — a multi-capability agent at a single-purpose
  // chair is asked for only its promised subset, not its whole catalogue. Legacy ctx without it
  // falls back to the agent's full output_types.
  const sealTypes = ctx.output_types?.length ? ctx.output_types : a.output_types;
  if (sealTypes.length > 1) {
    // multi-output: one JSON object keyed by each output-type slug; each value is that
    // type's data. The runtime seals one record per key (a SENSE+JUDGE agent yields its
    // Signal and its Judgment in one pass).
    const perType = sealTypes
      .map((t) => {
        const s = outputSchemas?.[t];
        return `  "${t}": <object${s ? ` matching ${JSON.stringify(s)}` : ""}>`;
      })
      .join(",\n");
    layers.push(
      `# Task\nProduce one object for EACH of your output types: ${sealTypes.map((t) => `"${t}"`).join(", ")}.\n` +
        `Respond with ONLY a single JSON object keyed by output-type name — no prose, no code fence:\n{\n${perType}\n}`,
    );
  } else {
    const outType = sealTypes[0] ?? "output";
    const schemaHint = outputSchema ? `\nIt must match this JSON schema:\n${JSON.stringify(outputSchema)}` : "";
    layers.push(
      `# Task\nProduce exactly one "${outType}".${schemaHint}\n` +
        `Respond with ONLY a single JSON object (the output's data) — no prose, no code fence.`,
    );
  }

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

// The wall-clock bound on one chair's spawn. A tool-granted child has no inherent
// terminus (it can search/loop), and the gig runs the spawn synchronously — so without
// this bound one wedged child wedges the whole server. SIGKILL, not SIGTERM: a
// signal-trapping child can't outlive its budget. Long enough for a tool-using chair
// (a capped search agent runs minutes), far below an operator-visible hang.
export const DEFAULT_CHAIR_TIMEOUT_MS = 10 * 60_000;

// Spawn bounds passed to the run seam (execFileSync options in the default runner).
export interface SpawnBounds {
  timeout: number;
  killSignal: "SIGKILL";
}

export interface ClaudeInvokerOptions {
  bin?: string | undefined; // default "claude"
  model?: string | undefined; // passed to --model if set
  registry?: Registry | undefined; // to resolve the output type's schema into the prompt
  // The MCP servers the cage permits the spawn to load. Empty = no MCP tools at all.
  // With --strict-mcp-config, ONLY these load — never the host's ambient servers.
  // This is the BASE map; #185 resolution adds the per-agent servers its grants require.
  mcpServers?: Record<string, unknown> | undefined;
  // #185 — tool-grant → provider resolution. `toolProviders` maps explicit tool names to
  // providers; `mcpServerConfigs` maps an MCP server slug → its --mcp-config entry (coltrane
  // ships its own "coltrane" server). Per invocation, the agent's allowed_tools resolve through
  // these into the spawn's mcp-config; a grant with no provider fails the chair closed (a dead
  // name never reaches the model). Absent = empty (only host-builtins resolve; any MCP grant fails).
  toolProviders?: ToolProviderRegistry | undefined;
  mcpServerConfigs?: Record<string, unknown> | undefined;
  run?: ((bin: string, args: string[], spawn: SpawnBounds) => string | Promise<string>) | undefined; // injectable spawn (tests)
  // Per-deployment override of the per-chair wall-clock bound.
  timeout_ms?: number | undefined;
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
  // Injected run (tests) short-circuits the spawn: plain mode, returns the JSON blob directly.
  // Absent → the default streaming spawn below runs the real CLI with stream-json.
  const customRun = opts.run;
  const spawnBounds: SpawnBounds = { timeout: opts.timeout_ms ?? DEFAULT_CHAIR_TIMEOUT_MS, killSignal: "SIGKILL" };
  // #185 — grant resolution is enabled once the deployment wires a provider registry (either map
  // present). Until then the invoker keeps its legacy pass-through (tools listed, no resolution) so
  // a bare/test invoker is unaffected. bootstrapServerDeps always supplies mcpServerConfigs, so the
  // running engine always resolves + fails closed.
  const resolutionEnabled = opts.toolProviders !== undefined || opts.mcpServerConfigs !== undefined;
  return async (ctx) => {
    // Resolve THIS agent's grants → the MCP servers it needs, FIRST: a grant with no resolvable
    // provider is a dead name, so fail the chair closed before we build a prompt or spawn a child
    // that advertises a tool it can't call.
    let resolvedMcpServers: Record<string, unknown> = {};
    // The grants as the SPAWN must see them in --allowedTools. Default to the raw grant list (the
    // legacy pass-through invoker); when resolution is on, use the resolved names — an in-house engine
    // tool granted by bare slug becomes mcp__<server>__<tool>, the name its server advertises (#204).
    let effectiveAllowed: readonly string[] | undefined = ctx.agent.allowed_tools;
    if (resolutionEnabled) {
      // The caged browser: if this agent declares a browser_grant, coltrane builds a deny-by-default
      // Playwright server scoped to exactly its allowed origins and offers it as the "playwright"
      // provider. An agent that grants mcp__playwright__* tools but declares NO browser_grant has no
      // playwright config → its grant is unresolvable → fails closed (no uncaged browser, ever).
      const browserCage = playwrightServerFor(ctx.agent.browser_grant);
      const effectiveConfigs = browserCage
        ? { ...(opts.mcpServerConfigs ?? {}), playwright: browserCage }
        : (opts.mcpServerConfigs ?? {});
      // assertToolGrantsResolvable is the single source of the fail-closed guard (it throws on a
      // dead name) AND returns the resolved servers — no duplicated inline throw.
      const resolved = assertToolGrantsResolvable(
        ctx.agent.slug,
        ctx.agent.allowed_tools ?? [],
        opts.toolProviders ?? EMPTY_TOOL_REGISTRY,
        effectiveConfigs,
      );
      resolvedMcpServers = resolved.mcpServers;
      effectiveAllowed = resolved.effectiveAllowed;
    }
    const types = opts.registry?.listTypes() ?? [];
    const schemaOf = (slug: string | undefined) =>
      (types.find((t) => t.slug === slug)?.schema as Record<string, unknown> | undefined);
    // #174 — schemas follow the chair's promised subset (ctx.output_types), not the agent's
    // whole catalogue; legacy ctx without it falls back to the agent's full output_types.
    const sealTypes = ctx.output_types?.length ? ctx.output_types : ctx.agent.output_types;
    const outType = sealTypes[0];
    const schema = schemaOf(outType);
    // For a multi-output chair, resolve every promised type's schema so the Task layer can
    // ask for a blob keyed by type; the runtime seals one record per key.
    const outputSchemas = sealTypes.length > 1
      ? Object.fromEntries(sealTypes.map((t) => [t, schemaOf(t)]))
      : undefined;
    const prompt = buildPrompt(ctx, schema, outputSchemas);
    // per-gig mcp-config: only the deployment-permitted servers (empty by default).
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    // the base map (opts.mcpServers) + the per-agent servers its grants resolved to (#185).
    const servers = { ...(opts.mcpServers ?? {}), ...resolvedMcpServers };
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
      const baseArgs = buildInvokerArgs(prompt, cfgPath, {
        model: resolveModel(a.model_tier, opts.model),
        allowed_tools: effectiveAllowed,
        disallowed_tools: [...(a.disallowed_tools ?? []), ...codeToolDenials(a.code_tool_access)],
        max_tool_calls: a.max_tool_calls,
      });
      // Custom run (tests): plain mode, the returned string IS the JSON blob — no streaming.
      if (customRun) return extractJson(await customRun(bin, baseArgs, spawnBounds));
      // Default: stream-json so the child's tool calls / reasoning are observable LIVE. Each
      // event is forwarded to ctx.onEvent (the runtime tees it to the gig's per-chair log);
      // the final result text is extracted from the stream and parsed into the typed output.
      const args = [...baseArgs, "--output-format", "stream-json", "--verbose"];
      const stdout = await spawnStreaming(bin, args, spawnBounds, ctx.onEvent);
      return extractJson(finalText(stdout));
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
}

// Spawn a child and stream its stdout line-by-line. Each complete line is parsed as a
// stream-json event and forwarded (granularly) to onEvent as it arrives — this is the
// agent-layer observability seam. Returns the full stdout on clean exit; rejects on
// non-zero exit (with stderr) or timeout (SIGKILL, so a signal-trapping child can't survive).
function spawnStreaming(
  bin: string,
  args: readonly string[],
  bounds: SpawnBounds,
  onEvent?: (ev: AgentStreamEvent) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`chair child timed out after ${bounds.timeout}ms (SIGKILL)`));
    }, bounds.timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !onEvent) continue;
        try { forwardStreamEvent(JSON.parse(line), onEvent); } catch { /* non-json line */ }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// Map a child stream-json event to granular AgentStreamEvents. assistant content explodes
// into per-block tool_use / text events (so a monitor sees each tool call); result passes
// its text; everything else passes its type + raw.
function forwardStreamEvent(evt: Record<string, unknown>, onEvent: (ev: AgentStreamEvent) => void): void {
  const type = String(evt["type"] ?? "event");
  if (type === "assistant" && evt["message"] && typeof evt["message"] === "object") {
    const content = (evt["message"] as { content?: Array<Record<string, unknown>> }).content ?? [];
    for (const b of content) {
      const bt = String(b["type"] ?? "");
      if (bt === "tool_use") onEvent({ type: "tool_use", tool: String(b["name"] ?? ""), raw: b });
      else if (bt === "text") onEvent({ type: "assistant", text: String(b["text"] ?? ""), raw: b });
    }
    return;
  }
  if (type === "result") {
    onEvent({ type: "result", text: typeof evt["result"] === "string" ? (evt["result"] as string) : undefined, raw: evt });
    return;
  }
  onEvent({ type, raw: evt });
}

// Extract the final result text from a stream-json stdout: the `result` event's text, else
// concatenated assistant text. Falls back to raw stdout when nothing parsed (plain -p mode).
function finalText(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  let result: string | undefined;
  const assistant: string[] = [];
  let parsedAny = false;
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as Record<string, unknown>;
      parsedAny = true;
      if (e["type"] === "result" && typeof e["result"] === "string") result = e["result"] as string;
      else if (e["type"] === "assistant" && e["message"] && typeof e["message"] === "object") {
        const content = (e["message"] as { content?: Array<Record<string, unknown>> }).content ?? [];
        for (const b of content) if (b["type"] === "text") assistant.push(String(b["text"] ?? ""));
      }
    } catch { /* non-json */ }
  }
  if (!parsedAny) return stdout;
  return result ?? assistant.join("\n");
}
