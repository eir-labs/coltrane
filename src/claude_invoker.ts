// The real AgentInvoker: builds the 5-layer prompt and runs cognition via the
// `claude` CLI (Claude Code IS the cognition — the prime directive's "depend on
// nothing but Claude Code"). buildPrompt is pure + testable; runClaude is the one
// non-deterministic seam (spawns the CLI, parses structured output).
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, posix as posixPath } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { abortReasonText, type AgentInvocationContext, type AgentInvoker, type AgentStreamEvent } from "./runtime.js";
import type { Registry } from "./registry.js";
import type { Depth, ModelTier } from "./pricing.js";
import type { Effort } from "./genome_schema.js";
import type { CodeToolAccess } from "./composition.js";
import { resolveAgentGrants, hostBuiltinDenials, toolBaseName, grantsTreeReader, ENGINE_MCP_SERVER, type ToolProviderRegistry } from "./tool_providers.js";
import type { OutputRecord } from "./outputs.js";
import { venueEffectiveTools } from "./chart.js";
import { resolveSeatGrants, targetPathsOf, describeRoleRefusals, LAYOUT_FILE } from "./layout_grants.js";
import { CORE_TYPES } from "./core_types.js";

const EMPTY_TOOL_REGISTRY: ToolProviderRegistry = new Map();

/** The tool name a chair's in-band `output_write` seal is advertised under in the spawn. */
const OUTPUT_WRITE_TOOL = `mcp__${ENGINE_MCP_SERVER}__output_write`;

// Per-tier model resolution (the old MODEL_TIER_MAP: economy/standard/premium →
// haiku/sonnet/opus). An agent's model_tier picks the concrete spawn model; falls back to
// the invoker's static default only when the agent declares no tier.
export const MODEL_TIER_MAP: Record<ModelTier, string> = {
  economy: "claude-haiku-4-5",
  standard: "claude-sonnet-4-6",
  premium: "claude-opus-4-8",
};
/**
 * Tier → the model that actually runs. EXPORTED because the runtime must stamp the same answer
 * onto the sealed output that the invoker used to spawn. Two functions computing this
 * separately is the two-gates-one-concern shape that produced the silent wrong-resume.
 */
export function resolveModel(tier: ModelTier | undefined, fallback: string | undefined): string | undefined {
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

// The code tools code_tool_access affirmatively KEEPS available — the inverse of codeToolDenials over
// the four CODE_TOOLS. This is the allow signal the host-builtin complement must respect: those four
// tools are governed by the code_tool_access LADDER, so the complement must not re-deny one the access
// level grants (a "full" agent keeps Read/Write/Edit/Bash even when it lists none in allowed_tools —
// host builtins are allowed-by-default and code_tool_access is their deny layer).
//
// UNSET is distinct from "full": an agent that declares NO code access and grants no code tool keeps
// NONE — that is what lets the ceiling bind on the default agent (gig 782e89d8, room-prober had no
// code_tool_access yet reached Bash and Read). codeToolDenials returns [] for unset, so it cannot
// carry this distinction; this function does.
function codeToolsKept(access: CodeToolAccess | undefined): string[] {
  if (access === undefined) return [];
  const denied = new Set(codeToolDenials(access));
  return CODE_TOOLS.filter((t) => !denied.has(t));
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

// #237 — what a dispatch-time depth actually ASKS FOR. The prompt half of the lever.
export const DEPTH_GUIDANCE: Record<Depth, string> = {
  skim: " — this is a cheap iteration pass. Do the minimum that produces a well-formed, valid output. Do not explore, do not use tools you do not strictly need, do not elaborate.",
  quick: " — favour speed over exhaustiveness. Cover the obvious ground and stop.",
  standard: "",
  deep: " — be exhaustive. Chase the non-obvious and justify every claim.",
};

// #237 — the SPEND half of the lever. `--max-turns` is the only hard per-chair cost bound the
// cage has, so a shallow depth caps it: a skim run that can still take 100 tool turns is a full
// run wearing a label. Only ever TIGHTENS an agent's own declared cap, never widens it. Depths
// with no entry leave the agent's cap exactly as declared.
export const DEPTH_MAX_TOOL_CALLS: Partial<Record<Depth, number>> = { skim: 8, quick: 16 };

// The 5-layer prompt hierarchy: Disposition → Identity → Skills → Context → Task.
// Pure: same context in, same prompt out. Hashable, reviewable, testable.
// Layer 3 (Skills) is emitted when the AgentInvocationContext carries resolved
// SkillRecords — the runtime resolves the agent's `skill_slugs` against the
// genome's skills map and passes the records through. Empty/absent → the Skills
// section is omitted entirely (no empty header, no noise) so the model only
// sees skills the agent actually declared.
/**
 * The schema a producer is SHOWN for an output type — by construction the same object
 * the seal enforces (`Registry.effectiveSchema`), never the raw authored schema.
 *
 * 2026-08-08 — three consecutive live chair failures shared one cause: the prompt
 * rendered `dt.schema` verbatim while the seal enforced core-merged properties plus
 * `union(schema.required, required_fields)`. A producer emitting a maximally-valid
 * object against the shown contract was rejected against the enforced one, and the
 * chair failed closed. This function is the unification point: if the producer's view
 * ever needs to differ from the seal's again, that difference must be argued here.
 */
export function promptSchemaFor(
  registry: Registry | undefined,
  slug: string | undefined,
): Record<string, unknown> | undefined {
  if (!registry || !slug) return undefined;
  return registry.effectiveSchema(slug);
}

/**
 * When set, the Task layer tells the chair to seal each output IN-BAND by calling `output_write`
 * (the write-boundary tool) rather than printing final-text JSON for the invoker to parse. The
 * tool runs the full seal predicate and returns its verdict in-band, so the agent self-corrects
 * within its own single run — there is no invoker re-prompt. Absent → the legacy text-seal Task
 * (unchanged, so every buildPrompt fixture stays stable).
 */
export interface OutputWriteSeal {
  via: "output_write";
  gig_id: string;
  agent_slug: string;
  phase: string;
  /** domain_type slug → its core_type, so the agent passes the right `core_type` to output_write. */
  core_by_type: Record<string, string>;
}

export function buildPrompt(
  ctx: AgentInvocationContext,
  outputSchema?: Record<string, unknown>,
  // Per-type schemas for a MULTI-output agent (slug → schema). When the agent declares
  // more than one output type, the Task layer asks for a blob keyed by type rather than a
  // single object — the runtime then seals one record per key.
  outputSchemas?: Record<string, Record<string, unknown> | undefined>,
  seal?: OutputWriteSeal,
): string {
  const a = ctx.agent;

  // contract-amend-resume-prompt-v1 (O1/O2/I1) — a RESUMED amend carries ONLY what is new. The
  // resumed conversation already holds # Disposition / # Identity / # Method / # Context and the gig
  // input from round one, so re-sending them re-pays the whole cold read the resume exists to avoid
  // (measured: the amend prompt was byte-for-byte the full round-one prompt). Emit a trimmed prompt:
  // a short statement that this is an amend round of the same chair, plus the failing verdict's
  // content (its pass:false and failing checks) — the one thing round one did not yet have. The cold
  // fallback for a lost session re-invokes buildPrompt with resume OFF, so the FULL prompt is still
  // reachable when the resume's conversation is gone (I2).
  // contract-resumed-gig-session-v1 (O1) — a re-VERIFY resume keeps the FULL prompt: it re-invokes
  // with `resume` (so buildInvokerArgs emits --resume) but `resume_keep_prompt` set, meaning it re-reads
  // the amended tree under its own identity rather than being handed a trimmed "here is the one new
  // input" continuation. The trimmed branch below is for a MAKER amend, whose one new thing IS the
  // failing verdict; a stateless door (chat-completions) that holds no conversation must still carry the
  // seat's identity, which the trim would strip — so a keep-prompt resume falls through to the full stack.
  if (ctx.resume === true && ctx.resume_keep_prompt !== true) {
    const failing = ctx.inputs.find(
      (o) => (o.data as { pass?: unknown } | undefined)?.pass === false,
    );
    const verdictBlock = failing
      ? JSON.stringify(failing.data)
      : "(the failing verdict was not carried into this amend round)";
    return [
      `# Amend round`,
      `This is an amend round of the same "${ctx.role ?? a.slug}" chair, resuming the conversation ` +
        `that already holds your disposition, identity, method, tools and the gig input. Fix ONLY ` +
        `what the verify below caught, then re-seal your output exactly as you did before.`,
      `# Failing verdict\nThe verify FAILED (pass: false). Its failing checks are what to fix:\n${verdictBlock}`,
    ].join("\n\n");
  }

  const layers: string[] = [];

  // 1. Disposition — the Belbin cognitive-role pairing, held in tension (how you think).
  const dispo = a.behavioral_primitives.map((r) => `- **${r}**: ${BELBIN_DESCRIPTIONS[r] ?? r}`).join("\n");
  layers.push(
    `# Disposition\nYou hold these cognitive modes in equal tension:\n${dispo}\nHold every mode active throughout your work; none dominates.`,
  );

  // 2. Identity — who you are: the slug line plus the agent's own prose. When the context carries
  // a chair role, name the seat this invocation holds — and ONLY this seat. Two chairs seating the
  // same agent in one phase share every other layer, so the seat line is what splits their prompts;
  // without it the division of labour a standard declares between them exists only in the role
  // names and each chair does the same work. A ctx without a role (hand-built literals, the
  // text-seal path) renders no seat line, so those prompts stay valid and byte-identical.
  const seatLine = ctx.role ? `\nYou are seated as the "${ctx.role}" chair in this phase.` : "";
  layers.push(
    `# Identity\nYou are the agent "${a.slug}"${a.domain ? ` in the "${a.domain}" domain` : ""}.${seatLine}\n\n${a.identity}`,
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
        // THE FILLED SLOTS. A skill declares `hydration` slots; the institution fills the
        // institution-bound ones at SEAT time (the chair's `supplies`, arriving as ctx.hydration) and
        // the gig fills the gig-bound ones at DISPATCH time (the run's own payload). Until this
        // rendered, both were validated and then discarded — a skill instructing its agent to "read
        // the constraints supplied in the `house-style` slot" found nothing there, on every run.
        //
        // Only slots the skill DECLARES are rendered. A chair that supplies a key no skill declares
        // is supplying nothing, and must not get a free channel into the prompt through it.
        const slots = (s as { hydration?: Record<string, { binding?: string }> }).hydration ?? {};
        const slotLines = Object.entries(slots).map(([name, spec]) => {
          const fromSeat = (ctx.hydration ?? {})[name];
          const fromGig = (ctx.gig_input ?? {})[name];
          const value = (spec?.binding ?? "institution") === "gig" ? fromGig : fromSeat;
          if (value === undefined) {
            // Named as unfilled rather than omitted. A skill cannot follow its own rule for an
            // unfilled slot if the prompt does not say which slots are empty — and silence here is
            // exactly what let a severed wire read as an optional input.
            return `- \`${name}\`: (unfilled — no value supplied)`;
          }
          return `- \`${name}\`: ${typeof value === "string" ? value : JSON.stringify(value)}`;
        });
        const slotBlock = slotLines.length > 0 ? `\n\n### Supplied\n${slotLines.join("\n")}` : "";
        return `## ${s.slug}${text ? `\n${text}` : ""}${slotBlock}`;
      })
    // No resolved content this gig — still name the bound skills so the model knows it has
    // them (matches the old runtime's skills index). #241: NEVER name a slug the runtime
    // resolved to no package. An all-dangling agent used to render `# Skills` / `## <slug>`
    // with zero content — the prompt ASSERTING to the model that it holds a discipline that
    // does not exist. An ABSENT `missing_skills` means resolution was never attempted (no
    // skills map), so nothing is known-unresolved and the legacy index behaviour stands.
    : (a.skill_slugs ?? [])
        .filter((slug) => !(ctx.missing_skills ?? []).includes(slug))
        .map((slug) => `## ${slug}`);
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
  // #237 — a dispatch-time depth OVERRIDES the agent's static depth_profile, and carries an
  // instruction with it. A depth that only gets recorded is not a cost lever; the model has to
  // be told to do less, or "skim first" stays a slogan and every iteration pays full price.
  const runDepth = ctx.depth ?? a.depth_profile;
  const depthLine = runDepth
    ? `Depth: ${runDepth}${ctx.depth ? DEPTH_GUIDANCE[ctx.depth] : ""}\n`
    : "";
  layers.push(`# Context\n${depthLine}Gig input: ${JSON.stringify(ctx.gig_input)}\nUpstream outputs:\n${inputsBlock}`);

  // 5. Task — produce the types THIS CHAIR promises as JSON. #174: the chair's output_contract
  // (threaded as ctx.output_types) is the selector — a multi-capability agent at a single-purpose
  // chair is asked for only its promised subset, not its whole catalogue. Legacy ctx without it
  // falls back to the agent's full output_types.
  const sealTypes = ctx.output_types?.length ? ctx.output_types : a.output_types;
  if (seal) {
    // IN-BAND WRITE-BOUNDARY SEAL. Each output is sealed by an `output_write` call whose payload
    // the engine adjudicates against the FULL contract; a rejection returns in-band and the agent
    // fixes `data` and calls again — its own single run self-corrects, no invoker re-prompt.
    const perType = sealTypes
      .map((t) => {
        const s = outputSchemas?.[t] ?? (sealTypes.length === 1 ? outputSchema : undefined);
        const core = seal.core_by_type[t] ?? "";
        return (
          `- output_write({ "core_type": "${core}", "domain_type": "${t}", ` +
          `"gig_id": "${seal.gig_id}", "phase": "${seal.phase}", "agent_slug": "${seal.agent_slug}", ` +
          `"data": <object${s ? ` matching ${JSON.stringify(s)}` : ""}> })`
        );
      })
      .join("\n");
    layers.push(
      `# Task\nSeal each of your output types by calling the \`output_write\` tool — one call per type:\n${perType}\n\n` +
        `The tool validates your \`data\` against the complete output contract and returns ` +
        `\`{ ok: false, error }\` if it does not pass. When that happens, read the error, correct the ` +
        `\`data\`, and call \`output_write\` again — repeat until it returns \`ok: true\`. The successful ` +
        `call IS the seal; do NOT print the output as text, and do not stop until every type is sealed.`,
    );
  } else if (sealTypes.length > 1) {
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

  // contract-seat-primer-v1 (O4) — a FORK warm-starts from a primer that already read this area; the
  // files whose working-tree blob CHANGED since priming are named here so the seat re-reads exactly
  // those, not the whole area cold. An empty stale set adds nothing (the primed reading still holds).
  if (ctx.fork?.stale_paths && ctx.fork.stale_paths.length > 0) {
    layers.push(
      `# Changed since priming\nYou forked a primer that had already read this area. These files have ` +
        `CHANGED since it was primed — RE-READ them before relying on them, the primer's copy is stale:\n` +
        ctx.fork.stale_paths.map((p) => `- ${p}`).join("\n"),
    );
  }

  return layers.join("\n\n");
}

/**
 * contract-reverify-resume-prompt-v1 (O1) — the SHORT prompt a RESUMED Claude re-verify spawn carries.
 * A re-verify RESUMES the verifier's own round-one conversation (`ctx.resume` + `ctx.resume_keep_prompt`),
 * which already holds its disposition, identity, method, tools and the gig input, so this re-sends NONE
 * of them — no buildPrompt layer, no gig input. It states only what is new: the makers AMENDED their
 * work, so the verdict must be re-derived from the CURRENT working tree; plus the chair's output
 * contract (its output type, and the in-band `output_write` seal directive when this door seals that way).
 *
 * The trim lives HERE, on the resuming Claude side, NOT in the shared buildPrompt: buildPrompt keeps the
 * full prompt for a keep-prompt resume (its trim branch keys on `resume_keep_prompt !== true`), so the
 * stateless chat-completions door — which builds via buildPrompt and never reaches this function — keeps
 * the full prompt it needs to place the seat (O2), and the cold fallback for a lost resume re-sends the
 * full prompt built with resume OFF (F1). By construction this is a small fraction of the round-one
 * prompt (I1). buildPrompt's Task/seal directive is mirrored here rather than shared because the two
 * shapes diverge in what they re-send: the full stack vs. only-what-is-new.
 */
function buildReverifyResumePrompt(
  sealTypes: readonly string[],
  outputSchema: Record<string, unknown> | undefined,
  outputSchemas: Record<string, Record<string, unknown> | undefined> | undefined,
  seal: OutputWriteSeal | undefined,
  // contract-reverify-carries-amendment-v1 — what to carry (resolved by the RUNTIME; rendered, never
  // computed, here) and whether this seat can reach the tree at all (O4).
  amended: { records: readonly OutputRecord[]; carried_all: boolean } | undefined,
  readsTree: boolean,
): string {
  const types = sealTypes.length ? sealTypes : ["output"];
  const contract = seal
    ? `Re-seal each of your output types by calling the \`output_write\` tool — one call per type, ` +
        `exactly as you did in round one:\n` +
        types
          .map((t) => {
            const s = outputSchemas?.[t] ?? (types.length === 1 ? outputSchema : undefined);
            const core = seal.core_by_type[t] ?? "";
            return (
              `- output_write({ "core_type": "${core}", "domain_type": "${t}", ` +
              `"gig_id": "${seal.gig_id}", "phase": "${seal.phase}", "agent_slug": "${seal.agent_slug}", ` +
              `"data": <object${s ? ` matching ${JSON.stringify(s)}` : ""}> })`
            );
          })
          .join("\n")
    : `Re-seal your output — ${types.map((t) => `"${t}"`).join(", ")} — exactly as you did in round one: ` +
        `respond with ONLY the single JSON object (the output's data), no prose, no code fence.`;
  const records = amended?.records ?? [];
  const evidence = readsTree
    ? `re-derive your verdict from the CURRENT working tree — read the amended artifact as it now stands, ` +
      `do not rely on what you saw in round one — and rule again.`
    : `the carried records are your evidence: you hold no tool that reaches a working tree, so rule on ` +
      `the amended records below as they now stand, not on what you saw in round one.`;
  return [
    `# Re-verify (amend round)`,
    `The makers AMENDED their work in response to your failing verdict. You are RESUMING the conversation ` +
      `that already holds your disposition, identity, method, tools and the gig input, so this prompt ` +
      `carries only what is new: ${evidence}`,
    ...(records.length > 0
      ? [
          `# Amended records\n` +
            (amended?.carried_all
              ? `No round-one record of what you saw was found, so EVERY current input is carried below.\n`
              : `The inputs that changed since your round-one verdict:\n`) +
            records.map((o) => `- ${o.domain_type} (from ${o.agent_slug}): ${JSON.stringify(o.data)}`).join("\n"),
        ]
      : []),
    `# Output contract\n${contract}`,
  ].join("\n\n");
}

// ───────────────────────── JSON extraction (#221, #226) ─────────────────────────
//
// The old implementation took "the first balanced brace run" — string-blind, anchored on
// the first `{` and never re-anchored, with exactly one candidate ever handed to
// JSON.parse. It mis-sliced valid output (a `}` inside a string value truncated the slice)
// and, worse, silently returned an illustrative preamble object in place of the answer.
// That wrong object then sealed with a real content_sha and genuine provenance edges, so
// `output_trace` reported an intact chain over garbage.
//
// This is now ONE implementation shared by all four production call sites (:319, :325,
// document_factory.ts) — see #226; the judge's half-fixed duplicate is
// gone.

/** Bound on the raw-output excerpt a parse failure carries, so no blob lands in a log line. */
const EXCERPT_MAX_CHARS = 500;

/**
 * A typed extraction failure. Carries the number of balanced JSON objects found and a
 * bounded excerpt of the raw text — previously both throws were bare `Error`s with no
 * sample, so the operator's entire diagnostic was a V8 offset into a string never
 * surfaced. The type is also the prerequisite for any future retry policy: runtime.ts
 * cannot currently tell a retryable parse failure from a non-retryable contract failure.
 */
export class ModelOutputParseError extends Error {
  readonly candidateCount: number;
  readonly excerpt: string;
  constructor(message: string, candidateCount: number, raw: string) {
    super(`${message} (candidates: ${candidateCount})`);
    this.name = "ModelOutputParseError";
    this.candidateCount = candidateCount;
    this.excerpt =
      raw.length > EXCERPT_MAX_CHARS ? `${raw.slice(0, EXCERPT_MAX_CHARS)}…` : raw;
  }
}

/**
 * A chair completed its run but sealed NONE of its promised outputs through `output_write`.
 * Distinct from ModelOutputParseError (a text-seal chair that emitted no parseable answer): this
 * is the output_write-seal path, where the boundary that adjudicates a payload against its full
 * output contract is the chair's own in-band `output_write` call (validated by the engine's
 * checkWritable, corrected in-band by the agent), NOT a re-prompt from this invoker. A chair that
 * never gets a single write past that boundary produced nothing this invoker can hand back.
 *
 * The runtime's own floor check (executeChair, `missingRequired`) also catches a shortfall and is
 * the authority on which promised types were merely optional; this error is the earlier, chair-
 * local signal that the write boundary sealed nothing at all.
 */
/** Turns given to a channel repair. It needs to make a tool call it already has the answer for —
 *  enough to seal each promised type and stop, not enough to restart the work. */
const SEAL_REPAIR_TURNS = 4;

export class ModelOutputContractError extends Error {
  readonly slug: string;
  readonly reason: string;
  constructor(slug: string, reason: string) {
    super(`chair "${slug}" sealed no output through its write boundary: ${reason}`);
    this.name = "ModelOutputContractError";
    this.slug = slug;
    this.reason = reason;
  }
}

export interface ExtractJsonOptions {
  /**
   * Keys the answer is expected to carry. A candidate matches only if it contains **all**
   * of them — a partial match does not score, because "closest wins" is exactly the
   * guess that produces silent corruption.
   *
   * NOTE on derivation (see `extractOptionsForChair`): the two prompt shapes are mutually
   * exclusive, so schema property names and type slugs are chosen per-shape rather than
   * merged into one set. A flat union is unsatisfiable under all-must-match semantics —
   * a single-output answer `{"title":…}` can never also contain the key `finding`.
   */
  expectKeys?: readonly string[] | undefined;
  /**
   * Set by a caller that has NO key signal at all (a bare-core output type, or a domain
   * type absent from the registry — the same short-circuit registry.ts:140-146 takes).
   * One candidate is unambiguous and safe; multiple candidates with nothing to choose
   * between them is precisely the situation that silently seals the wrong object, so it
   * fails loudly instead of guessing.
   */
  requireUnambiguous?: boolean | undefined;
}

/** A balanced, parseable JSON object found in the text, with its span. */
interface JsonCandidate {
  start: number;
  end: number;
  value: Record<string, unknown>;
}

/**
 * Walk forward from `start` (which must be a `{`) honouring JSON string literals and
 * backslash escapes, so only STRUCTURAL braces move the depth counter. Returns the index
 * of the matching `}`, or -1 if the object never closes.
 *
 * Escape handling is the half of this that is easiest to get wrong, and two guards pin
 * it: `{"path":"C:\\","v":1}` (an escaped backslash immediately before the closing quote
 * — a naive `inString = !inString` toggle breaks it) and `{"note":"use {slug} here"}`
 * (balanced in-string braces, which worked by accident before and must keep working).
 */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every balanced, parseable JSON object in the text, in document order.
 *
 * Enumerates at EVERY `{` start position — the old code fixed `start` at the first one,
 * so a brace run in the prose (`The set {a,b} matters.`) sank the whole extraction. A
 * start that fails to parse is skipped and the scan re-anchors on the next `{`.
 *
 * Starts INSIDE an accepted candidate are skipped, so `{"a":{"b":1},"c":2}` yields the
 * outer object rather than also offering its own nested `{"b":1}` as a rival.
 */
function enumerateCandidates(text: string): JsonCandidate[] {
  const found: JsonCandidate[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    const end = scanBalanced(text, i);
    if (end === -1) { i++; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(text.slice(i, end + 1)); } catch { i++; continue; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      found.push({ start: i, end, value: parsed as Record<string, unknown> });
      i = end + 1;
      continue;
    }
    i++;
  }
  return found;
}

// A fenced block, tagged (```json) or bare (```). Non-greedy so consecutive fences are
// separate spans rather than one span swallowing the prose between them.
const FENCE_RE = /```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/g;

/** Character spans of every fenced block's BODY. */
function fenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const body = m[1] ?? "";
    const bodyStart = m.index + m[0].length - 3 - body.length;
    spans.push({ start: bodyStart, end: bodyStart + body.length - 1 });
  }
  return spans;
}

/**
 * Extract the model's answer object from its output.
 *
 * Selection policy (a deliberate contract change from "the first balanced object"):
 *   1. A candidate inside a fenced block beats one outside; among fenced, prefer the last.
 *   2. Then `expectKeys` — a candidate must contain ALL expected keys to qualify.
 *   3. Then the LAST surviving candidate, not the first. The prompt demands a single
 *      object (buildPrompt :146/:153), so an earlier object is evidence of scaffolding.
 *
 * A whole-text top-level array is handled explicitly: one element unwraps, more than one
 * throws rather than silently discarding the array framing and every later element.
 */
export function extractJson(
  text: string,
  opts: ExtractJsonOptions = {},
): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try { arr = JSON.parse(trimmed); } catch { /* not a clean array — fall through */ }
    if (Array.isArray(arr)) {
      const only = arr.length === 1 ? arr[0] : undefined;
      if (only && typeof only === "object" && !Array.isArray(only)) {
        return only as Record<string, unknown>;
      }
      throw new ModelOutputParseError(
        `model output is a ${arr.length}-element JSON array where a single object was required`,
        arr.length,
        text,
      );
    }
  }

  const candidates = enumerateCandidates(text);
  if (candidates.length === 0) {
    throw new ModelOutputParseError(
      "no JSON object in model output — the model produced no answer",
      0,
      text,
    );
  }

  // 1. Fenced candidates win outright when any exist.
  const spans = fenceSpans(text);
  const fenced = candidates.filter((c) => spans.some((s) => c.start >= s.start && c.end <= s.end));
  let pool = fenced.length > 0 ? fenced : candidates;

  // 2. Expected keys — ALL must be present. If nothing matches, the signal simply does not
  //    narrow (it never widens, and it never picks a partial match).
  const keys = opts.expectKeys ?? [];
  if (keys.length > 0) {
    const matching = pool.filter((c) =>
      keys.every((k) => Object.prototype.hasOwnProperty.call(c.value, k)),
    );
    if (matching.length > 0) pool = matching;
  }

  // 3. Refuse to guess when the caller had nothing to score against.
  if (pool.length > 1 && opts.requireUnambiguous === true) {
    throw new ModelOutputParseError(
      "ambiguous model output — several JSON objects and no output schema to choose between them",
      pool.length,
      text,
    );
  }

  return pool[pool.length - 1]!.value;
}

/** Property names declared by a resolved output schema (the single-output key signal). */
function schemaPropertyNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.["properties"];
  return props && typeof props === "object" ? Object.keys(props as Record<string, unknown>) : [];
}

/**
 * Build the extractor's options for a chair from what the invoker already resolved.
 * Shared by the Claude and completions invokers so the key signal reaches every call site —
 * behaviour propagates through the shared import, but `expectKeys` does not unless each
 * site passes it (#221 policy 5).
 *
 * The two prompt shapes are mutually exclusive, so the derivation is per-shape:
 *  - MULTI-output chair — buildPrompt :138-147 asks for a blob keyed by type slug, so the
 *    slugs are the expected keys.
 *  - SINGLE-output chair — buildPrompt :148-155 asks for the bare data object, never
 *    wrapped in {"<type-slug>": …}. The signal is the schema's REQUIRED field names —
 *    the contract's floor, which every compliant emission must carry — falling back to
 *    property names when the schema requires nothing. Required-first became necessary
 *    with the producer/enforcer unification (2026-08-08): the schema here is now the
 *    EFFECTIVE one, whose property list includes every core-inherited optional field;
 *    under all-must-match semantics, all-props would demand keys no emission carries
 *    and the signal would never narrow. (It was also quietly too strict before — a
 *    candidate omitting a declared-optional field failed the old all-props signal.)
 *  - Neither available (bare core type, or a domain type absent from the registry) —
 *    no signal, so refuse to guess between rival candidates.
 */
export function extractOptionsForChair(
  sealTypes: readonly string[],
  schema: Record<string, unknown> | undefined,
): ExtractJsonOptions {
  if (sealTypes.length > 1) return { expectKeys: [...sealTypes] };
  const req = Array.isArray(schema?.["required"])
    ? (schema!["required"] as unknown[]).filter((k): k is string => typeof k === "string")
    : [];
  if (req.length > 0) return { expectKeys: req };
  const props = schemaPropertyNames(schema);
  return props.length > 0 ? { expectKeys: props } : { requireUnambiguous: true };
}

// ───────────────────── output_write capture (the write-boundary seal path) ─────────────────────
//
// A model chair on the output_write-seal path does NOT print a final-text answer — it SEALS each
// output in-band by calling `output_write`, whose payload the engine adjudicates against the full
// contract (validate-mode, returning the verdict in-band so the agent self-corrects). This reads
// those calls back out of the child's stream-json stdout: the payload of each SUCCESSFUL
// output_write call (a tool_use whose tool_result was not an error) is what the chair sealed, and
// the runtime's own boundary seals it exactly once. Because the agent corrects a rejected write by
// calling again, the LAST non-errored call per type is the one that passed.

/** The name a chair's `output_write` grant is advertised under in the spawn (mcp__<server>__<tool>),
 *  plus the bare slug for a legacy pass-through invoker. Matched by suffix so either resolves. */
function isOutputWriteToolName(name: string): boolean {
  return name === "output_write" || name.endsWith("__output_write");
}

/**
 * Did the chair ever ATTEMPT the write boundary — a call that was made, whether or not it passed?
 *
 * This is the line between two failures that look identical in the blob and are not the same defect:
 *   · ATTEMPTED and rejected → the in-band loop DID engage. The engine told the agent what was wrong
 *     and it gave up anyway. Re-prompting that is the bounded repair loop the governor rejected
 *     twice (tests/output_write_boundary.test.ts) — the agent already had its correction.
 *   · NEVER ATTEMPTED → the loop never engaged, because the agent never knocked. It produced its
 *     answer as text or a file and finished. There was no in-band frame in which to correct it.
 * Only the second is repairable, and only that one is repaired.
 */
function attemptedWriteBoundary(stdout: string): boolean {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    const msg = e["message"];
    if ((type === "assistant" || type === "user") && msg && typeof msg === "object") {
      const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) {
        if (String(b["type"] ?? "") === "tool_use" && isOutputWriteToolName(String(b["name"] ?? ""))) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the chair's sealed payloads from a stream-json stdout, keyed by the chair's seal types.
 * Returns the blob shape the runtime already consumes (a key per domain_type, or the bare data for
 * a lone single-output write), so executeChair seals it through its one boundary unchanged.
 */
/** A child that exited non-zero, carrying the stdout it produced before dying.
 *
 *  The stream is not incidental to the error — for a chair stopped by its tool budget it holds
 *  validated payloads, and discarding it destroys work the engine had already adjudicated as good.
 *  Exported because the injected-run seam (`opts.run`) is how tests reproduce a non-zero exit. */
export class ChildExitError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = "ChildExitError";
  }
}

/** The result subtype the CLI reports when `--max-turns` cut the run off.
 *
 *  This is the ONE non-success subtype whose stream is still worth reading, and the distinction is
 *  the whole of the policy: a budget stop says "the agent was interrupted", while every other error
 *  subtype says "what the agent produced is unreliable". Writes survive the first and must not
 *  survive the second. */
const BUDGET_STOP_SUBTYPE = "error_max_turns";

/** Rewrite `--max-turns` to the reserve. The continuation gets the EXTENSION as its whole budget,
 *  not a second full allowance — otherwise the grant silently doubles the chair's cost ceiling. */
function withMaxTurns(args: readonly string[], turns: number): string[] {
  const out = [...args];
  const i = out.indexOf("--max-turns");
  if (i >= 0 && i + 1 < out.length) out[i + 1] = String(turns);
  else out.push("--max-turns", String(turns));
  return out;
}

/** Swap the prompt a built arg list carries.
 *
 *  `-p` is a boolean flag with the prompt as a POSITIONAL that follows it — except on the
 *  large-prompt path, where the positional is dropped and the text goes to stdin instead. A
 *  continuation has to replace whichever form is in play, and the two are not interchangeable:
 *  editing only the stdin text would re-send the ORIGINAL prompt to a small-prompt chair, which
 *  reads as the engine ignoring its own grant. */
function withPrompt(args: readonly string[], prompt: string): string[] {
  const out = [...args];
  const i = out.indexOf("-p");
  if (i < 0) return out;
  const positionalFollows = i + 1 < out.length && !out[i + 1]!.startsWith("-");
  if (positionalFollows) out[i + 1] = prompt;
  return out;
}

// The bound on how many records ONE chair may seal for ONE declared output type. The seal path
// carries its own stated cap so the ledger guarantee is self-contained and auditable independently
// of the invocation-layer `max_tool_calls` (which is owned by a different layer and can change
// without the seal path knowing).
//
// The evidence and the choice: gig 8baced9d (lineage-deepen-v0, chair identify-external) made 15
// accepted output_write calls and sealed 1 — the observed cardinality of a legitimate high-gather
// chair is 15. The cap sits well above it (>4x headroom) so real gathering is never refused, and
// stays FINITE so a runaway seat cannot write unbounded records — an unbounded seal path is a
// denial-of-service on the ledger. Tune here, at the single declaration site, if real runs exceed
// the headroom; the (cap+1)th same-type write is refused loudly (a throw the gig surfaces), never
// dropped silently — a silent drop is exactly the "ok for a discarded record" lie this closes.
export const MAX_SEALED_RECORDS_PER_TYPE = 64;

/** One refusal the child reported: which tool, and why, from whichever field carries the reason. */
export interface SeatDenial {
  tool: string;
  reason: string;
}

/**
 * Every permission denial in a chair's stream.
 *
 * THE GAP THIS CLOSES: `grep -rn 'permission_denied' src/` returned NOTHING. The spawned child emits
 * a system event on EVERY refused tool call, the invoker already walks those exact lines, and the
 * engine read none of them. Measured across one day of real runs: 275 Bash, 36 Write and 9 Edit
 * denials, none of which surfaced anywhere an operator would look — while gig_monitor reported a
 * chair that had been refused six times, and had stopped working because of it, as RUNNING.
 *
 * Both reason fields are read because both occur in the real corpus: `message` on a
 * subcommandResults refusal, `decision_reason` on an `other`. Handling one and dropping the other is
 * a partial parse that looks like coverage.
 */
/** What kind of refusal a denial was — the distinction the seat cannot make for itself. */
export interface DenialDiagnosis {
  kind: "form-mismatch" | "not-granted" | "undetermined";
  detail: string;
}

/**
 * Decide whether a refusal means "you may not" or "you phrased it wrong".
 *
 * WHY THIS EXISTS. `permission_denied` means both, and they demand opposite responses — abandon the
 * approach, versus rephrase and continue. A chair that cannot tell them apart does the expensive
 * thing: it reasons about the refusal. Gig 486e0e6c spent its remaining budget doing exactly that.
 *
 * The pure case, measured: that chair HELD `Bash(git add:*)` and was refused `git -C /repo add -A`,
 * because the `-C` flag sits between the verb and the prefix the grant matches on. It had the
 * authority and could not reach it, and the refusal was indistinguishable from being forbidden.
 *
 * THE TEST: if the words of a grant the seat HOLDS appear IN ORDER in the refused command, the seat
 * was authorised for that verb and the FORM was wrong. Order matters — a bag-of-words match would
 * call almost anything a form mismatch.
 *
 * A HEURISTIC, NOT A PROOF, and it fails toward `undetermined` deliberately. Telling an agent to
 * rephrase a command it is genuinely forbidden would send it into a loop, which is worse than saying
 * nothing. Only Bash denials whose message actually carries the refused command text are diagnosed;
 * everything else is undetermined.
 */
export function diagnoseDenial(denial: SeatDenial, allowedTools: readonly string[]): DenialDiagnosis {
  if (denial.tool !== "Bash") {
    return { kind: "undetermined", detail: "only Bash denials carry a command this can read" };
  }
  // The refused command text follows "require(s) approval:" in the subcommandResults message.
  const m = /requires? approval:\s*(.+)$/i.exec(denial.reason);
  if (!m?.[1]) {
    return { kind: "undetermined", detail: "the refusal names no command to compare against a grant" };
  }
  const refused = m[1];
  const bashGrants = allowedTools
    .map((t) => /^Bash\(([^)]*)\)$/.exec(t)?.[1])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.replace(/:\*$/, "").trim())
    .filter((v) => v.length > 0);

  for (const grant of bashGrants) {
    const words = grant.split(/\s+/).filter(Boolean);
    // In-order containment, on word boundaries.
    let idx = 0;
    let ok = true;
    for (const w of words) {
      const at = refused.indexOf(w, idx);
      const boundedBefore = at === 0 || (at > 0 && /[\s;|&]/.test(refused.charAt(at - 1)));
      const after = at + w.length;
      const boundedAfter = after >= refused.length || /[\s;|&]/.test(refused.charAt(after));
      if (at < 0 || !boundedBefore || !boundedAfter) { ok = false; break; }
      idx = after;
    }
    if (ok) {
      return {
        kind: "form-mismatch",
        detail:
          `the seat HOLDS \`Bash(${grant}:*)\` and the refused command uses that verb — the grant is a ` +
          `PREFIX match, so a flag or path between the words (e.g. \`git -C <path> add\`) does not match ` +
          `it. Rephrase into the granted form rather than abandoning the approach.`,
      };
    }
  }
  return {
    kind: "not-granted",
    detail: "no Bash grant this seat holds covers that command — the approach needs changing, not the wording",
  };
}

export function captureSeatDenials(stdout: string): SeatDenial[] {
  const out: SeatDenial[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e["type"] !== "system" || e["subtype"] !== "permission_denied") continue;
    const reason =
      (typeof e["message"] === "string" && e["message"]) ||
      (typeof e["decision_reason"] === "string" && e["decision_reason"]) ||
      (typeof e["decision_reason_type"] === "string" && e["decision_reason_type"]) ||
      "refused, no reason given";
    out.push({ tool: typeof e["tool_name"] === "string" ? e["tool_name"] : "unknown", reason });
  }
  return out;
}

/**
 * THE SEALED RECORDS THIS SEAT'S TOOLS RETURNED (spec.coltrane-sealed-inputs law 9, Claude door).
 *
 * A completions seat's tools are in-process, so its invoker sees every result. A Claude seat calls its
 * MCP server as a CHILD, so its reads live only in the stream — the same place `captureOutputWrites`
 * reads its seals from. Every {id, content_sha} pair a tool RESULT carried is a record it was handed.
 * The seat's own `output_write` results are excluded: a chair naming its own seal as something it read
 * would be false provenance. Reported, never trusted — the runtime re-hashes each ref before stamping.
 */
export function captureSeatReads(stdout: string): Array<{ id: string; content_sha: string }> {
  const ownWrites = new Set<string>();
  const refs: Array<{ id: string; content_sha: string }> = [];
  const harvest = (value: unknown, depth = 0): void => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const v of value) harvest(v, depth + 1); return; }
    const o = value as Record<string, unknown>;
    if (typeof o["id"] === "string" && typeof o["content_sha"] === "string" && !refs.some((r) => r.id === o["id"])) {
      refs.push({ id: o["id"] as string, content_sha: o["content_sha"] as string });
    }
    for (const v of Object.values(o)) harvest(v, depth + 1);
  };
  for (const raw of stdout.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(l) as Record<string, unknown>; } catch { continue; } // a torn line is not fatal
    const msg = e["message"];
    if (!msg || typeof msg !== "object") continue;
    for (const b of ((msg as { content?: Array<Record<string, unknown>> }).content ?? [])) {
      const kind = String(b["type"] ?? "");
      if (kind === "tool_use" && isOutputWriteToolName(String(b["name"] ?? ""))) ownWrites.add(String(b["id"] ?? ""));
      if (kind !== "tool_result" || ownWrites.has(String(b["tool_use_id"] ?? ""))) continue;
      const content = b["content"];
      if (typeof content === "string") {
        try { harvest(JSON.parse(content)); } catch { /* not JSON: nothing a record could be read from */ }
      } else harvest(content);
    }
  }
  return refs;
}

export function captureOutputWrites(
  stdout: string,
  sealTypes: readonly string[],
): Record<string, unknown[]> {
  interface Write { id: string; domain_type: string; data: unknown; }
  const writes: Write[] = [];
  const errored = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    const msg = e["message"];
    if ((type === "assistant" || type === "user") && msg && typeof msg === "object") {
      const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) {
        const bt = String(b["type"] ?? "");
        if (bt === "tool_use" && isOutputWriteToolName(String(b["name"] ?? ""))) {
          const input = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
          writes.push({ id: String(b["id"] ?? ""), domain_type: String(input["domain_type"] ?? ""), data: input["data"] });
        } else if (bt === "tool_result" && b["is_error"] === true) {
          errored.add(String(b["tool_use_id"] ?? ""));
        }
      }
    }
  }
  const passed = writes.filter((w) => !w.id || !errored.has(w.id));
  // Accumulate a LIST per type — a chair may seal MANY records of one declared type (a lineage
  // scout's whole job is gathering many external hits). The old code did `byType.set(type, data)`,
  // a last-wins overwrite that kept one record and discarded the rest while every call had already
  // returned ok — the discard the change request measured. Every accepted write is now kept, up to
  // the stated cap, above which the surplus is refused loudly rather than dropped.
  const refuse = (t: string): never => {
    throw new Error(
      `chair sealed more than MAX_SEALED_RECORDS_PER_TYPE (${MAX_SEALED_RECORDS_PER_TYPE}) records ` +
        `of type "${t}" — refusing the surplus loudly. A record is being written that no seat could ` +
        `be honestly told was kept; raise MAX_SEALED_RECORDS_PER_TYPE at its declaration site if a ` +
        `real run legitimately gathers this many.`,
    );
  };
  const byType = new Map<string, unknown[]>();
  for (const w of passed) {
    const list = byType.get(w.domain_type) ?? [];
    if (list.length >= MAX_SEALED_RECORDS_PER_TYPE) refuse(w.domain_type);
    list.push(w.data);
    byType.set(w.domain_type, list);
  }
  const blob: Record<string, unknown[]> = {};
  for (const t of sealTypes) {
    if (byType.has(t)) blob[t] = byType.get(t)!;
  }
  // Single-output chairs may seal with an empty/other domain_type (buildPrompt names it, but a
  // model can still omit it). If nothing matched by name and outputs were sealed, those payloads
  // ARE the single output — key the FULL list under the promised type (carrying every one, not just
  // the last, so this branch does not silently collapse the way the whole path used to).
  if (sealTypes.length === 1 && blob[sealTypes[0]!] === undefined && passed.length > 0) {
    if (passed.length > MAX_SEALED_RECORDS_PER_TYPE) refuse(sealTypes[0]!);
    blob[sealTypes[0]!] = passed.map((w) => w.data);
  }
  return blob;
}

/**
 * contract-seat-primer-v1 (O1/I2) — the file paths a PRIME seat Read, parsed from the run's stdout the
 * SAME way `captureOutputWrites` parses its `output_write` calls: a `Read` tool_use's `file_path`. The
 * primer's `files` list is the SET of files the seat read, so paths are de-duped preserving first
 * appearance. Read through the RETURNED stdout (not the streaming `onEvent` path) because an injected
 * `run` seam bypasses streaming — the sealer must see what the run actually returned.
 */
function captureReadPaths(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    const msg = e["message"];
    if ((type !== "assistant" && type !== "user") || !msg || typeof msg !== "object") continue;
    const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
    for (const b of content) {
      if (String(b["type"] ?? "") !== "tool_use" || String(b["name"] ?? "") !== "Read") continue;
      const input = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
      const path = input["file_path"];
      if (typeof path === "string" && path.length > 0 && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
    }
  }
  return out;
}

/**
 * contract-rolling-seat-primer-v1 (O3) — the context size (input + cache_read + cache_creation) of the
 * LAST assistant usage in the run's stdout, parsed the SAME way `captureReadPaths` parses its Read
 * events. Every seat-primer records this as `context_tokens`, so the next build's `max_context_tokens`
 * ceiling can weigh the primer. Read through the RETURNED stdout (not the streaming `onEvent` path)
 * because an injected `run` seam bypasses streaming — the sealer must see what the run actually
 * returned. `undefined` when the run reported no usage (the runtime then falls back to its own
 * streamed `lastAssistantContext`, or 0).
 */
function captureLastContext(stdout: string): number | undefined {
  let last: number | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (String(e["type"] ?? "") !== "assistant") continue;
    const msg = e["message"];
    if (!msg || typeof msg !== "object") continue;
    const usage = (msg as { usage?: Record<string, number> }).usage;
    if (usage && typeof usage === "object") {
      last = (usage["input_tokens"] ?? 0) + (usage["cache_read_input_tokens"] ?? 0) + (usage["cache_creation_input_tokens"] ?? 0);
    }
  }
  return last;
}

/** The write tools whose first call ends a seat's READING (contract-primer-reading-frontier-v1 O1). */
const FRONTIER_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The input+cache_read+cache_creation of an assistant line's usage, or undefined when it carries none.
 * contract-fork-continuation-is-exact-v1 (O2) — a usage reporting NONE of the three context fields
 * (e.g. a write line carrying only `output_tokens`) contributes NO reading: it returns `undefined`, not
 * `0`, so `usage ?? lastUsageBefore` falls through to the last REPORTED reading rather than discarding
 * it. A usage reporting ANY of the three sums the ones present (a missing field as `0`), as today.
 */
function assistantContextOf(msg: unknown): number | undefined {
  const u = (msg as { usage?: Record<string, number> } | undefined)?.usage;
  if (!u || typeof u !== "object") return undefined;
  if (u["input_tokens"] === undefined && u["cache_read_input_tokens"] === undefined && u["cache_creation_input_tokens"] === undefined) {
    return undefined;
  }
  return (u["input_tokens"] ?? 0) + (u["cache_read_input_tokens"] ?? 0) + (u["cache_creation_input_tokens"] ?? 0);
}

/**
 * contract-primer-reading-frontier-v1 (O1/O3/O4/I2/I3/F1) — a seat-primer is forked at its READING
 * FRONTIER: the point where the seat stopped reading and started writing. Parsed over the concatenated
 * seal stdout (every spawn, in order — so a first write in a reserve continuation is found, I2):
 *   · `frontier` — the uuid of the last `type:"user"` line before the FIRST assistant line whose content
 *     calls a write tool (Write/Edit/MultiEdit/NotebookEdit). No write, or no user line before it (F1),
 *     yields no frontier.
 *   · `context_tokens` — WITH a frontier, the context of that first-write assistant line (its own usage,
 *     or the last usage before it); WITHOUT one, the seat's LAST usage exactly as today (I3/F1).
 *   · `reads` — WITH a frontier, the Read paths on assistant lines BEFORE the FRONTIER line — the reads
 *     the cut conversation holds. contract-fork-continuation-is-exact-v1 (O3): the frontier is the last
 *     `user` line before the first write, so a Read in the write's OWN turn (after that user line, with
 *     no user line between it and the write) is AFTER the frontier and is NOT recorded. Reads since the
 *     last user line are PENDING; a user line commits them, and the first write discards the pending set.
 *     WITHOUT a frontier, every Read as today.
 * Derived by the engine from the stream, never typed by the model.
 */
function captureReadingFrontier(stdout: string): { frontier?: string | undefined; context_tokens?: number | undefined; reads: string[] } {
  let lastUserUuid: string | undefined;
  let lastUsageBefore: number | undefined;
  const readsBefore: string[] = [];       // reads BEFORE the frontier line (committed at each user line)
  let pendingReads: string[] = [];        // reads SINCE the last user line — not yet before a frontier
  const seen = new Set<string>();
  let frontier: string | undefined;
  let firstWriteContext: number | undefined;
  let foundWrite = false;
  const commitPending = (): void => {
    for (const p of pendingReads) if (!seen.has(p)) { seen.add(p); readsBefore.push(p); }
    pendingReads = [];
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    if (type === "user") {
      if (typeof e["uuid"] === "string") lastUserUuid = e["uuid"] as string;
      // reads seen since the last user line are now BEFORE a user line ⇒ before any later frontier (O3)
      commitPending();
      continue;
    }
    const msg = e["message"];
    if (type !== "assistant" || !msg || typeof msg !== "object") continue;
    const content = (msg as { content?: Array<Record<string, unknown>> }).content ?? [];
    const usage = assistantContextOf(msg);
    if (content.some((b) => String(b["type"] ?? "") === "tool_use" && FRONTIER_WRITE_TOOLS.has(String(b["name"] ?? "")))) {
      foundWrite = true;
      frontier = lastUserUuid;                 // undefined ⇒ no user line before the write ⇒ no frontier (F1)
      firstWriteContext = usage ?? lastUsageBefore;
      // pendingReads (this write's OWN turn, after the frontier) are DISCARDED — the cut ends before them
      break;
    }
    for (const b of content) {
      if (String(b["type"] ?? "") !== "tool_use" || String(b["name"] ?? "") !== "Read") continue;
      const input = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
      const path = input["file_path"];
      if (typeof path === "string" && path.length > 0 && !seen.has(path) && !pendingReads.includes(path)) { pendingReads.push(path); }
    }
    if (usage !== undefined) lastUsageBefore = usage;
  }
  // A frontier requires BOTH a write AND a user line before it. Otherwise the primer is as today:
  // the last usage over the whole run, and every Read.
  if (foundWrite && frontier !== undefined) {
    return { frontier, context_tokens: firstWriteContext, reads: readsBefore };
  }
  return { context_tokens: captureLastContext(stdout), reads: captureReadPaths(stdout) };
}

// The wall-clock bound on one chair's spawn. A tool-granted child has no inherent
// terminus (it can search/loop), and the gig runs the spawn synchronously — so without
// this bound one wedged child wedges the whole server. SIGKILL, not SIGTERM: a
// signal-trapping child can't outlive its budget. Long enough for a tool-using chair
// (a capped search agent runs minutes), far below an operator-visible hang.
//
// RAISED FROM TEN MINUTES, from measurement rather than preference. A reading seat over a
// 1000-line specification and its test suite was killed here twice, both times mid
// `output_write` — the bound was cutting the WRITE, not the reading, and the two sibling seats
// that survived cleared it by 57s and 85s. A seat that dies at the wall seals nothing and, worse,
// reports no usage, so the spend is real and the ledger never sees it. Ten minutes was under the
// honest cost of a chair that reads a corpus and then writes a structured document about it.
//
// Twenty and not more: `tests/invoker_timeout.test.ts` fences this value between five and twenty
// minutes on the argument that the default must stay "far below an operator-visible hang", and
// that band is a deliberate guard rather than an accident. This sits at its ceiling. A deployment
// that genuinely needs longer has the per-chair override (`COLTRANE_CHAIR_TIMEOUT_MS`) and does
// not need the shipped default moved. Note the cost of raising it: `src/runtime.ts:1135` observes
// that a standard with P sequential phases can burn P x this value after `gig_abort` returns, so
// doubling the bound doubles that worst-case drag.
export const DEFAULT_CHAIR_TIMEOUT_MS = 20 * 60_000;

// How long a cancelled chair child gets to shut down politely before it is killed outright.
// SIGTERM first (a `claude` child spawns its own MCP servers; a cooperative exit gives it a
// chance to take them with it), SIGKILL after. Deliberately NOT `detached: true` +
// process.kill(-pid): that is the only airtight answer to grandchild orphaning, but it takes
// children OUT of the server's process group, so an operator's Ctrl-C stops reaching them —
// which makes #252 worse, not better. Process-group kill is a separate decision.
export const DEFAULT_ABORT_GRACE_MS = 2_000;

// #250/#252 — every chair child the invoker spawns, so something can reach them.
// Before this, `child` was a const inside spawnStreaming's promise executor: never returned,
// never registered, never exposed, and the ONLY path to child.kill was the timeout closure.
// A server told to shut down could not stop its own grandchildren, which kept running,
// orphaned, still billing — with gig tracking dropped, so nothing recorded they existed.
const LIVE_CHAIR_CHILDREN = new Set<ChildProcess>();

/** How many chair children are alive right now (observability for the shutdown path). */
export function liveChairChildCount(): number {
  return LIVE_CHAIR_CHILDREN.size;
}

/** SIGTERM every live chair child, escalating to SIGKILL after `graceMs`. Returns the count
 *  signalled. Called on server shutdown so a restart is not an orphaning. */
export function killLiveChairChildren(graceMs = DEFAULT_ABORT_GRACE_MS): number {
  const victims = [...LIVE_CHAIR_CHILDREN];
  for (const c of victims) terminateChild(c, graceMs);
  return victims.length;
}

function terminateChild(child: ChildProcess, graceMs: number): void {
  const hardKill = (): void => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  if (graceMs <= 0) { hardKill(); return; }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) hardKill();
  }, graceMs);
  // never hold the event loop open just to escalate a kill
  t.unref?.();
}

// Spawn bounds passed to the run seam (execFileSync options in the default runner).
export interface SpawnBounds {
  timeout: number;
  killSignal: "SIGKILL";
}

export interface ClaudeInvokerOptions {
  bin?: string | undefined; // default "claude"
  model?: string | undefined; // passed to --model if set
  /**
   * Turns granted ONCE, as a reserve, to a chair that exhausted its declared turn budget.
   *
   * `--max-turns` is a hard CLI bound with no callback, so without this a chair learns its budget
   * only by dying at it — cut off mid-reach, before it can write the boundary record that says what
   * it did NOT get to. The reserve turns that silent truncation into a stated one: the chair is told
   * it is in reserve, how many turns remain, and what it already sealed, and is asked to close out.
   *
   * It cannot be delivered in-band. A chair's tools are typically HOST tools (WebSearch, WebFetch)
   * that the child's own coltrane server never sees, so the engine surface cannot count turns. The
   * parent sees every turn in the stream, and its only channel into a running child is a new
   * invocation — hence a continuation rather than a signal.
   *
   * ONE extension, never a loop: an unbounded "just a bit more" is not a budget. Unset = the prior
   * behaviour exactly (keep whatever passed the write boundary, grant nothing).
   */
  turn_reserve?: number | undefined;
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
  // Injectable spawn (tests). The venue → dispatch wire feeds the constructed child env as the 4th
  // argument; a venue-less dispatch passes `undefined` (the child inherits the ambient env).
  run?: ((bin: string, args: string[], spawn: SpawnBounds, env?: Record<string, string>) => string | Promise<string>) | undefined;
  // Per-deployment override of the per-chair wall-clock bound.
  timeout_ms?: number | undefined;
  // Grace between SIGTERM and SIGKILL when a chair is cancelled. Override in tests.
  abort_grace_ms?: number | undefined;
  // When set, the spawned child receives COLTRANE_PARENT_SESSION_ID so its first
  // recorded turn seals the lineage edge to its parent.
  parent_session_id?: string | undefined;
  /**
   * How a model chair produces its sealed output.
   *  - "output_write" (production): the chair SEALS IN-BAND by calling `output_write` during its
   *    run. The spawn advertises `mcp__coltrane__output_write` and its coltrane server runs in
   *    validate-mode (COLTRANE_OUTPUT_WRITE_MODE=validate), so each call adjudicates the payload
   *    against the FULL seal predicate and returns the verdict in-band — the agent self-corrects
   *    within its single run. The invoker captures the validated payload from the chair's
   *    successful output_write calls; the runtime (executeChair) is the ONE sealer.
   *  - "text" (default, and every injected-run test): the chair prints final-text JSON, which the
   *    invoker extracts and hands back for the runtime to seal at its boundary. Unchanged legacy
   *    behaviour, so a bare/test invoker is unaffected.
   */
  sealVia?: "text" | "output_write" | undefined;
}

// The blast-radius cage, PURE. Given the agent's tool grant + a per-gig mcp-config path,
// build the claude CLI args. Two halves: `--strict-mcp-config` + `--mcp-config <path>`
// means the spawn loads ONLY the servers in that file (never the host's ambient MCP) —
// deny-by-default. `--allowedTools`/`--disallowedTools` scope the tool surface to the
// agent's declared grant. Ports OG's claude-launcher 4-flag cage.
/**
 * Default ceiling for a prompt carried as a command-line argument.
 *
 * Windows caps a whole command line at ~32,767 characters. The prompt is not the only thing on
 * it — the mcp-config path, the model, and the allow/deny tool lists ride along — so the
 * threshold sits well below the cap rather than at it.
 */
export const PROMPT_ARG_LIMIT_DEFAULT = 16_000;

function promptArgLimit(): number {
  const raw = process.env["COLTRANE_PROMPT_ARG_LIMIT"];
  if (!raw) return PROMPT_ARG_LIMIT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : PROMPT_ARG_LIMIT_DEFAULT;
}

/**
 * Whether this prompt must be delivered on the child's stdin instead of its command line.
 *
 * The engine used to put every chair prompt in argv. On Windows a strategize-phase prompt
 * (blueprint + draft + review) exceeds the command-line cap and the spawn dies with
 * ENAMETOOLONG — reported by a consumer as "broken on Windows … local dev was practically
 * unusable", and worked around downstream by monkey-patching `child_process.spawn` against
 * this module's built output. That patch is coupled to argv construction here and breaks
 * SILENTLY if it changes, so the fix belongs in the engine.
 *
 * `COLTRANE_PROMPT_MODE` forces `arg` or `stdin`; anything else, including a typo, falls back
 * to the size test rather than failing a dispatch.
 */
export function promptViaStdin(prompt: string): boolean {
  const mode = process.env["COLTRANE_PROMPT_MODE"];
  if (mode === "arg") return false;
  if (mode === "stdin") return true;
  return prompt.length > promptArgLimit();
}

/**
 * The `claude` session id a chair's conversation is NAMED by, derived deterministically from
 * `(gig_id, role)`. The same seat used twice in one gig derives the SAME uuid, so its second reach
 * can `--resume` the conversation the first opened instead of re-reading cold; two roles in one gig,
 * or one role across two gigs, never collide (a v5-shaped uuid over a `gig_id\x1frole` string).
 *
 * A gig-less invocation (no `gig_id`) returns undefined: with nothing to key the session on there is
 * nothing to name and nothing to resume, so the spawn carries neither `--session-id` nor `--resume`.
 * The uuid is a valid RFC 4122 string (version nibble 5, variant 8–b) so the CLI accepts it as a
 * session id and the spec's UUID shape holds.
 */
export function sessionUuidFor(gig_id: string | undefined, role: string | undefined): string | undefined {
  if (!gig_id) return undefined;
  const h = createHash("sha1").update(`coltrane-chair-session${gig_id}${role ?? ""}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Rewrite a built arg list to RESUME a session rather than open one: it must carry EXACTLY ONE
 * `--resume <uuid>` naming the session to CONTINUE, and none of the flags that open or fork a fresh
 * conversation. A resume must not ALSO name a fresh session (`--session-id`, which the CLI reads as
 * opening, not continuing), nor re-run a warm start: for a FORK chair `baseArgs` is the first-spawn
 * warm start `--resume <primer> --resume-session-at <frontier> --fork-session --session-id <own>`
 * (contract-fork-continuation-is-exact-v1 O1), and a continuation of that chair's OWN session carries
 * none of it — the warm start belongs to the FIRST spawn only. So every `--session-id`,
 * `--resume-session-at` and inherited `--resume` PAIR is dropped (flag and value), `--fork-session`
 * (valueless) is dropped, and a single `--resume <sessionId>` is appended.
 */
function withResume(args: readonly string[], sessionId: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    // drop each opening/warm-start flag AND its value — a continuation resumes ONE session and no more
    if (args[i] === "--session-id" || args[i] === "--resume" || args[i] === "--resume-session-at") { i++; continue; }
    if (args[i] === "--fork-session") continue; // valueless flag: the warm start belongs to the first spawn
    out.push(args[i]!);
  }
  out.push("--resume", sessionId);
  return out;
}

/**
 * Did a `--resume` run fail because its session could not be found? The CLI reports a missing resume
 * target as an error result whose text names it ("No conversation found with session ID …"). Read
 * from the child's stream so it is caught whether the run resolved with the error result or threw a
 * non-zero exit carrying the same stdout. Deliberately narrow — a result event's text, not any line —
 * so an ordinary failure is never mistaken for a lost session (F1).
 */
function resumeSessionLost(stdout: string): boolean {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e["type"] !== "result") continue;
    const txt = typeof e["result"] === "string" ? (e["result"] as string) : "";
    if (/no conversation found|no such session|session .*not found/i.test(txt)) return true;
  }
  return false;
}

/**
 * contract-primer-reading-frontier-v1 (F2) — did a fork fail because its `--resume-session-at` named a
 * message uuid the primer's session does not hold? claude 2.1.274 (probed 2026-09-18) exits 1 with the
 * notice `No message found with message.uuid of: <uuid>` on stderr (so in the ChildExitError message),
 * and a stdout result event that carries it ONLY in `errors: [...]` — there is no `result` text, so
 * `resumeSessionLost` (which reads `result` alone) cannot see it. Detect it in EITHER place, next to
 * `resumeSessionLost`, so the unresolvable-frontier fork takes the cold fallback rather than failing.
 */
function frontierNotFound(stdout: string, message: string): boolean {
  const re = /no message found with message\.uuid of/i;
  if (re.test(message)) return true;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e["type"] !== "result") continue;
    const errs = e["errors"];
    if (Array.isArray(errs) && errs.some((x) => typeof x === "string" && re.test(x))) return true;
    const txt = typeof e["result"] === "string" ? (e["result"] as string) : "";
    if (re.test(txt)) return true;
  }
  return false;
}

/**
 * Did a spawn fail because the `--session-id` it opened with is ALREADY IN USE? A chair's session id
 * is deterministic in `(gig_id, role)`, so a KILLED attempt that already opened it leaves the id live;
 * a resumed gig's first spawn re-opens it and the CLI refuses it (`Error: Session ID <uuid> is already
 * in use.`). Reported both as an error result in the stream AND in the non-zero exit message, so read
 * both — the exit `message` and the result stream (like `resumeSessionLost`) — and catch it whichever
 * carries it. This is the COLLISION case the LOST case (`resumeSessionLost`) does NOT cover; the two
 * are disjoint (one names "already in use", the other "no conversation found").
 */
function sessionIdInUse(stdout: string, message: string): boolean {
  const inUse = /session id .*is already in use/i;
  if (inUse.test(message)) return true;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e["type"] !== "result") continue;
    const txt = typeof e["result"] === "string" ? (e["result"] as string) : "";
    if (inUse.test(txt)) return true;
  }
  return false;
}

/** The `sandbox` block of a seat's --settings (Claude Code's OS sandbox for Bash). */
export interface BashSandbox {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  filesystem: { allowWrite: string[]; denyWrite: string[] };
}

/**
 * THE BASH SANDBOX FOR A SEAT RUNNING IN `tree` (an ABSOLUTE path). A Bash grant is a command prefix,
 * not a path: `Bash(sed:*)` can `sed -i` any file. So every seat that holds Bash spawns inside the
 * CLI's OS sandbox:
 *   · enabled, and failIfUnavailable — a host with no sandbox REFUSES the seat, never runs it bare;
 *   · allowUnsandboxedCommands false and no excludedCommands — no escape hatch for any command;
 *   · writes allowed in the tree (the seat's own cwd stays writable by the CLI's default), and DENIED
 *     for <tree>/coltrane.layout.json (the grant boundary), <tree>/.git (hooks, config, refs) and
 *     <tree>/.claude (settings the next seat would load), and <tree>/.coltrane (the engine's own state:
 *     ledger, checkpoints, locks — which the diff gate cannot judge, because the engine writes it too).
 *     denyWrite beats allowWrite.
 * ABSOLUTE paths only: the CLI silently IGNORES a relative sandbox path (measured, 2.1.283) — a
 * relative deny is a deny that is not there. A non-absolute tree is refused rather than emitted.
 * What the sandbox cannot see is what Bash changed INSIDE the tree; the post-seat diff gate in runGig
 * judges that against the seat's Write/Edit scope.
 */
export function bashSandboxFor(tree: string): BashSandbox {
  if (!posixPath.isAbsolute(tree)) {
    throw new Error(`the Bash sandbox needs an ABSOLUTE tree path, got "${tree}" — a relative sandbox path is silently ignored by the CLI`);
  }
  const t = tree.length > 1 ? tree.replace(/\/+$/, "") : tree;
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [t],
      denyWrite: [`${t}/${LAYOUT_FILE}`, `${t}/.git`, `${t}/.claude`, `${t}/.coltrane`],
    },
  };
}

export function buildInvokerArgs(
  prompt: string,
  mcpConfigPath: string,
  opts: { model?: string | undefined; allowed_tools?: readonly string[] | undefined; disallowed_tools?: readonly string[] | undefined; max_tool_calls?: number | undefined; effort?: Effort | undefined; session_id?: string | undefined; resume?: boolean | undefined; fork_from_session?: string | undefined; resume_session_at?: string | undefined; sandbox?: BashSandbox | undefined },
): string[] {
  // `-p` is a BOOLEAN flag and the prompt is a POSITIONAL argument, which is what makes the
  // large-prompt path clean: keep the flag, drop the positional, write it to stdin. The
  // downstream patch drops `-p` as well and lets the CLI infer print mode from a non-TTY
  // stdin; keeping the flag states it, and costs nothing.
  const args = promptViaStdin(prompt) ? ["-p"] : ["-p", prompt];
  if (opts.model) args.push("--model", opts.model);
  // contract-chair-session-continuity-v1 — NAME the chair's conversation so a second reach can
  // resume it. Every spawn with a session id opens one with `--session-id`; a re-invocation that
  // is resuming (the amend round) carries `--resume` instead — never both, or the CLI opens a
  // fresh session rather than continuing. A gig-less spawn has no session id and carries neither.
  // contract-seat-primer-v1 (O2) — a FORK chair's FIRST spawn WARM-STARTS: it `--resume`s the primer
  // seat's session, `--fork-session`s that conversation into a NEW branch, and names THAT branch with
  // its own (gig, role) `--session-id`. Distinct from an amend `--resume` (which continues the SAME
  // session under the same id): a fork opens its own session forked FROM another's.
  if (opts.fork_from_session && opts.session_id) {
    args.push("--resume", opts.fork_from_session);
    // contract-primer-reading-frontier-v1 (O2) — a fork of a primer that recorded a reading FRONTIER
    // CUTS the resumed conversation there: `--resume-session-at <frontier>` starts the branch with the
    // conversation as it stood after that message, so the fork loads what the primer READ, never what
    // it then DID. A frontier-less primer carries none, so the whole session resumes exactly as today.
    if (opts.resume_session_at) args.push("--resume-session-at", opts.resume_session_at);
    args.push("--fork-session", "--session-id", opts.session_id);
  } else if (opts.session_id) {
    if (opts.resume) args.push("--resume", opts.session_id);
    else args.push("--session-id", opts.session_id);
  }
  // per-agent blast-radius cap: a runaway agent can't burn past its own turn budget.
  if (opts.max_tool_calls !== undefined) args.push("--max-turns", String(opts.max_tool_calls));
  // #seat-effort (O3/I2) — the spawn ALWAYS carries exactly one --effort, whatever depth or turn
  // budget applies. Floored to `medium` here so a hand-built ctx that resolved to no effort still
  // gets an explicit level rather than inheriting the operator's ~/.claude/settings.json effortLevel
  // — the measured defect. The invoke door passes the resolved `ctx.effort ?? "medium"`.
  args.push("--effort", opts.effort ?? "medium");
  // the cage floor: no ambient MCP servers leak into the spawn, ever.
  args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  // The OTHER half of that floor, and it was missing. A seat's cwd is a freshly cloned repository
  // (drain-loop.sh clones per gig and runs the engine inside it), so anything the repo carries is
  // untrusted input. Verified against the CLI rather than assumed:
  //
  //   .claude/settings.json  hooks EXECUTE — arbitrary commands, no model in the loop
  //   CLAUDE.md              is obeyed — repo text becomes instructions in the seat's context
  //
  // Both are real today and both stop with `--setting-sources user`, confirmed by running it.
  //
  // `user` and not `user,project`: project settings are exactly the untrusted half. Coltrane loses
  // nothing by excluding them — an agent's identity, method and constraints come from the GENOME,
  // loaded from the store, never from a file in the working tree. A repo that could redefine the
  // agent reading it would be editing the genome through the back door.
  //
  // This is what makes one gig's write to a repo stop being every later gig's execution.
  args.push("--setting-sources", "user");
  // contract-seat-memory-v1 (O1/I1) — a seat's writes are its grants; the operator's auto-memory is
  // NOT a seat's to write. Measured: a `claude -p` seat spawned as chairs are (`--setting-sources
  // user`) wrote ~/.claude/projects/<repo>/memory/, loaded by every later session in the repo.
  // `--setting-sources user` bounds which settings FILES load; it does not turn the auto-memory tool
  // off. Pass exactly ONE `--settings` whose JSON disables it, here at the single point every spawn
  // kind is built from (first run, resumed amend, reserve continuation, cold fallback), so the pair
  // rides through every arg-list transform. Disjoint from --setting-sources / --effort / the session
  // flags, so the effort and session-continuity contracts are untouched.
  //
  // THE BASH SANDBOX rides in the SAME --settings JSON (bashSandboxFor): exactly one --settings, so
  // no second settings source can merge beside it.
  args.push("--settings", JSON.stringify({ autoMemoryEnabled: false, ...(opts.sandbox ? { sandbox: opts.sandbox } : {}) }));
  if (opts.allowed_tools && opts.allowed_tools.length > 0) args.push("--allowedTools", opts.allowed_tools.join(","));
  if (opts.disallowed_tools && opts.disallowed_tools.length > 0) args.push("--disallowedTools", opts.disallowed_tools.join(","));
  return args;
}

// The production AgentInvoker. Writes a per-gig mcp-config (the permitted servers only),
// spawns `claude -p` inside the cage, parses the JSON. The spawn is the non-deterministic
// seam (inject `run` to test the cage args + parse without the CLI). When a
// parent_session_id is provided, every spawned MCP server in this child receives it via
// env so the recorder seals the parent → child lineage edge on the child's first turn.
/**
 * Names a seat must never see, whatever else it inherits.
 *
 * A DENY-list, deliberately, even though deny-lists are the weaker construction — the allowlist in
 * `SeatRealization.env` is the real control and this exists only for the paths that do not reach
 * it. A floor is worth having precisely because it protects the case nobody remembered to declare.
 *
 * The rule for adding a name: would possession of this let the holder act AS THE BOX, rather than
 * as the work the box was given? `COLTRANE_DRAIN_KEY` is the clearest case — it is the venue's
 * whole identity. `CLAUDE_CODE_OAUTH_TOKEN` deliberately is NOT here: a seat is a `claude -p`
 * process and that is how it authenticates to run at all.
 */
const BOX_CREDENTIAL_ENV = [
  "COLTRANE_DRAIN_KEY",        // the venue's identity: claims gigs, reads the org's whole Vault
  "COLTRANE_DRAIN_URL",        // paired with it; together they are the provisioning endpoint
  "COLTRANE_PROVISIONER_KEY",  // mints drain keys — strictly more authority than the drain key
  "SUPABASE_SERVICE_ROLE_KEY", // bypasses RLS entirely
  "SUPABASE_SECRET_KEY",
  "FLY_API_TOKEN",             // creates and destroys machines
  "GITHUB_APP_PRIVATE_KEY_B64",
] as const;

/** Everything except the box's own credentials. Returns a plain object, so the spawn is given an
 *  explicit environment rather than inheriting one — the difference matters when a new secret is
 *  added to the container and nobody revisits this file. */
export function withoutBoxCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const denied = new Set<string>(BOX_CREDENTIAL_ENV);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (denied.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * contract-seat-ask-v1 — the hands-off interrogation seam a makeClaudeInvoker carries ALONGSIDE its
 * AgentInvoker call signature. `askSeat` resumes a PAST seat's own session — the uuid
 * sessionUuidFor(gig_id, role), the SAME derivation the amend loop uses — and returns its prose. It
 * shares the invoker's `run` seam, spawn bounds and cage builder, but it is NOT the chair path: it
 * resolves no grants, builds no identity/method/input prompt, and seals nothing. A resume whose
 * session is gone yields `session_lost` — never a fresh --session-id seat, which would invent the
 * reasoning this verb exists to prevent.
 */
export type SeatAskResult =
  | { answer: string; session_id: string; resumed: true }
  | { session_lost: true; session_id: string | undefined };
export interface SeatAsker {
  askSeat(input: { gig_id: string; role: string; question: string; max_turns?: number | undefined }): Promise<SeatAskResult>;
}
export type ClaudeInvoker = AgentInvoker & SeatAsker;

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
  const abortGraceMs = opts.abort_grace_ms ?? DEFAULT_ABORT_GRACE_MS;
  const sealViaOutputWrite = opts.sealVia === "output_write";
  // A reserve is a grant, so an absent or nonsensical one grants nothing rather than defaulting to
  // some house number — an extension the author did not ask for is spend they did not authorise.
  // #turn-budget — resolved PER INVOCATION so the chair-scoped reserve (ctx.turn_reserve, the pool-
  // capped offer the runtime threads) wins over the invoker-level default (opts.turn_reserve). Both
  // pass through the identical > 0 floor. ctx.turn_reserve === 0 (a declared chair whose pool was
  // dry) is a hard zero, NOT a fall-through to opts — 0 is not nullish, so `??` stops there.
  const resolveReserveTurns = (ctxReserve: number | undefined): number => {
    const src = ctxReserve ?? opts.turn_reserve;
    return Number.isFinite(src) && (src ?? 0) > 0 ? Math.floor(src!) : 0;
  };
  // The core type each domain type extends — the `core_type` the agent must pass to output_write.
  const coreTypeOf = (slug: string): string => {
    if ((CORE_TYPES as readonly string[]).includes(slug)) return slug;
    const dt = opts.registry?.listTypes().find((t) => t.slug === slug);
    return dt ? dt.extends : "";
  };
  const invoke: AgentInvoker = async (ctx) => {
    // #250 — a chair whose gig is already cancelled spends nothing: no prompt, no mcp-config,
    // no spawn. This is the cheapest point on the whole cancellation chain.
    if (ctx.signal?.aborted) {
      throw new Error(`chair "${ctx.agent.slug}" not started — gig aborted (${abortReasonText(ctx.signal)})`);
    }
    // LAYOUT GRANTS — the seat's grants come from the layout of the repository it runs against
    // (src/layout_grants.ts): role tokens expand through ctx.layout, Write/Edit narrow to the change's
    // target_paths. A token the layout cannot answer grants nothing and REFUSES the chair here, before
    // anything is spawned — never a `**` default. From here on the chair's agent carries its RESOLVED
    // grants, so provider resolution, the room's ceiling, the host-builtin complement and the prompt
    // all see what the seat actually holds, never a raw token. The room is applied below, by the
    // existing venue block, over these resolved grants. `denials` (the layout file, never writable)
    // join the --disallowedTools union.
    const seatGrants = resolveSeatGrants({ agent: ctx.agent, layout: ctx.layout, target_paths: targetPathsOf(ctx.gig_input) });
    if (seatGrants.refusals.length > 0) {
      throw new Error(`chair "${ctx.agent.slug}" refused before spawn: ${describeRoleRefusals(ctx.agent.slug, seatGrants.refusals)}`);
    }
    if (ctx.agent.allowed_tools !== undefined) {
      ctx = { ...ctx, agent: { ...ctx.agent, allowed_tools: seatGrants.grants } };
    }
    // Resolve THIS agent's grants → the MCP servers it needs, FIRST: a grant with no resolvable
    // provider is a dead name, so fail the chair closed before we build a prompt or spawn a child
    // that advertises a tool it can't call.
    let resolvedMcpServers: Record<string, unknown> = {};
    // The grants as the SPAWN must see them in --allowedTools. Default to the raw grant list (the
    // legacy pass-through invoker); when resolution is on, use the resolved names — an in-house engine
    // tool granted by bare slug becomes mcp__<server>__<tool>, the name its server advertises (#204).
    let effectiveAllowed: readonly string[] | undefined = ctx.agent.allowed_tools;
    if (resolutionEnabled) {
      // resolveAgentGrants folds the deny-by-default browser cage this agent's browser_grant builds
      // (an agent that grants mcp__playwright__* but declares NO browser_grant has no playwright
      // config → unresolvable → fails closed, no uncaged browser ever) and resolves every grant. It
      // is the ONE place per-agent resolution happens — shared with runGig's dispatch preflight so
      // the two resolve against the IDENTICAL environment (no drift between what preflight checks and
      // what this chair gets). This per-chair throw stays the fail-closed BACKSTOP: the preflight
      // refuses a doomed gig at t=0, but any chair reached by another path still fails closed here,
      // before a child is spawned that advertises a tool it cannot back.
      const resolved = resolveAgentGrants(
        ctx.agent,
        opts.toolProviders ?? EMPTY_TOOL_REGISTRY,
        opts.mcpServerConfigs ?? {},
      );
      if (resolved.unknown.length > 0) {
        throw new Error(
          `agent "${ctx.agent.slug}" grants unresolvable tool(s) [${resolved.unknown.join(", ")}] — no provider registered ` +
            `(a granted tool with no provider is a dead name; register a provider or remove the grant)`,
        );
      }
      resolvedMcpServers = resolved.mcpServers;
      effectiveAllowed = resolved.effectiveAllowed;
    }
    // VENUE CONFINEMENT BY CONSTRUCTION. When the dispatch path resolved a room for this chair
    // (ctx.realization + ctx.venue both threaded by runGig), the spawn reflects the realization:
    //  - `--allowedTools` carries venueEffectiveTools(agent, venue) — the SAME shared oracle the
    //    compose-time R10 check refuses against (src/chart.ts), never a re-inlined intersection and
    //    never the un-intersected grant, so runtime enforcement and compose-time refusal cannot
    //    drift — with each surviving grant RESOLVED to the name its server advertises (#204). The
    //    intersection is unchanged; only the advertised name is (narrow-then-rename, never widen).
    //  - the child env is the realization's deny-by-default allowlist (SeatRealization.env, `{}` when
    //    the surface admits nothing), so an undeclared ambient credential never reaches the child.
    // Narrowed BEFORE the in-band-seal block below, so the engine's own output_write grant — engine
    // mechanism, not an optional capability — is re-added on top of the room's ceiling. Absent on
    // either field → the un-narrowed path above stands and no child env is constructed (INV10).
    let childEnv: Record<string, string> | undefined;
    if (ctx.realization && ctx.venue) {
      // NARROW then RENAME. venueEffectiveTools is the shared oracle R10 refuses against; it returns
      // the agent's RAW grant strings intersected with the room's equipment — so the CEILING decision
      // stays on raw grants and cannot drift from the compose-time check. But those raw strings are
      // still bare in-house slugs; advertising them un-resolved reopens #204 (a seat granting bare
      // `type_browse` advertises `type_browse` while the engine server advertises
      // `mcp__coltrane__type_browse`, so the call is DENIED — measured, gig 11744aa5). Resolve the
      // ALREADY-NARROWED list so only the ADVERTISED name changes; the intersection is untouched, so
      // the ceiling narrows, it never widens. Resolution off → keep the raw narrowed list (INV1/INV10).
      const narrowed = venueEffectiveTools(ctx.agent, ctx.venue);
      effectiveAllowed = resolutionEnabled
        ? resolveAgentGrants(
            { ...ctx.agent, allowed_tools: narrowed },
            opts.toolProviders ?? EMPTY_TOOL_REGISTRY,
            opts.mcpServerConfigs ?? {},
          ).effectiveAllowed
        : narrowed;
      const seat = ctx.realization.seats.find((s) => s.agent_slug === ctx.agent.slug);
      childEnv = seat?.env ?? {};
    } else {
      // THE FLOOR BENEATH THE ALLOWLIST. Above is deny-by-default and is the right answer — but it
      // only engages when a gig names a venue, and the drain names none (worker.ts passes no
      // `venue` to runGig). So on the live path every seat inherited process.env WHOLESALE.
      //
      // On a Fly drain that env holds COLTRANE_DRAIN_KEY, because Fly surfaces secrets to the whole
      // container and start.sh filters only the vault half. Seats are `claude -p` with Bash. So
      // `env | grep COLTRANE_DRAIN_KEY` from inside any seat yields the credential that IS the box:
      // it reads the org's entire Vault through coltrane_venue_provision, and under the proposed
      // git-credential design it would mint GitHub tokens too.
      //
      // That makes "the drain presents its key" mean "anything running inside the drain presents
      // its key" — which is not an authenticator at all. Stripping here does not fix the
      // authenticator, but it removes the credential from the reach of the untrusted thing.
      childEnv = withoutBoxCredentials(process.env);
    }
    // WIRE THE IN-BAND SEAL. A model chair on the output_write-seal path must be able to CALL
    // output_write regardless of what it declared in allowed_tools — the seal is engine mechanism,
    // not an optional capability. Bridge the engine's own MCP server into the spawn and add the
    // output_write grant so the child can reach it. Gated on the engine server config being wired
    // (bootstrapServerDeps always supplies it); a bare/test invoker without it captures from the
    // injected stream instead of a real spawn, so it needs no grant.
    const engineServerCfg = (opts.mcpServerConfigs ?? {})[ENGINE_MCP_SERVER];
    // ABSENT MUST MEAN DECLINE — and this is the one place the rule was never applied.
    //
    // On the seal path the prompt INSTRUCTS the chair to call output_write. If the engine server
    // config did not resolve and this is a REAL spawn, that tool will not exist in the child: the
    // chair calls it correctly and receives "No such tool available: mcp__coltrane__output_write".
    // The run then ends and the engine reports "chair X sealed no output through its write boundary"
    // — true, and useless. It names the SYMPTOM while the cause was that there was no boundary.
    //
    // MEASURED: four gigs died this way (6197b4ba, 110c0076, 8f4cda54, 496ed9f3), every one
    // dispatched from a git worktree that was never built. .mcp.json points the engine server at
    // dist/src/server_entry.js, so with no dist/ the server cannot start. The two gigs whose trees
    // WERE built sealed without trouble. Six for six — and the message blamed the agent every time.
    //
    // Same defect class the engine already refuses everywhere else: "a grant that resolves to none is
    // a dead name … so dispatch FAILS CLOSED instead of confabulating". A seal tool that cannot be
    // reached is a dead grant, and a chair that cannot possibly seal should cost nothing to discover.
    //
    // An INJECTED run captures from a stream instead of spawning, so it needs no server and no grant;
    // that path is deliberately untouched (every existing invoker law depends on it).
    if (sealViaOutputWrite && engineServerCfg === undefined && opts.run === undefined) {
      throw new Error(
        `chair "${ctx.agent.slug}" cannot seal: the in-band write boundary needs the engine MCP server ` +
          `("${ENGINE_MCP_SERVER}") wired into the spawn, and no server config resolved for it. ` +
          `The chair would be told to call ${OUTPUT_WRITE_TOOL} and find no such tool. This usually ` +
          `means the working tree has no build — .mcp.json points the engine server at its dist/ ` +
          `entrypoint. Build the tree (npm run build), or dispatch from one that is built.`,
      );
    }
    if (sealViaOutputWrite && engineServerCfg !== undefined) {
      resolvedMcpServers = { ...resolvedMcpServers, [ENGINE_MCP_SERVER]: engineServerCfg };
      effectiveAllowed = [...new Set([...(effectiveAllowed ?? []), OUTPUT_WRITE_TOOL])];
    }
    const schemaOf = (slug: string | undefined) => promptSchemaFor(opts.registry, slug);
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
    // The in-band seal directive: present only when this invoker seals via output_write AND the
    // runtime threaded a gig_id (the write needs it). Absent → the legacy text-seal Task layer.
    const seal: OutputWriteSeal | undefined = sealViaOutputWrite && ctx.gig_id
      ? {
          via: "output_write",
          gig_id: ctx.gig_id,
          agent_slug: ctx.agent.slug,
          phase: ctx.phase,
          core_by_type: Object.fromEntries(sealTypes.map((t) => [t, coreTypeOf(t)])),
        }
      : undefined;
    // contract-amend-resume-prompt-v1 — on an amend RESUME (ctx.resume, and a session to resume) the
    // spawn carries a TRIMMED prompt (buildPrompt keys on ctx.resume); the FULL prompt is built with
    // resume OFF so the cold fallback for a lost resume session can re-send it (I2). On every
    // non-resume spawn the two are identical, so nothing else changes shape.
    //
    // contract-reverify-resume-prompt-v1 (O1/I1/F1) — a re-VERIFY resume (ctx.resume_keep_prompt) is a
    // DIFFERENT trim: buildPrompt keeps the FULL prompt for a keep-prompt resume (so the stateless
    // completions door keeps everything it needs — O2), so the trim to only-what-is-new has to be
    // applied HERE, on the resuming Claude side. A MAKER amend resume (no keep_prompt) still takes
    // buildPrompt's own trim. fullPrompt stays the full round-one prompt in every case, so the cold
    // fallback for a lost resume re-sends the verifier's whole context (F1).
    const resumingWithSession = ctx.resume === true && sessionUuidFor(ctx.gig_id, ctx.role) !== undefined;
    const reverifyResume = resumingWithSession && ctx.resume_keep_prompt === true;
    const fullPrompt = buildPrompt(resumingWithSession ? { ...ctx, resume: false } : ctx, schema, outputSchemas, seal);
    const prompt = reverifyResume
      ? buildReverifyResumePrompt(sealTypes, schema, outputSchemas, seal, ctx.amended_inputs, grantsTreeReader(ctx.agent.allowed_tools))
      : resumingWithSession
        ? buildPrompt(ctx, schema, outputSchemas, seal)
        : fullPrompt;
    // #221 — the key signal for candidate selection, derived from what we just resolved.
    // Threaded into BOTH extract calls below; threading only the injected-run one would
    // leave every real chair unscored.
    const extractOpts = extractOptionsForChair(sealTypes, schema);
    // per-gig mcp-config: only the deployment-permitted servers (empty by default).
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    // the base map (opts.mcpServers) + the per-agent servers its grants resolved to (#185) + the
    // SUBSTRATE transports the room was realized on (ctx.substrateMcpConfigs). The room's servers
    // come last so a realized docker-exec transport for a venue's declared server wins over any
    // grant-resolved entry of the same slug — the spawn reaches the server running INSIDE the room,
    // not merely the policy layer. Absent substrate = the prior two-way merge exactly.
    const servers = { ...(opts.mcpServers ?? {}), ...resolvedMcpServers, ...(ctx.substrateMcpConfigs ?? {}) };
    const parent = opts.parent_session_id;
    // Per-server env additions: parent_session_id into every server (so children seal lineage), and
    // COLTRANE_OUTPUT_WRITE_MODE=validate into the ENGINE server on the output_write-seal path — so
    // the child's coltrane server ADJUDICATES the chair's in-band output_write calls against the
    // full seal predicate and returns the verdict, without persisting (the runtime is the one
    // sealer, so this is what keeps the output sealed exactly once).
    const envFor = (name: string): Record<string, unknown> => ({
      ...(parent ? { COLTRANE_PARENT_SESSION_ID: parent } : {}),
      ...(sealViaOutputWrite && name === ENGINE_MCP_SERVER ? { COLTRANE_OUTPUT_WRITE_MODE: "validate" } : {}),
    });
    const enriched = Object.fromEntries(
      Object.entries(servers).map(([name, def]) => {
        const additions = envFor(name);
        if (Object.keys(additions).length === 0) return [name, def];
        const d = (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
        const env = (d["env"] && typeof d["env"] === "object" ? d["env"] : {}) as Record<string, unknown>;
        return [name, { ...d, env: { ...env, ...additions } }];
      }),
    );
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: enriched }));
    try {
      const a = ctx.agent;
      // #turn-budget — the reserve the invoker will grant on a budget stop, chair-scoped first.
      const reserveTurns = resolveReserveTurns(ctx.turn_reserve);
      // #237 — a shallow run depth tightens the turn cap; it never widens the agent's own.
      const depthCap = ctx.depth ? DEPTH_MAX_TOOL_CALLS[ctx.depth] : undefined;
      // #turn-budget — resolve chair > agent > engine default, THEN let a shallow depth cap tighten
      // (never widen). `ctx.turn_budget === 0` is a deliberate hard floor and does NOT fall through
      // (0 is not nullish); absent falls to the agent's own cap, then the CLI default (undefined →
      // no --max-turns emitted at all).
      const resolvedBudget = ctx.turn_budget ?? a.max_tool_calls;
      const maxToolCalls = depthCap === undefined
        ? resolvedBudget
        : Math.min(depthCap, resolvedBudget ?? depthCap);
      // Run ONE invocation and return the child's raw stdout. Custom run (tests): the returned
      // string IS the transcript (a bare JSON blob on the text path, a stream-json transcript on
      // the output_write path). Default: stream-json so the child's tool calls / reasoning are
      // observable LIVE, teed to ctx.onEvent.
      // THE TOOL CEILING BINDS BY ENFORCEMENT, not omission. `--allowedTools` does NOT remove a host
      // builtin — a seat granted only `type_browse` still called Bash and Read, unrefused and
      // unrecorded (gig 782e89d8, room-prober, twice) — so the deny list must ENUMERATE what the seat
      // may not hold. Synthesize it from the EXISTING oracles (hostBuiltinDenials over HOST_BUILTINS;
      // venueEffectiveTools for the room ceiling), never a re-inlined universe/intersection.
      //
      // Computed HERE, AFTER OUTPUT_WRITE_TOOL joined effectiveAllowed (see the seal-wire block above):
      // synthesizing before that addition would deny every model chair the very tool it must call to
      // seal, failing every gig at the last step (asserted by LAW 2).
      //
      // The complement is scored against effectiveAllowed PLUS the code tools code_tool_access keeps:
      // those four are governed by the code_tool_access ladder (codeToolDenials), so the complement
      // must not re-deny a code tool the agent's access grants.
      const allowForComplement = [...(effectiveAllowed ?? []), ...codeToolsKept(a.code_tool_access)];
      // (d) VENUE CEILING BY DENIAL: a tool the agent grants but the room's equipment excludes.
      // venueEffectiveTools is the SAME shared oracle compose-time R10 refuses against (INV9) — never a
      // re-inlined intersection — so the room narrows by enforcement, not only by the omission from
      // --allowedTools that cannot bind. Absent a room, nothing is venue-excluded.
      const venueExcluded = ctx.realization && ctx.venue
        ? (() => {
            const kept = new Set(venueEffectiveTools(a, ctx.venue!));
            return (a.allowed_tools ?? []).filter((g) => !kept.has(g));
          })()
        : [];
      // The UNION, preserving the agent's OWN declared denials (never replaced): (a) declared
      // disallowed_tools, (b) the code_tool_access ladder, (c) the host-builtin complement, (d) the
      // venue-excluded grants.
      const denyUnion = [
        ...(a.disallowed_tools ?? []),
        ...codeToolDenials(a.code_tool_access),
        ...hostBuiltinDenials(allowForComplement),
        ...venueExcluded,
        // (e) NO SELF-WIDENING: the layout file, denied beside any Write/Edit that covers it. Scoped,
        // so the NO OVER-DENIAL filter below keeps it (the resolver never returns the exact grant).
        ...seatGrants.denials,
      ];
      // NO OVER-DENIAL (LAW 5, and LAW 2's structural half): nothing the seat legitimately holds may be
      // denied — most sharply OUTPUT_WRITE_TOOL, which effectiveAllowed now carries on the seal path.
      // Subtract the effective allow set, then dedupe. The base-name half is right ONLY for a BARE deny
      // (`Write`): emitting it would kill a scoped `Write(src/**)` grant of the same tool too, so a
      // grant of that base — scoped or not — protects it. Applied to a SCOPED deny it is wrong:
      // `Write(tests/**)` and `Write(src/**)` share the base `Write`, yet name different surfaces, so a
      // scoped deny is removed ONLY by an EXACT-string grant. Without that split a seat could never be
      // granted `src/**` while denied `tests/**` — the one shape a builder that must not weaken its own
      // laws needs. code_tool_access-kept tools are NOT subtracted here: a venue that excludes a code
      // tool must still deny it even under access "full".
      const allowExact = new Set(effectiveAllowed ?? []);
      const allowBase = new Set((effectiveAllowed ?? []).map(toolBaseName));
      const disallowedTools = [...new Set(denyUnion)].filter((t) => {
        if (allowExact.has(t)) return false; // an exact grant of the very string always protects it
        const isBare = t === toolBaseName(t); // no scope parens → a bare tool name
        return !(isBare && allowBase.has(toolBaseName(t)));
      });
      // contract-chair-session-continuity-v1 — the chair's own session, deterministic in (gig_id,
      // role). A first invocation OPENS it (--session-id); an amend re-invocation (ctx.resume, set
      // by the runtime) RESUMES it (--resume). Absent gig_id ⇒ no session ⇒ neither flag.
      const sessionId = sessionUuidFor(ctx.gig_id, ctx.role);
      const resumeRound = ctx.resume === true && sessionId !== undefined;
      // contract-seat-primer-v1 (O2/I1) — a FORK chair (ctx.fork threaded, and this seat has a session)
      // WARM-STARTS its first spawn from the primer's session. A plain chair carries no ctx.fork, so
      // isFork is false and the spawn is byte-identical to today (no --fork-session — the I1 control).
      const forkFromSession = ctx.fork?.primer_session_id;
      const isFork = forkFromSession !== undefined && sessionId !== undefined;
      // contract-primer-reading-frontier-v1 (O2) — the primer's reading frontier, if it recorded one:
      // the fork's first spawn CUTS the resumed conversation there. Absent ⇒ the whole session resumes.
      const forkFrontier = ctx.fork?.frontier;
      // #seat-effort (O3) — the runtime already resolved precedence onto ctx.effort; floor to medium
      // so an undeclared, untiered seat (or any hand-built ctx) still spawns with an explicit
      // --effort rather than the operator's settings-file effort. Hoisted so baseArgs and the cold
      // arg list below share ONE opts object rather than two parallel derivations.
      // THE BASH SANDBOX. Any seat that can run Bash — granted, or kept by code_tool_access — and is
      // not denied it spawns sandboxed over the tree it runs in: the room's workspace when it sits in
      // a room (the `docker exec -w` directory), else the run's tree_root, else the directory the spawn
      // inherits (process.cwd()). On the host the path is made absolute and real (a symlinked tmpdir
      // would otherwise name a path the OS sandbox never sees).
      const seatHoldsBash =
        allowForComplement.some((g) => toolBaseName(g) === "Bash") && !disallowedTools.includes("Bash");
      const sandbox = seatHoldsBash
        ? bashSandboxFor(ctx.seatExec ? ctx.seatExec.workspace : realOrResolved(ctx.tree_root ?? process.cwd()))
        : undefined;
      const invokerOpts = {
        sandbox,
        model: resolveModel(a.model_tier, opts.model),
        allowed_tools: effectiveAllowed,
        disallowed_tools: disallowedTools,
        max_tool_calls: maxToolCalls,
        effort: ctx.effort ?? "medium",
      };
      const baseArgs = buildInvokerArgs(prompt, cfgPath, {
        ...invokerOpts,
        ...(sessionId !== undefined ? { session_id: sessionId, resume: resumeRound } : {}),
        // contract-seat-primer-v1 (O2) — the fork warm-start rides on the FIRST spawn (baseArgs); the
        // cold arg list below carries no fork_from_session, so an unresumable primer (F2) falls back to
        // a plain fresh-session spawn with no --fork-session.
        ...(isFork ? { fork_from_session: forkFromSession } : {}),
        // contract-primer-reading-frontier-v1 (O2) — cut the fork at the primer's frontier when it has one.
        ...(isFork && forkFrontier !== undefined ? { resume_session_at: forkFrontier } : {}),
      });
      // contract-amend-resume-prompt-v1 (I2) — the cold arg list for a resume whose session is gone:
      // a FRESH --session-id spawn (resume:false) carrying the FULL prompt, because nothing else
      // carries the chair's context once the resume fell through. Identical to baseArgs on every
      // non-resume spawn (same session flag, same full prompt), so it changes shape only on an amend.
      const coldArgs = sessionId !== undefined
        ? buildInvokerArgs(fullPrompt, cfgPath, { ...invokerOpts, session_id: sessionId, resume: false })
        : baseArgs;
      // SEAT IN THE ROOM. When the substrate stood up a SEAT-BEARING room, ctx.seatExec names its
      // container and per-realization workspace, and the chair runs INSIDE it:
      // `docker exec -i -w <workspace> <container> claude …` — so the seat's cwd is the room's own
      // tree and two concurrent gigs (distinct rooms, distinct workspaces) cannot share a working
      // directory. This wraps ONLY the leaf spawn; it runs AFTER the confinement block above, so
      // effectiveAllowed/childEnv are already computed and the room narrows the seat but never widens
      // it. `-i` keeps stdin open so a stdin-delivered prompt flows into the in-room binary. Auth is
      // FILE-BASED inside the room (credential_surface delivered by `docker cp` to /run/secrets),
      // never a host keychain and never forwarded via `-e`, so no host credential enters the room.
      // Absent → identity, and the leaf spawns on the host exactly as before.
      const seatExec = ctx.seatExec;
      const execBin = seatExec ? "docker" : bin;
      const inRoom = (args: readonly string[]): string[] =>
        seatExec ? ["exec", "-i", "-w", seatExec.workspace, seatExec.container, bin, ...args] : [...args];
      // ONE invocation only — on the output_write path the agent self-corrects a rejected write
      // WITHIN this single run (each output_write rejection returns in-band and it calls again),
      // and on the text path there is a single answer. Either way, the invoker never re-prompts.
      // A chair stopped by its TOOL BUDGET is not a chair that failed. `--max-turns` cuts the run
      // off mid-flight, and everything it had already written through the in-band boundary was
      // adjudicated against the full seal predicate at the moment of writing — those are validated
      // payloads, not the partial reasoning the error subtypes exist to catch. Discarding them
      // destroyed real work and billed for it: one observed sweep landed nine sealed lineage-hits,
      // satisfied its output_contract, and was reported as a failure with nothing kept.
      //
      // So the budget stop is caught HERE, and only here: the stream is recovered, and the decision
      // about whether anything survives is left to the seal path below, which is the only place that
      // knows what passed. Every other non-zero exit still propagates untouched.
      const runOnce = async (args: readonly string[], text: string): Promise<string> =>
        customRun
          ? await customRun(execBin, inRoom(args), spawnBounds, childEnv)
          : await spawnStreaming(
              execBin, inRoom([...args, "--output-format", "stream-json", "--verbose"]), spawnBounds,
              ctx.onEvent, ctx.signal, abortGraceMs, promptViaStdin(text) ? text : undefined,
              childEnv,
            );

      /** Run, and hand back the stream even when the child died on its turn cap. */
      const runTolerantOfBudgetStop = async (
        args: readonly string[],
        text: string,
      ): Promise<{ stdout: string; budgetStopped: boolean }> => {
        try {
          const stdout = await runOnce(args, text);
          // A BUDGET STOP IS A FACT ABOUT THE RESULT, NOT ABOUT THE EXIT CODE. The CLI reports
          // `{"subtype":"error_max_turns"}` in its result event whether it exits 0 or 1, and only the
          // non-zero form used to be read — so a chair that hit its cap and exited cleanly was a
          // budget stop the engine could not see, and its reserve never fired.
          //
          // Measured on gig 8f4cda54: read-context declared turn_reserve 12, ran 106 tool calls
          // against a cap of 120, reported error_max_turns, and recorded budget_reserve_granted 0.
          // It was never extended and failed with "sealed no output through its write boundary".
          // The reserve added in #478 could not fire because it was gated on the wrong signal.
          const stoppedCleanly =
            seal !== undefined && finalText(stdout).errorSubtype === BUDGET_STOP_SUBTYPE;
          return { stdout, budgetStopped: stoppedCleanly };
        } catch (e) {
          const recoverable =
            seal !== undefined &&
            e instanceof ChildExitError &&
            finalText(e.stdout).errorSubtype === BUDGET_STOP_SUBTYPE;
          if (recoverable) return { stdout: (e as ChildExitError).stdout, budgetStopped: true };
          // A non-recoverable non-zero exit still carries the child's stream, and on the provider-
          // usage-limit path that stream — NOT stderr — holds the only account of why the run stopped:
          // the CLI emits the notice as a synthetic assistant message and/or an is_error result and
          // writes nothing to stderr. The default runner builds its failure from stderr alone, so the
          // operator was handed `claude exited 1:` with a blank reason for a failure that had a precise
          // one. Fold the stream's notice into the failure so the reason — and when the limit resets —
          // survives; keep it a ChildExitError so the stdout it carries is preserved. When the stream
          // says nothing, the original error (which carries stderr) is rethrown unchanged, so an
          // ordinary non-zero exit still reports stderr (the control).
          if (e instanceof ChildExitError) {
            const notice = providerNoticeFrom(e.stdout);
            if (notice) {
              const sep = e.message === "" || e.message.endsWith(" ") ? "" : " ";
              throw new ChildExitError(`${e.message}${sep}${notice}`, e.stdout);
            }
          }
          throw e;
        }
      };

      // F1 — the cold fallback for a resume whose session is gone: a FRESH spawn with --session-id
      // and the FULL prompt (coldArgs/fullPrompt), recorded loudly so the fallback is never silent.
      // Shared by the main amend resume below AND the reserve continuation so the fallback is one
      // shape; on the reserve path coldArgs === baseArgs and fullPrompt === prompt, so it is unchanged
      // there. Defined before the first run so the main amend path can reach it.
      const resumeColdFallback = async (): Promise<{ stdout: string; budgetStopped: boolean }> => {
        ctx.onEvent?.({
          type: "resume_fallback",
          raw: {
            agent: a.slug,
            session_id: sessionId,
            resumed: false,
            reason: "the session named for --resume could not be found; re-running cold with " +
              "--session-id and the full prompt",
          },
        } as AgentStreamEvent);
        return runTolerantOfBudgetStop(coldArgs, fullPrompt);
      };

      // contract-seat-primer-v1 (F2) — a FORK whose primer session cannot be resumed (the run seam
      // reports "no conversation" for its id) falls back COLD: a FRESH --session-id spawn with the full
      // prompt (coldArgs carries no fork_from_session, so no --fork-session), NEVER failing the chair.
      // The `fork_fallback` event names the unresumable primer session so chair_complete records the
      // reason — a resume that did not happen, not a fork the record falsely claims.
      // contract-primer-reading-frontier-v1 (F2) — an `reason` overrides the default when the fallback is
      // due to an unresolvable reading FRONTIER (not an unresumable session), so chair_complete names the
      // frontier the fork could not cut at rather than a session that never failed.
      const forkColdFallback = async (reason?: string): Promise<{ stdout: string; budgetStopped: boolean }> => {
        ctx.onEvent?.({
          type: "fork_fallback",
          raw: {
            agent: a.slug,
            primer_session_id: forkFromSession,
            forked: false,
            reason: reason ??
              `the primer session ${forkFromSession} could not be resumed; re-running cold with ` +
              `--session-id and the full prompt`,
          },
        } as AgentStreamEvent);
        return runTolerantOfBudgetStop(coldArgs, fullPrompt);
      };
      // contract-primer-reading-frontier-v1 (F2) — the reason for an unresolvable-frontier cold fallback,
      // naming the frontier so chair_complete.fork_fallback records exactly what could not be resolved.
      const frontierFallbackReason = (): string =>
        `the primer's reading frontier ${forkFrontier} could not be resolved in its session; re-running ` +
        `cold with --session-id and the full prompt`;

      // contract-resumed-gig-session-v1 (O2/O3/F1) — a FIRST `--session-id` open can COLLIDE: the
      // chair's session id is deterministic in (gig_id, role), so a KILLED attempt that already opened
      // it leaves the id live, and a resumed gig's first spawn re-opens it — the CLI refuses it
      // ("already in use"). That is a RESUME, never a failure: re-spawn ONCE with `--resume` and a
      // SHORT prompt (the previous attempt was interrupted, the current tree is authoritative), and
      // emit a resume-on-collision event so chair_complete records the chair CONTINUED its session.
      // If the resume then finds no conversation, the same cold fallback (F1) runs. Only a non-resume
      // spawn with a session id can collide (a resume carries `--resume`, never `--session-id`).
      const collisionResume = async (): Promise<{ stdout: string; budgetStopped: boolean }> => {
        ctx.onEvent?.({
          type: "resume_on_collision",
          raw: {
            agent: a.slug,
            session_id: sessionId,
            resumed: true,
            reason: "the session named for --session-id was already in use — a killed prior attempt " +
              "created it; re-spawning with --resume to continue that conversation",
          },
        } as AgentStreamEvent);
        const retryPrompt =
          `This chair's previous attempt was interrupted. The conversation you are resuming already ` +
          `holds your disposition, identity, method, tools and the gig input, so this prompt carries ` +
          `only what is new: the current working tree is authoritative — re-derive your output from ` +
          `it and re-seal exactly as before.`;
        const retryArgs = buildInvokerArgs(retryPrompt, cfgPath, { ...invokerOpts, session_id: sessionId!, resume: true });
        try {
          const retry = await runTolerantOfBudgetStop(retryArgs, retryPrompt);
          return resumeSessionLost(retry.stdout) ? await resumeColdFallback() : retry;
        } catch (e) {
          if (e instanceof ChildExitError && resumeSessionLost(e.stdout)) return await resumeColdFallback();
          throw e;
        }
      };

      // contract-amend-resume-prompt-v1 (I2/F1) — run the chair once. On an amend RESUME whose session
      // the seam reports gone (whether the run resolved with the error result or threw a non-zero exit
      // carrying it), fall back COLD rather than failing the chair. On a FIRST open whose --session-id
      // COLLIDES (contract-resumed-gig-session-v1 O2), resume it instead of failing. Every other spawn
      // kind is untouched.
      const collided = (s: string, m: string): boolean =>
        !resumeRound && sessionId !== undefined && sessionIdInUse(s, m);
      let stdout: string;
      let budgetStopped: boolean;
      try {
        const first = await runTolerantOfBudgetStop(baseArgs, prompt);
        if (resumeRound && resumeSessionLost(first.stdout)) {
          ({ stdout, budgetStopped } = await resumeColdFallback());
        } else if (isFork && forkFrontier !== undefined && frontierNotFound(first.stdout, "")) {
          // contract-primer-reading-frontier-v1 (F2) — the fork's --resume-session-at named a uuid the
          // primer session does not hold; re-run cold, naming the frontier.
          ({ stdout, budgetStopped } = await forkColdFallback(frontierFallbackReason()));
        } else if (isFork && resumeSessionLost(first.stdout)) {
          // contract-seat-primer-v1 (F2) — the fork's --resume of the primer found no conversation.
          ({ stdout, budgetStopped } = await forkColdFallback());
        } else if (collided(first.stdout, "")) {
          ({ stdout, budgetStopped } = await collisionResume());
        } else {
          ({ stdout, budgetStopped } = first);
        }
      } catch (e) {
        if (resumeRound && e instanceof ChildExitError && resumeSessionLost(e.stdout)) {
          ({ stdout, budgetStopped } = await resumeColdFallback());
        } else if (isFork && forkFrontier !== undefined && e instanceof ChildExitError && frontierNotFound(e.stdout, e.message)) {
          // contract-primer-reading-frontier-v1 (F2) — the fork exited 1 because --resume-session-at named
          // a uuid the primer session does not hold (notice on stderr and in the result event's `errors`).
          ({ stdout, budgetStopped } = await forkColdFallback(frontierFallbackReason()));
        } else if (isFork && e instanceof ChildExitError && resumeSessionLost(e.stdout)) {
          ({ stdout, budgetStopped } = await forkColdFallback());
        } else if (e instanceof ChildExitError && collided(e.stdout, e.message)) {
          ({ stdout, budgetStopped } = await collisionResume());
        } else {
          throw e;
        }
      }
      // Every stream whose writes count toward the seal. Diverges from `stdout` only when a reserve
      // was granted, which is the one case where a chair's output spans more than one invocation.
      let sealStdout = stdout;

      // WHAT THE SEAT READ (spec.coltrane-sealed-inputs law 9), reported as the same `seat_read` event
      // the completions door emits — so the runtime's ONE verification path (re-hash, dedup, stamp)
      // serves both doors. Here, where every seal path sees the stream: a text-seal chair reads too.
      const seatReads = captureSeatReads(stdout);
      if (seatReads.length > 0) ctx.onEvent?.({ type: "seat_read", raw: { refs: seatReads } } as AgentStreamEvent);

      if (budgetStopped && reserveTurns > 0 && seal !== undefined) {
        const sealedSoFar = captureOutputWrites(stdout, sealTypes);
        const already = Object.keys(sealedSoFar);
        ctx.onEvent?.({
          type: "budget_reserve_granted",
          raw: { agent: a.slug, reserve_turns: reserveTurns, sealed_before_grant: already },
        } as AgentStreamEvent);
        // contract-chair-session-continuity-v1 (O2) — the continuation RESUMES the chair's own
        // session and carries ONLY the reserve text. The original prompt is NOT re-sent: the resumed
        // conversation already holds it, so re-sending it would pay the whole cold read the resume
        // exists to avoid. When there is a session to resume (there always is on the seal path, which
        // requires a gig_id), swap --session-id for --resume; otherwise the old fresh-spawn shape
        // stands and the prompt is re-sent as before.
        const continuation =
          `You reached your turn budget and were stopped mid-run. You are now in RESERVE: ` +
          `${reserveTurns} turns remain and this is the LAST extension — it will not be extended ` +
          `again, so land the work rather than reaching for more.\n\n` +
          (already.length > 0
            ? `Already sealed through the write boundary, do NOT redo: [${already.join(", ")}].\n\n`
            : `Nothing sealed yet.\n\n`) +
          `Close out now: seal what you already have, and state plainly what you did NOT reach so ` +
          `the record shows the boundary instead of implying coverage.` +
          (sessionId !== undefined ? `` : `\n\n${prompt}`);
        const reserveArgs = sessionId !== undefined
          ? withPrompt(withMaxTurns(withResume(baseArgs, sessionId), reserveTurns), continuation)
          : withPrompt(withMaxTurns(baseArgs, reserveTurns), continuation);
        // F1 — a resume whose session cannot be found must fall back COLD (a fresh spawn with
        // --session-id and the FULL original prompt) and never fail the chair. Detect the lost
        // session from the reserve run's stream, whether it resolved with the error result or threw
        // a non-zero exit carrying it, and re-run cold; loudly, so the fallback is recorded.
        let second: { stdout: string; budgetStopped: boolean };
        try {
          second = await runTolerantOfBudgetStop(reserveArgs, continuation);
          if (sessionId !== undefined && resumeSessionLost(second.stdout)) {
            second = await resumeColdFallback();
          }
        } catch (e) {
          if (sessionId !== undefined && e instanceof ChildExitError && resumeSessionLost(e.stdout)) {
            second = await resumeColdFallback();
          } else {
            throw e;
          }
        }
        // Two streams, two different questions, and conflating them is a bug: the OUTCOME (did the
        // run complete?) is the last pass's to answer, while the WRITES are cumulative — the first
        // pass's payloads passed the boundary too, and a continuation that sealed nothing must not
        // erase them. Concatenating for both would let the first pass's error_max_turns result event
        // outrank the second's success and fail a run that finished.
        sealStdout = `${stdout}\n${second.stdout}`;
        stdout = second.stdout;
        budgetStopped = second.budgetStopped;
      } else if (budgetStopped && reserveTurns === 0 && seal !== undefined) {
        // #turn-budget — the chair hit its budget and the pool had nothing left to extend it (an
        // empty reserve). Keep-sealed-writes below is unchanged, but the starvation is now VISIBLE:
        // emit a denial so a parent watching the stream — and the runtime's draw ledger — can
        // attribute it, rather than a silent no-op that reads like a chair that simply finished.
        ctx.onEvent?.({
          type: "budget_reserve_denied",
          raw: { agent: a.slug, requested: ctx.turn_reserve ?? opts.turn_reserve ?? 0, pool_remaining: 0 },
        } as AgentStreamEvent);
      }
      const outcome = finalText(stdout);
      // #223 — the child reported an error result. `subtype` catches a run that did not complete;
      // `is_error` catches an API-error payload riding subtype "success". The CLI exits 0 for both,
      // so without this the partial reasoning seals as if it had succeeded. Applies to both paths.
      // A recovered budget stop reaches here with its subtype still set; that is expected and is
      // not an error for the seal path. The text path gets no such reprieve — its payload IS the
      // final answer text, and a truncated run's text is exactly the partial reasoning this guards.
      if (outcome.errorSubtype !== undefined && !budgetStopped) {
        throw new Error(
          `claude ended with result subtype "${outcome.errorSubtype}" — the run did not ` +
            `complete, so any text it emitted is partial reasoning, not an answer`,
        );
      }
      if (outcome.apiErrorText !== undefined) {
        throw new Error(
          `claude flagged its result with is_error — the payload is an error message, not an ` +
            `answer: ${outcome.apiErrorText.slice(0, 300)}`,
        );
      }

      // contract-seat-primer-v1 (O1/I2) — a PRIME seat's Read events, parsed from the run's stdout and
      // emitted so the runtime seals the seat-primer from EXACTLY the files this seat read. Emitted on
      // both seal and text paths (an injected `run` bypasses streaming, so the returned stdout is the
      // one place the reads are), and before the seal branches so the reads reach the runtime whatever
      // the seat produced.
      if (ctx.prime) {
        // contract-primer-reading-frontier-v1 (O1/O3/O4/I2/I3/F1) — parse the reading frontier over the
        // concatenated seal stdout: the reads are cut to those before the first write, the context is the
        // first-write context (or the last usage when there is no frontier), and the frontier uuid is
        // forwarded on the seat_reads event so the runtime seals it onto the primer. A no-write/no-user
        // seat yields no frontier and the reads/context are exactly as the rolling-primer laws expect.
        const rf = captureReadingFrontier(sealStdout);
        ctx.onEvent?.({
          type: "seat_reads",
          raw: {
            agent: a.slug, area: ctx.prime.area, reads: rf.reads,
            ...(rf.frontier !== undefined ? { frontier: rf.frontier } : {}),
          },
        } as AgentStreamEvent);
        // contract-rolling-seat-primer-v1 (O3) — forward the seat's context size at seal the SAME way, so
        // the runtime records it on the seat-primer even though the injected `run` seam bypassed the
        // streamed usages. Emitted only when the run reported a usage; otherwise the runtime falls back.
        if (rf.context_tokens !== undefined) {
          ctx.onEvent?.({ type: "seat_context", raw: { context_tokens: rf.context_tokens } } as AgentStreamEvent);
        }
      }

      if (seal) {
        // THE IN-BAND WRITE BOUNDARY. The chair sealed each output by calling output_write, whose
        // payload the engine adjudicated against the FULL seal predicate (checkWritable, run in
        // validate-mode) and whose rejection it corrected in-band. Capture the payloads that
        // PASSED; the runtime (executeChair) then seals them through its own boundary exactly once.
        // A chair that got nothing past the boundary produced nothing — fail here, legibly.
        let blob = captureOutputWrites(sealStdout, sealTypes);

        // ── THE CHANNEL REPAIR ────────────────────────────────────────────────────────────────
        // The chair finished cleanly and got NOTHING past the boundary — it produced its answer as
        // final text, or a file, or a summary, and never made the call that seals. Give it one
        // corrective continuation rather than failing the phase.
        //
        // The engine's in-band loop is already good, and that is exactly what makes this gap sharp:
        // output_write "runs the full seal predicate and returns its verdict in-band, so the agent
        // self-corrects" (:124) — but only for a chair that CALLED it. Getting the payload wrong is
        // recoverable; getting the CHANNEL wrong was fatal. That is backwards. A wrong channel is the
        // cheaper mistake to fix, because the work is already done and still sitting in the agent's
        // context — one turn is enough to make the call it should have made.
        //
        // Same mechanism as the reserve grant above, for a different cause: continue once, say where
        // it stands, and say plainly that nothing follows. Bounded to ONE — a chair that ignores a
        // direct instruction to seal will not be argued into it, and the argument bills real tokens.
        //
        // NOT for a budget stop: that chair used the right channel and ran out of room, and the
        // reserve grant is its remedy. Repairing it here would continue it twice for one stop.
        //
        // AND NOT for a chair that knocked and was refused. `attemptedWriteBoundary` is the whole
        // line: a chair whose output_write was REJECTED already got its correction in-band and gave
        // up, and re-prompting it is precisely the bounded repair loop the governor rejected twice
        // (tests/output_write_boundary.test.ts, "never the old bounded repair loop"). That principle
        // is untouched here. This repairs only the chair that never knocked at all — the one the
        // in-band loop cannot see, because it never entered it.
        if (Object.keys(blob).length === 0 && !budgetStopped && !attemptedWriteBoundary(sealStdout)) {
          const calls = sealTypes
            .map(
              (t) =>
                `  output_write({ "core_type": "${seal.core_by_type[t] ?? ""}", "domain_type": "${t}", ` +
                `"gig_id": "${seal.gig_id}", "phase": "${seal.phase}", "agent_slug": "${seal.agent_slug}", ` +
                `"data": <your result> })`,
            )
            .join("\n");
          ctx.onEvent?.({
            type: "seal_boundary_repair",
            raw: {
              agent: a.slug,
              unsealed: [...sealTypes],
              note:
                "the chair completed without calling output_write; it is being continued ONCE to " +
                "seal through the write boundary",
            },
          } as AgentStreamEvent);
          const correction =
            `STOP — your run finished but sealed NOTHING. Not one output_write call passed the ` +
            `write boundary for [${sealTypes.join(", ")}].\n\n` +
            `Whatever you produced — final text, a file, a summary — is NOT sealed. It will be ` +
            `discarded and this phase will fail.\n\n` +
            `The work you already did still counts. Do NOT redo it. Seal it now, by calling ` +
            `output_write — the only channel that seals:\n${calls}\n\n` +
            `This is the LAST attempt; it will not be offered again.\n\n${prompt}`;
          // contract-fork-continuation-is-exact-v1 (O1) — the repair CONTINUES the chair's own
          // session, exactly as the reserve continuation does: resume `<own>`, and carry none of the
          // warm start (`--session-id`, `--fork-session`, `--resume-session-at`, the primer `--resume`)
          // that `baseArgs` holds for a fork chair. Only a gig-less spawn (no session) reuses baseArgs.
          const repairArgs = sessionId !== undefined
            ? withPrompt(withMaxTurns(withResume(baseArgs, sessionId), SEAL_REPAIR_TURNS), correction)
            : withPrompt(withMaxTurns(baseArgs, SEAL_REPAIR_TURNS), correction);
          const repaired = await runTolerantOfBudgetStop(repairArgs, correction);
          // Cumulative, exactly as the reserve path is: a write that passed in either pass counts.
          sealStdout = `${sealStdout}\n${repaired.stdout}`;
          blob = captureOutputWrites(sealStdout, sealTypes);
        }

        // WHAT THE SEAT WAS REFUSED. The child reports every denial; until now nothing read them, so a
        // chair blocked out of doing its job was indistinguishable from one that had nothing to say.
        // Emitted whenever any occurred — a denial is a fact about the run even when the chair
        // recovered and sealed anyway.
        const denials = captureSeatDenials(sealStdout);
        if (denials.length > 0) {
          ctx.onEvent?.({
            type: "seat_denied",
            raw: {
              agent: a.slug,
              count: denials.length,
              denials,
              note:
                "the seat was refused these tool calls; a denial can mean the grant forbids it OR that " +
                "the command was phrased in a form the grant does not match",
            },
          } as AgentStreamEvent);
        }
        
        if (Object.keys(blob).length === 0) {
          // A chair that produced nothing because it was REFUSED is a different failure from one that
          // simply produced nothing, and only the second is the agent's fault. Naming the denials is
          // the difference between "the agent did not deliver" and "the seat could not run the
          // commands its own plan required" — which is what happened on gig 486e0e6c, where the
          // message pointed at the agent and the cause was a grant whose prefix did not match
          // `git -C <path> add`.
          const blocked =
            denials.length > 0
              ? ` The seat was DENIED ${denials.length} tool call(s) during this run — ` +
                `${denials
                  .map((d) => {
                    // The KIND is the actionable half. form-mismatch: the seat HELD the authority and
                    // mis-phrased it, so rephrase. not-granted: the approach needs changing. undetermined
                    // says so rather than guessing — telling an agent to rephrase something it is
                    // genuinely forbidden loops it, which is worse than staying silent.
                    const dx = diagnoseDenial(d, a.allowed_tools ?? []);
                    return `${d.tool}: ${d.reason} [${dx.kind} — ${dx.detail}]`;
                  })
                  .join(" | ")}.`
              : "";
          throw new ModelOutputContractError(
            a.slug,
            (budgetStopped
              ? `ran out of tool budget (max_tool_calls) before any output_write passed the write ` +
                `boundary for [${sealTypes.join(", ")}] — nothing was salvageable`
              : `no output_write call passed the write boundary for [${sealTypes.join(", ")}]`) + blocked,
          );
        }
        // The stop is REPORTED, never swallowed. What survived is real and sealed; what the agent
        // would have gone on to find is unknown, and a caller reading this chair's output as a
        // complete sweep would be reading a truncation as a finding.
        if (budgetStopped) {
          ctx.onEvent?.({
            type: "budget_stop",
            raw: {
              agent: a.slug,
              max_tool_calls: a.max_tool_calls,
              sealed_types: Object.keys(blob),
              note:
                "the chair exhausted its tool budget; the outputs it had already passed through " +
                "the write boundary were kept, and the sweep is TRUNCATED, not complete",
            },
          } as AgentStreamEvent);
        }
        return blob;
      }

      // TEXT-SEAL PATH (default; every injected-run test). No in-band tool surface, so the payload
      // is the child's final answer text; the runtime's own seal is this path's write boundary and
      // its full checkWritable adjudicates the extracted payload.
      // #222 — the stream parsed but carried no answer at all. Report THAT, with the raw stdout as
      // evidence, rather than blaming the model for emitting no JSON.
      if (outcome.text.trim() === "") {
        throw new ModelOutputParseError(
          "the model produced no answer — the stream carried no result text and no assistant text",
          0,
          stdout,
        );
      }
      return extractJson(outcome.text, extractOpts);
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
  // contract-seat-ask-v1 — the hands-off ask, attached to the SAME closure so it reuses the injected
  // `run` seam, spawn bounds and child-env floor. Distinct from the chair path above by construction:
  // no grant resolution, no identity/method/input prompt (the QUESTION is the only thing sent), an
  // empty allow list plus the host-builtin deny floor (so the asked seat cannot write, seal or act),
  // and no output/ledger write of its own. A lost resume is REPORTED, never followed by a fresh seat.
  const asker = invoke as unknown as ClaudeInvoker;
  asker.askSeat = async ({ gig_id, role, question, max_turns }) => {
    const session_id = sessionUuidFor(gig_id, role);
    // No (gig_id, role) session to key on ⇒ nothing to resume: the same "no conversation" answer,
    // and NO spawn — never a fresh seat that would invent the reasoning (F1).
    if (session_id === undefined) return { session_lost: true, session_id };
    const cfgPath = join(tmpdir(), `coltrane-mcp-${randomUUID()}.json`);
    writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
    // The cage: an EMPTY allow list (buildInvokerArgs emits no --allowedTools, MCP or builtin), every
    // host builtin denied by construction (hostBuiltinDenials over the empty set), the turn cap
    // defaulting to 2 and always present, and --resume naming the seat's own uuid — never --session-id
    // (a resume CONTINUES; an open would FORK a fresh conversation and the attribution would be a lie).
    const askArgs = buildInvokerArgs(question, cfgPath, {
      allowed_tools: [],
      disallowed_tools: hostBuiltinDenials([]),
      max_tool_calls: max_turns ?? 2,
      effort: "medium",
      session_id,
      resume: true,
    });
    const childEnv = withoutBoxCredentials(process.env);
    try {
      let stdout: string;
      try {
        stdout = customRun
          ? await customRun(bin, askArgs, spawnBounds, childEnv)
          : await spawnStreaming(
              bin, [...askArgs, "--output-format", "stream-json", "--verbose"], spawnBounds,
              undefined, undefined, abortGraceMs, promptViaStdin(question) ? question : undefined, childEnv,
            );
      } catch (e) {
        // A lost resume can arrive as a non-zero exit carrying the CLI's notice in its stdout; caught
        // here (as the amend path does) so it becomes the typed session_lost signal, never a throw.
        if (e instanceof ChildExitError && resumeSessionLost(e.stdout)) return { session_lost: true, session_id };
        throw e;
      }
      // The seat's conversation is gone → REPORT it (F1); the handler turns this into a typed refusal.
      if (resumeSessionLost(stdout)) return { session_lost: true, session_id };
      // The answer is the seat's prose, returned verbatim — never re-parsed as JSON. An empty answer
      // is returned AS empty (F2), the emptiness being the seat's, not the engine's.
      return { answer: finalText(stdout).text, session_id, resumed: true };
    } finally {
      try { unlinkSync(cfgPath); } catch { /* best-effort cleanup */ }
    }
  };
  return asker;
}

// Spawn a child and stream its stdout line-by-line. Each complete line is parsed as a
// stream-json event and forwarded (granularly) to onEvent as it arrives — this is the
// agent-layer observability seam. Returns the full stdout on clean exit; rejects on
// non-zero exit (with stderr), timeout (SIGKILL, so a signal-trapping child can't survive),
// or cancellation via `signal` (SIGTERM → grace → SIGKILL).
//
// The child is REGISTERED in LIVE_CHAIR_CHILDREN for its whole lifetime (#250/#252): a handle
// nothing holds is a process nothing can stop.
function spawnStreaming(
  bin: string,
  args: readonly string[],
  bounds: SpawnBounds,
  onEvent?: (ev: AgentStreamEvent) => void,
  signal?: AbortSignal | undefined,
  abortGraceMs: number = DEFAULT_ABORT_GRACE_MS,
  /** The prompt, when it is too large for the command line. Written to the child's stdin. */
  stdinPayload?: string | undefined,
  /** The venue → dispatch wire's deny-by-default child env. When present it REPLACES the inherited
   *  process.env (no ambient credential leaks into a confined child); absent = inherit, unchanged. */
  childEnv?: Record<string, string> | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`chair child not spawned — gig aborted (${abortReasonText(signal)})`));
      return;
    }
    // stdin is a pipe ONLY when a payload is going down it. Leaving it open otherwise would
    // change the child's TTY detection for every existing caller.
    const stdio: ["ignore" | "pipe", "pipe", "pipe"] =
      [stdinPayload === undefined ? "ignore" : "pipe", "pipe", "pipe"];
    const child = spawn(bin, [...args], { stdio, ...(childEnv ? { env: childEnv } : {}) });
    // Slots 1 and 2 are literally "pipe" above, so both streams exist. Only slot 0 varies,
    // and widening it costs the compiler the overload that proved this.
    const childOut = child.stdout!;
    const childErr = child.stderr!;
    if (stdinPayload !== undefined) {
      // Close after writing: the CLI reads the prompt until EOF, so a stdin left open hangs
      // the child forever — a timeout rather than an answer, which is the failure this change
      // exists to remove.
      child.stdin?.on("error", () => { /* EPIPE if the child died first; the exit path reports it */ });
      child.stdin?.end(stdinPayload, "utf8");
    }
    LIVE_CHAIR_CHILDREN.add(child);
    let stdout = "";
    let stderr = "";
    let buf = "";
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const release = (): void => {
      if (timer) clearTimeout(timer);
      LIVE_CHAIR_CHILDREN.delete(child);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) {
      onAbort = () => {
        const reason = abortReasonText(signal);
        terminateChild(child, abortGraceMs);
        release();
        reject(new Error(`chair child aborted: ${reason}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      child.kill(bounds.killSignal);
      release();
      reject(new Error(`chair child timed out after ${bounds.timeout}ms (${bounds.killSignal})`));
    }, bounds.timeout);
    const forwardLine = (line: string): void => {
      if (!line || !onEvent) return;
      try { forwardStreamEvent(JSON.parse(line), onEvent); } catch { /* non-json line */ }
    };
    childOut.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        forwardLine(line);
      }
    });
    childErr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (e) => { release(); reject(e); });
    child.on("close", (code) => {
      // #250/#252 — release() subsumes the old clearTimeout: it also deregisters the child
      // from LIVE_CHAIR_CHILDREN and drops the abort listener. It runs FIRST so a throwing
      // onEvent in the flush below cannot leak the registration or the timer.
      release();
      // #224 — the read loop only drains on "\n", so a final line with no trailing newline
      // was never forwarded. The usage sink (runtime.ts makeUsageSink) reads total_cost_usd
      // ONLY from result events, so that chair's spend silently vanished from GigResult.usage
      // and the per-chair jsonl lost its last event. finalText was unaffected (it re-splits
      // the whole stdout), which is exactly why it was silent: the run succeeded and only
      // the accounting was wrong. Flush before settling, on the failure path too — a chair
      // that failed still spent money.
      const tail = buf.trim();
      buf = "";
      forwardLine(tail);
      // The stdout travels WITH the failure. A non-zero exit used to discard it, which threw away
      // the one thing a budget-stopped chair leaves behind: output_write calls that already passed
      // the engine's write boundary. Whether those are recoverable is a decision for the caller,
      // which knows the seal mode and the result subtype; it cannot make it without the stream.
      if (code !== 0) reject(new ChildExitError(`claude exited ${code}: ${stderr.slice(0, 500)}`, stdout));
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

// The `type` values the CLI's stream-json actually emits (SDKMessage, sdk.d.ts:370). A line
// that merely PARSES as JSON is NOT a stream event — that conflation is #222: the model's own
// answer parses and carries no `type`, which flipped the old `parsedAny` flag and made the
// raw-stdout fallback unreachable for the very payload it existed to rescue.
const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set([
  "assistant",
  "user",
  "result",
  "system",
  "stream_event",
]);

/**
 * What a stream-json stdout actually carried.
 *
 * PROVENANCE for the error fields (#223) — read from `@anthropic-ai/claude-code@2.0.9`
 * (`sdk.d.ts:313-339` for the SDKResultMessage union, plus the bundled emission sites in
 * `cli.js`). NOTE the `claude` on PATH here is the NATIVE binary 2.1.221, a different
 * build whose bundle was not read; re-verify against whichever build is actually spawned.
 *
 *  - `error_max_turns` / `error_during_execution` results carry **no `result` field** and
 *    emit **`is_error: false`**. So `typeof e.result === "string"` never fired, `result`
 *    stayed undefined, and the old `result ?? assistant.join("\n")` fell through to the
 *    model's partial reasoning. `subtype` is the required discriminator — `is_error`
 *    alone catches neither.
 *  - `is_error: true` DOES occur, on `subtype: "success"`, set from `isApiErrorMessage`;
 *    there `result` holds the API error text.
 *  - Print mode sets the exit code as `is_error ? 1 : 0`, so both error subtypes exit **0**
 *    and `spawnStreaming` resolves normally. The silent path is live, not dead risk.
 */
interface StreamOutcome {
  /** The text the extractor should parse. Empty when the stream carried no answer. */
  text: string;
  /** A non-success result subtype — the run did not complete. */
  errorSubtype?: string | undefined;
  /** A result the CLI flagged with is_error (rides on subtype "success"). */
  apiErrorText?: string | undefined;
}

/**
 * Pick the assistant text block that IS the answer.
 *
 * Concatenating every block across the run (the old behaviour) glues intermediate
 * reasoning in front of the answer, and the extractor then has to choose between the
 * reasoning's objects and the real one. Prefer the LAST block that is nothing but a JSON
 * object — that is precisely what buildPrompt asks for ("Respond with ONLY a single JSON
 * object — no prose, no code fence", :153), so such a block is the model complying, while
 * a block with chatter wrapped around an object is commentary. Falls back to the final
 * block when no block is a bare object (then the extractor's own policy decides).
 */
function answerBlock(blocks: readonly string[]): string {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = (blocks[i] ?? "").trim();
    if (b.startsWith("{") && b.endsWith("}")) {
      try {
        const v: unknown = JSON.parse(b);
        if (v && typeof v === "object" && !Array.isArray(v)) return b;
      } catch { /* not a bare object — keep looking */ }
    }
  }
  return blocks.length > 0 ? (blocks[blocks.length - 1] ?? "") : "";
}

/**
 * Read a stream-json stdout into the answer text (plus any error the CLI reported).
 * Falls back to the raw stdout when no recognized stream event appeared at all — the
 * plain `-p` shape the old `parsedAny` check claimed to handle and did not.
 */
function finalText(stdout: string): StreamOutcome {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  let result: string | undefined;
  let errorSubtype: string | undefined;
  let apiErrorText: string | undefined;
  const assistant: string[] = [];
  let sawStreamEvent = false;
  for (const l of lines) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(l) as Record<string, unknown>; } catch { continue; /* non-json */ }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    if (!STREAM_EVENT_TYPES.has(type)) continue;
    sawStreamEvent = true;
    if (type === "result") {
      const subtype = typeof e["subtype"] === "string" ? (e["subtype"] as string) : "";
      if (subtype !== "" && subtype !== "success") { errorSubtype = subtype; continue; }
      if (e["is_error"] === true) {
        apiErrorText = typeof e["result"] === "string" ? (e["result"] as string) : "";
        continue;
      }
      if (typeof e["result"] === "string") result = e["result"] as string;
    } else if (type === "assistant" && e["message"] && typeof e["message"] === "object") {
      const content = (e["message"] as { content?: Array<Record<string, unknown>> }).content ?? [];
      for (const b of content) if (b["type"] === "text") assistant.push(String(b["text"] ?? ""));
    }
  }
  if (errorSubtype !== undefined) return { text: "", errorSubtype };
  if (apiErrorText !== undefined) return { text: "", apiErrorText };
  if (!sawStreamEvent) return { text: stdout };
  // #222 — `""` IS a string, so `result ?? assistant.join("\n")` returned the empty result
  // and beat real assistant text. Nullish coalescing was the bug; emptiness is the test.
  if (result !== undefined && result.trim() !== "") return { text: result };
  return { text: answerBlock(assistant) };
}

/**
 * The provider's own account of why a run stopped, read from the child's STREAM rather than stderr.
 *
 * When the Claude CLI hits the account's usage limit it writes NOTHING to stderr — it emits the
 * notice as a synthetic assistant message (model `<synthetic>`) and/or an is_error result whose
 * `result` field is the notice, then exits non-zero (measured on build gig 13ea0d99: its verify seat
 * failed with `claude exited 1: `, and the session transcript ended on "You've hit your session
 * limit · resets …"). Both carriers are read because the exact fields of the CLI's final event on
 * this path were not captured, so a fix that read only one could miss whichever shape the day's CLI
 * happens to take. Returns "" when the stream carries no such notice, so an ordinary non-zero exit's
 * failure keeps reporting stderr unchanged.
 *
 * Deliberately narrow — a `<synthetic>` assistant, not any assistant text, and an is_error result,
 * not any result — so a budget-stopped TEXT run's partial reasoning is never mistaken for a reason.
 */
function providerNoticeFrom(stdout: string): string {
  const texts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim() !== "") texts.push(v.trim());
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; /* non-json */ }
    const type = typeof e["type"] === "string" ? (e["type"] as string) : "";
    if (type === "result" && e["is_error"] === true) {
      push(e["result"]);
    } else if (type === "assistant" && e["message"] && typeof e["message"] === "object") {
      const msg = e["message"] as { model?: unknown; content?: Array<Record<string, unknown>> };
      if (msg.model === "<synthetic>") {
        for (const b of msg.content ?? []) if (b["type"] === "text") push(b["text"]);
      }
    }
  }
  // Distinct, first-seen order — the limit notice usually rides BOTH carriers, and repeating it
  // would only pad the failure line.
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const t of texts) {
    if (seen.has(t)) continue;
    seen.add(t);
    distinct.push(t);
  }
  return distinct.join(" — ");
}

/** An absolute, symlink-resolved host path (the path as given, made absolute, when it does not exist). */
function realOrResolved(p: string): string {
  const abs = resolvePath(p);
  try { return realpathSync(abs); } catch { return abs; }
}
